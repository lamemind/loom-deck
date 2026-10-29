import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

// T177 — LIVENESS SU WINDOWS: il gemello di `/proc/<pid>/stat` dove `/proc` non
// esiste.
//
// Il registro di Claude Code (`~/.claude/sessions/<pid>.json`) è lo stesso su
// ogni piattaforma, e la guardia anche: una conversazione è viva se il processo
// `pid` esiste ED è ancora quello che ha scritto il file. Cambia solo cosa
// misura l'ora di avvio: su Windows `procStart` è il FILETIME UTC di creazione
// del processo (intervalli di 100 ns dal 1601-01-01), in decimale.
//
// Le due metà della guardia costano in modo molto diverso, e da qui viene la
// forma del modulo:
//
// - L'ESISTENZA si chiede a Node (`process.kill(pid, 0)`), senza sottoprocessi,
//   a ogni giro del poll e per ogni pid.
// - L'ORA DI AVVIO Node non la sa: la chiede `Get-Process` a PowerShell, e un
//   lancio di PowerShell costa quasi un secondo. A ogni giro del poll (1,5 s)
//   sarebbe un processo sempre in piedi. La si chiede quindi UNA volta per
//   coppia pid + `procStart`, in una query sola per tutte le coppie nuove del
//   giro, asincrona: un sottoprocesso sincrono in un hook ferma Ink, e su
//   Windows ogni spawn si paga in centinaia di millisecondi.
//
// Il verdetto di una coppia verificata resta finché il pid esiste. Una coppia
// morta resta morta per sempre: il processo che l'ha scritta è finito, e un pid
// riusato più tardi da un altro programma non la riporta in vita. Il solo caso
// che sfugge è un pid che muore E viene riusato fra due giri del poll: la coppia
// era verificata, il pid continua a esistere, e nessuno la rimisura.

/** Una entry del registro, ridotta a ciò che decide la liveness. */
export interface LivePair {
  pid: number;
  procStart: string;
}

/** Il verdetto su un giro intero del poll: un booleano per coppia, nello stesso
 *  ordine. Prende tutte le coppie insieme perché la piattaforma che le
 *  verifica con un sottoprocesso le verifica con uno solo. */
export type Liveness = (pairs: readonly LivePair[]) => boolean[];

/** I pid → lo stdout della query delle ore di avvio. Iniettabile: i test non
 *  lanciano PowerShell, e girano anche su Linux. */
export type StartTimeQuery = (pids: readonly number[]) => Promise<string>;

/** Una query fallita non si ripete prima di così. Senza il ritardo, un
 *  PowerShell bloccato da una policy si rilancerebbe a ogni giro del poll. */
export const RETRY_MS = 60_000;

/** Oltre questo la query si abbandona e vale come fallita: una query appesa
 *  non deve tenere ferme per sempre le verifiche dei giri dopo. */
export const QUERY_TIMEOUT_MS = 15_000;

/** La riga che chiude uno stdout completo. Senza, lo stdout non dice niente:
 *  un PowerShell partito ma interrotto stamperebbe una lista vuota, e una
 *  lista vuota vuol dire «nessun processo vivo». */
const DONE = 'OK';

/**
 * Lo script della query, per pid già validati (interi dal nome del file).
 *
 * Una riga `<pid> <FILETIME>` per ogni processo di cui l'ora di avvio è
 * leggibile, poi `OK`. Un pid assente dall'output è morto, oppure appartiene a
 * un altro utente (servizi, sessione 0): `StartTime` di quei processi non si
 * legge da una sessione non elevata, e nessuno di loro è una conversazione
 * dell'utente.
 *
 * Il confronto si fa in FILETIME e non su una data: `ToFileTimeUtc()` restituisce
 * lo stesso numero che il CLI scrive in `procStart`, al tick, mentre
 * `CreationDate` di `Win32_Process` si ferma al microsecondo e perderebbe
 * l'ultima cifra. Lo script non contiene virgolette doppie, così passa intero
 * come un argomento solo nella riga di comando di Windows.
 */
