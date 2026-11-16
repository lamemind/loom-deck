// T204 — il MARCATORE di una chiusura chiesta, su Windows: il canale fra il deck
// che termina una conversazione e il wrapper della sua tab (`tab-wrapper.ts`).
//
// Su Windows `process.kill(pid)` termina `claude` di forza, e il processo esce
// con un codice ≠ 0. Il wrapper esce col codice del figlio, e Windows Terminal
// lascia aperta la tab di un programma uscito male (`closeOnExit: graceful` nel
// profilo `loom-deck`): proprio ciò che serve davanti a un crash, con l'errore a
// schermo (D3 di T176), e ciò che non serve davanti a una chiusura chiesta. Il
// deck, prima di terminare, scrive un file nella temporanea; il wrapper, quando
// il figlio esce, lo cerca, lo cancella, ed esce 0: la tab si chiude (P5
// preflight).
//
// Due nomi per la stessa chiusura, il pid e il `sessionId`: il wrapper conosce il
// pid del figlio che ha lanciato e il `sessionId` dal proprio argv, il deck li
// legge entrambi dal registro. Se il pid del registro è quello del figlio
// diretto del wrapper basta il primo; se fra i due c'è un lanciatore intermedio
// basta il secondo. Il wrapper li consuma entrambi.
//
// Un marcatore vale per poco: uno rimasto su disco — un wrapper di una versione
// che non lo legge, un deck caduto fra la scrittura e la terminazione — non deve
// far chiudere in silenzio, giorni dopo, la tab di un crash vero di un processo
// che ha ripreso lo stesso pid. Oltre `CLOSE_MARKER_TTL_MS` il wrapper lo
// cancella e lo ignora.
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Quanto vale un marcatore dalla sua scrittura. Il deck termina subito dopo
 *  averlo scritto, e il wrapper lo legge all'uscita del figlio: il margine copre
 *  una macchina carica, non un'attesa. */
export const CLOSE_MARKER_TTL_MS = 60_000;

const PREFIX = 'loom-deck-close-';

/** I path dei marcatori di una chiusura: per pid e, se c'è, per `sessionId`. */
export function closeMarkerPaths(pid: number | null, sessionId: string | null, dir: string = tmpdir()): string[] {
  const out: string[] = [];
  if (pid !== null && Number.isInteger(pid) && pid > 0) out.push(join(dir, `${PREFIX}${pid}`));
  if (sessionId && /^[0-9a-f-]{8,36}$/.test(sessionId)) out.push(join(dir, `${PREFIX}${sessionId}`));
  return out;
}

/** Il deck: scrive i marcatori prima di terminare. Lancia se non riesce: senza
 *  marcatore la tab resterebbe aperta su un codice d'errore, e il deck non
 *  termina. */
export function writeCloseMarkers(pid: number, sessionId: string, dir: string = tmpdir()): string[] {
  const paths = closeMarkerPaths(pid, sessionId, dir);
  for (const p of paths) writeFileSync(p, sessionId);
  return paths;
}

/** Il deck: toglie i marcatori di una terminazione non partita. */
export function removeCloseMarkers(paths: readonly string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // già consumato o mai scritto
    }
  }
}

/** Il `sessionId` nell'argv di `claude`: `--session-id <id>`, altrimenti
 *  `--resume <id>` (staccati o con `=`). `--session-id` vince perché in un fork
 *  i due convivono, e il `sessionId` della conversazione è quello nuovo. `null`
 *  se l'argv non ne porta uno. */
export function sessionIdInArgv(argv: readonly string[]): string | null {
  return flagValue(argv, ['--session-id']) ?? flagValue(argv, ['--resume', '-r']);
}

function flagValue(argv: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (names.includes(a)) return argv[i + 1] ?? null;
    for (const n of names) if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
  }
  return null;
}

/**
 * Il wrapper, all'uscita del figlio: c'è una chiusura chiesta per lui? I
 * marcatori trovati si cancellano tutti, freschi o scaduti, e la risposta è sì
 * solo se almeno uno è fresco.
 */
export function consumeCloseMarker(
  pid: number | null,
  argv: readonly string[],
  dir: string = tmpdir(),
  now: number = Date.now(),
): boolean {
  let fresh = false;
  for (const p of closeMarkerPaths(pid, sessionIdInArgv(argv), dir)) {
    if (!existsSync(p)) continue;
    try {
      if (now - statSync(p).mtimeMs <= CLOSE_MARKER_TTL_MS) fresh = true;
      unlinkSync(p);
    } catch {
      // sparito fra il controllo e la lettura: lo ha consumato qualcun altro
    }
  }
  return fresh;
}