export function startTimeScript(pids: readonly number[]): string {
  return (
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { if ($_.StartTime) { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } }; ` +
    `'${DONE}'`
  );
}

/** Lo stdout della query → `pid → FILETIME`, o `null` se manca la riga di
 *  chiusura: uno stdout tronco non vale come «tutti morti». */
export function parseStartTimes(stdout: string): Map<number, string> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[lines.length - 1] !== DONE) return null;
  const out = new Map<number, string>();
  for (const line of lines.slice(0, -1)) {
    const m = /^(\d+) (\d+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!);
  }
  return out;
}

/** PowerShell per path assoluto, non dal `PATH`: un `powershell.exe` messo
 *  prima nel `PATH` (la `.bin` di un progetto, per esempio) non deve poter
 *  rispondere al posto suo. */
function powershellPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const execFileAsync = promisify(execFile);

/** La query vera: un PowerShell per tutti i pid. */
export const queryStartTimes: StartTimeQuery = async (pids) => {
  const { stdout } = await execFileAsync(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', startTimeScript(pids)],
    { windowsHide: true, timeout: QUERY_TIMEOUT_MS },
  );
  return stdout;
};

/**
 * Il processo `pid` esiste. `EPERM` vale come esiste: è la risposta di Windows
 * quando il processo c'è ma non si apre con i diritti che Node chiede, e
 * decidere se è la conversazione spetta all'ora di avvio, non a questo.
 */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WindowsLiveness {
  check: Liveness;
  /** Si risolve quando la query in corso finisce. Per i test. */
  settled(): Promise<void>;
}

const pairKey = (p: LivePair): string => `${p.pid}:${p.procStart}`;

/**
 * Il verificatore: un'istanza per processo del deck, perché i verdetti valgono
 * da un giro del poll all'altro.
 *
 * Una coppia mai verificata vale VIVA finché il pid esiste, fino all'esito
 * della query. Su Windows la query costa quasi un secondo, quindi la coppia
 * provvisoria c'è a ogni avvio del deck e a ogni conversazione nuova. Le due
 * direzioni d'errore non costano uguale: una morta creduta viva per un secondo
 * è un `CANC` rifiutato o una marca `live` che la convergenza ritira, una viva
 * creduta morta è un `CANC` che toglie il transcript a una conversazione
 * aperta, o un restore che la riapre in una seconda tab. Lo stesso vale quando
 * la query fallisce: la liveness scende alla sola esistenza del pid, e si
 * riprova dopo `RETRY_MS`.
 *
 * `check` riceve TUTTE le coppie del giro e dimentica le altre: un verdetto non
 * sopravvive al file di registro da cui veniva.
 */
export function createWindowsLiveness(
  opts: {
    query?: StartTimeQuery;
    exists?: (pid: number) => boolean;
    now?: () => number;
  } = {},
): WindowsLiveness {
  const query = opts.query ?? queryStartTimes;
  const exists = opts.exists ?? pidExists;
  const now = opts.now ?? Date.now;
  let verdicts = new Map<string, boolean>();
  let inFlight: Promise<void> | null = null;
  let retryAt = 0;

  async function verify(pairs: readonly LivePair[]): Promise<void> {
    try {
      const starts = parseStartTimes(await query(pairs.map((p) => p.pid)));
      if (!starts) throw new Error('query delle ore di avvio incompleta');
      for (const p of pairs) {
        // Una coppia già decisa nel frattempo (il pid è sparito mentre la query
        // girava) ha un verdetto più recente di questo.
        if (!verdicts.has(pairKey(p))) verdicts.set(pairKey(p), starts.get(p.pid) === p.procStart);
      }
    } catch {
      retryAt = now() + RETRY_MS;
    } finally {
      inFlight = null;
    }
  }

  const check: Liveness = (pairs) => {
    const next = new Map<string, boolean>();
    const unknown: LivePair[] = [];
    const alive = pairs.map((p) => {
      const key = pairKey(p);
      let verdict = verdicts.get(key);
      if (verdict !== false && !exists(p.pid)) verdict = false;
      if (verdict === undefined) {
        unknown.push(p);
        return true; // provvisoria, fino all'esito della query
      }
      next.set(key, verdict);
      return verdict;
    });
    verdicts = next;
    if (unknown.length > 0 && !inFlight && now() >= retryAt) inFlight = verify(unknown);
    return alive;
  };

  return { check, settled: () => inFlight ?? Promise.resolve() };
}
