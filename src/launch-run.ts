// T168 — l'ESECUZIONE CON ESITO di una voce launch: il file di esito su disco,
// lo spawn col wrapper che scrive l'exit code, la guardia di concorrenza, la
// scadenza.
//
// Lettore puro + spawn, nessun React: provabile senza pseudo-terminale, come
// `gitlink.ts`. Lo strato React (`overlays/launch.ts`) decide
// QUANDO lanciare e cosa mostrare; qui c'è solo COME, e cosa resta su disco.
//
// ── Il file di esito (P7/P8 preflight) ─────────────────────────────────────
// Per voce, in `.claude/loom/launch/` — la sede macchina-locale per progetto
// che tiene già `session-tasks.jsonl` e `deck-view.json`, non il tmpdir:
// l'ora dell'ultimo giro deve sopravvivere al riavvio, o un deck riaperto non sa
// se la scadenza è passata.
//
//   <slug>.json         pid, ora d'inizio, exit e ora di fine dell'ultimo giro,
//                       più l'ultimo giro vero quando quello è senza esito (T190)
//   <slug>.log          stdout e stderr dell'ultimo giro lanciato, riscritto a
//                       ogni lancio
//   <slug>.outcome.log  solo con `noOutcome`: l'output del giro che il record
//                       porta in `lastOutcome` (T258, `outcomeLogStep`)
//   <slug>.exit         l'exit code, scritto dal FIGLIO a fine corsa
//
// L'exit lo scrive il figlio e non il deck (P8): con stdout su un fd aperto dal
// padre il figlio sopravvive alla chiusura del deck (misurato nel DLV1), ma
// l'evento `exit` lo riceve solo un padre vivo. Il wrapper `bash -c` lancia il
// comando dentro `bash -lic` — la stessa shell di ogni voce (P5), così un alias
// risolve uguale con o senza esito — e scrive `$?` nel file `.exit`. Il deck,
// quando lo trova, lo fonde nel JSON e lo toglie (`settleLaunchRecord`): il
// record resta UNO, e il file di transito vive solo fra la fine del figlio e la
// prima lettura.
//
// ── La guardia (P4) ────────────────────────────────────────────────────────
// Una voce non riparte mentre una sua corsa è registrata senza exit e con pid
// vivo. Il pid si verifica come fa `live-sessions.ts`, col campo `starttime` di
// `/proc/<pid>/stat` salvato al lancio: un pid riciclato da un altro programma
// non deve tenere «in corso» un giro finito male. La guardia legge il disco e
// non la memoria, quindi vale anche fra due deck aperti sullo stesso progetto.
//
// ── La scadenza (P24) ──────────────────────────────────────────────────────
// `every` si misura dall'ultimo giro registrato, non dall'avvio del deck: un
// timer di Node conta sull'orologio monotono, fermo durante la sospensione, e
// «ogni giorno dall'avvio» su un deck sospeso dieci ore al giorno scatterebbe
// ogni 34 ore di parete. Qui si confronta l'ora di parete con quella scritta.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NO_SPAWN, spawnOut } from './spawn.js';
import { procStartOf } from './live-sessions.js';
import type { LaunchEntry } from './config.js';

/** La cartella dei file di esito, relativa alla project root. */
export const LAUNCH_STATE_DIR = join('.claude', 'loom', 'launch');

export function launchStateDir(projectRoot: string): string {
  return join(projectRoot, LAUNCH_STATE_DIR);
}

export function launchRecordPath(projectRoot: string, slug: string): string {
  return join(launchStateDir(projectRoot), `${slug}.json`);
}

export function launchLogPath(projectRoot: string, slug: string): string {
  return join(launchStateDir(projectRoot), `${slug}.log`);
}

export function launchOutcomeLogPath(projectRoot: string, slug: string): string {
  return join(launchStateDir(projectRoot), `${slug}.outcome.log`);
}

export function launchExitPath(projectRoot: string, slug: string): string {
  return join(launchStateDir(projectRoot), `${slug}.exit`);
}

/** Uno dei due log di una voce: `last` è l'ultimo giro lanciato, `outcome`
 *  l'ultimo giro vero di una voce con `noOutcome` (T258). */
export type LaunchLogFile = 'last' | 'outcome';

function logPathOf(projectRoot: string, slug: string, file: LaunchLogFile): string {
  return file === 'outcome' ? launchOutcomeLogPath(projectRoot, slug) : launchLogPath(projectRoot, slug);
}

/** Da dove è partito il giro: decide la notifica (P14) e la nota a schermo. */
export type LaunchOrigin = 'tasto' | 'startup' | 'every';

/** Un giro finito con un esito: ciò che resta dell'ultimo giro vero. */
export interface LaunchRun {
  startedAt: number;
  endedAt: number;
  exit: number;
}

export interface LaunchRecord {
  /** Il pid del wrapper; `null` quando lo spawn è inerte (test). */
  pid: number | null;
  /** Campo 22 di `/proc/<pid>/stat` al lancio, contro i pid riciclati; `null`
   *  fuori da Linux, dove la guardia si accontenta dell'esistenza del pid. */
  procStart: string | null;
  startedAt: number;
  endedAt: number | null;
  exit: number | null;
  origin: LaunchOrigin;
  /**
   * T190 — l'ultimo giro VERO prima di questo, portato avanti da `runCaptured`
   * a ogni lancio. Il record riscritto al lancio cancellerebbe l'esito del giro
   * prima; se questo giro esce con un codice `noOutcome`, testata, scadenza e
   * pagina devono ancora sapere com'era finito l'ultimo che ha misurato
   * qualcosa. Si consulta solo per un giro senza esito (`lastTrueRecord`):
   * una voce senza `noOutcome` lo scrive e non lo legge mai.
   */
  lastOutcome: LaunchRun | null;
}

/**
 * Il wrapper: il comando dentro la stessa shell di ogni voce, poi l'exit nel
 * file. `"$1"` e `"$2"` arrivano come argomenti di `bash -c`, mai interpolati
 * nella stringa: un comando con apici o `$` resta la stringa del file.
 */
export const LAUNCH_WRAPPER = 'bash -lic "$1"; printf \'%s\\n\' "$?" > "$2"';

function isRecord(v: unknown): v is LaunchRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    (r.pid === null || typeof r.pid === 'number') &&
    typeof r.startedAt === 'number' &&
    (r.endedAt === null || typeof r.endedAt === 'number') &&
    (r.exit === null || typeof r.exit === 'number')
  );
}

/** `lastOutcome` come sta su disco; assente o fuori forma → `null`, come un
 *  record scritto da un deck che non lo conosceva. */
function readRun(v: unknown): LaunchRun | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.startedAt !== 'number' || typeof r.endedAt !== 'number' || typeof r.exit !== 'number') return null;
  return { startedAt: r.startedAt, endedAt: r.endedAt, exit: r.exit };
}

/** File assente o illeggibile → `null`: la voce non ha mai girato, che è uno
 *  stato e non un errore. */
export function readLaunchRecord(projectRoot: string, slug: string): LaunchRecord | null {
  try {
    const raw = JSON.parse(readFileSync(launchRecordPath(projectRoot, slug), 'utf8')) as unknown;
    if (!isRecord(raw)) return null;
    return {
      pid: raw.pid,
      procStart: typeof raw.procStart === 'string' ? raw.procStart : null,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      exit: raw.exit,
      origin: raw.origin === 'startup' || raw.origin === 'every' ? raw.origin : 'tasto',
      lastOutcome: readRun((raw as { lastOutcome?: unknown }).lastOutcome),
    };
  } catch {
    return null;
  }
}

export function writeLaunchRecord(projectRoot: string, slug: string, rec: LaunchRecord): void {
  mkdirSync(launchStateDir(projectRoot), { recursive: true });
  writeFileSync(launchRecordPath(projectRoot, slug), JSON.stringify(rec) + '\n', 'utf8');
}

/**
 * Il record con l'exit del figlio FUSO dentro, se il figlio ha finito.
 *
 * Il file `.exit` appartiene sempre al record corrente: `runCaptured` lo toglie
 * prima di ogni lancio, quindi uno trovato qui è del giro registrato, anche se
 * il deck che l'ha lanciato non c'è più. L'ora di fine è la mtime del file —
 * mai un campo scritto dal figlio, che non ha un orologio in comune col deck.
 */
export function settleLaunchRecord(projectRoot: string, slug: string): LaunchRecord | null {
  const rec = readLaunchRecord(projectRoot, slug);
  if (!rec) return null;
  if (rec.exit !== null) return rec;
  const exitFile = launchExitPath(projectRoot, slug);
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(exitFile, 'utf8');
    mtime = statSync(exitFile).mtimeMs;
  } catch {
    return rec;
  }
  const code = Number.parseInt(text.trim(), 10);
  const settled: LaunchRecord = {
    ...rec,
    exit: Number.isFinite(code) ? code : 1,
    endedAt: Math.max(mtime, rec.startedAt),
  };
  try {
    writeLaunchRecord(projectRoot, slug, settled);
    unlinkSync(exitFile);
  } catch {
    // Il disco non si lascia scrivere: il record resta in transito e si
    // ritenterà al giro dopo. L'esito è comunque quello letto.
  }
  return settled;
}

/** Il campo `starttime` del processo appena nato, per la guardia; `null` dove
 *  `/proc` non c'è. */
export function readProcStart(pid: number): string | null {
  try {
    return procStartOf(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Il pid è ANCORA il processo registrato. Con `procStart` il confronto è sul
 * campo 22 di `/proc/<pid>/stat`, irripetibile per un pid riciclato; senza
 * (`/proc` assente), resta `kill(pid, 0)`, che dice solo che un processo con
 * quel numero esiste.
 */
export function pidAlive(pid: number, procStart: string | null): boolean {
  if (procStart !== null) return readProcStart(pid) === procStart;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** La corsa registrata è ancora in piedi: nessun exit, e il wrapper vive. */
export function launchRunning(rec: LaunchRecord | null): boolean {
  if (!rec || rec.exit !== null || rec.pid === null) return false;
  return pidAlive(rec.pid, rec.procStart);
}

/**
 * La scadenza è passata (P24): nessun giro registrato, oppure l'ultimo è
 * finito da almeno `intervalMs`. Una corsa in piedi non è mai dovuta.
 *
 * Un record senza exit e con pid morto (il deck è stato chiuso e il figlio è
 * finito senza che nessuno abbia fuso il `.exit`, o il figlio è stato ucciso)
 * conta dall'ora d'inizio: è l'unica che si conosce.
 */
export function launchDue(rec: LaunchRecord | null, intervalMs: number, now: number): boolean {
  if (!rec) return true;
  if (launchRunning(rec)) return false;
  const last = rec.endedAt ?? rec.startedAt;
  return now - last >= intervalMs;
}

// ── I giri senza esito (T190) ──────────────────────────────────────────────
// Un exit code elencato in `noOutcome` dice che il giro non ha fatto il suo
// lavoro — il caso tipico è un comando col suo lock, che esce subito perché un
// altro giro è in corso. Il deck lo tratta come non avvenuto: testata,
// scadenza e notifica guardano l'ultimo giro VERO, e il tentativo si vede solo
// nella pagina `^L`. Una voce senza `noOutcome` non passa mai di qui: il
// record che guarda è quello di sempre.

/** L'exit è uno di quelli che la voce dichiara «nessun esito». */
export function isNoOutcome(exit: number | null, noOutcome: readonly number[] | null | undefined): boolean {
  return exit !== null && Boolean(noOutcome?.includes(exit));
}

/**
 * Il record su cui si misurano scadenza, glifo e notifica: quello su disco,
 * tranne quando il suo giro è finito con un codice senza esito — allora è
 * l'ultimo giro vero (`lastOutcome`), o `null` se un giro vero non c'è mai
 * stato, che per la scadenza vuol dire «dovuta».
 *
 * Una corsa in piedi e un esito perso restano il record di sempre: il primo è
 * ciò che 🔄 e la guardia devono vedere, il secondo non dice con che codice è
 * finito, quindi non lo si sa scartare.
 */
export function lastTrueRecord(
  rec: LaunchRecord | null,
  noOutcome: readonly number[] | null | undefined,
): LaunchRecord | null {
  if (!rec || !isNoOutcome(rec.exit, noOutcome)) return rec;
  const last = rec.lastOutcome;
  if (!last) return null;
  return { pid: null, procStart: null, ...last, origin: rec.origin, lastOutcome: null };
}

/** L'ultimo giro vero da portare nel record di un lancio nuovo. Un record
 *  ancora aperto (esito perso) non lo è: si porta avanti il suo. */
function carriedOutcome(prev: LaunchRecord | null, noOutcome: readonly number[] | null | undefined): LaunchRun | null {
  const truth = lastTrueRecord(prev, noOutcome);
  if (!truth) return null;
  if (truth.exit === null) return truth.lastOutcome;
  return { startedAt: truth.startedAt, endedAt: truth.endedAt ?? truth.startedAt, exit: truth.exit };
}

// ── Il log dell'ultimo giro vero (T258) ────────────────────────────────────
// Al lancio il deck non sa come finirà il giro, e `<slug>.log` si tronca per
// accogliere il suo output: il log dell'ultimo giro vero va messo da parte
// PRIMA, con la stessa regola con cui il record porta avanti `lastOutcome`
// (`carriedOutcome`), e nello stesso punto. Così `<slug>.outcome.log` contiene
// sempre l'output del giro che il record nuovo porta in `lastOutcome`, e i log
// restano due qualunque sia il numero di tentativi di fila.

/**
 * Cosa fare di `<slug>.outcome.log` al lancio, guardando il record che sta per
 * essere sostituito:
 *
 * - `promote` — il record è un giro vero: il suo output è `<slug>.log`, che
 *   diventa `<slug>.outcome.log` prima del troncamento;
 * - `keep` — il record è un tentativo senza esito o un esito perso, e porta
 *   avanti un giro vero di prima: il file che lo descrive resta com'è;
 * - `drop` — la voce non ha `noOutcome`, o nessun giro vero resta da
 *   descrivere: un file rimasto non descriverebbe il giro di `lastOutcome`, e
 *   comparirebbe sotto l'esito sbagliato se `noOutcome` tornasse nella voce.
 */
export type OutcomeLogStep = 'promote' | 'keep' | 'drop';

export function outcomeLogStep(
  prev: LaunchRecord | null,
  noOutcome: readonly number[] | null | undefined,
): OutcomeLogStep {
  if (!noOutcome?.length || !prev) return 'drop';
  if (prev.exit !== null && !isNoOutcome(prev.exit, noOutcome)) return 'promote';
  return prev.lastOutcome ? 'keep' : 'drop';
}

function applyOutcomeLogStep(cwd: string, slug: string, step: OutcomeLogStep): void {
  if (step === 'keep') return;
  const outcomeLog = launchOutcomeLogPath(cwd, slug);
  const lastLog = launchLogPath(cwd, slug);
  // Un giro vero senza log su disco (cancellato a mano) non lascia niente da
  // promuovere: il file vecchio descriverebbe un giro di prima.
  if (step === 'promote' && existsSync(lastLog)) renameSync(lastLog, outcomeLog);
  else rmSync(outcomeLog, { force: true });
}

/**
 * Quale log apre `l` nella pagina `^L` (T258): quello del giro che la riga
 * mostra come esito.
 *
 * Su un tentativo senza esito la riga mostra l'ultimo giro vero, quindi `l`
 * apre `<slug>.outcome.log`, e `tab` passa al tentativo (`alternate`). Quando
 * il log del giro vero non è su disco — nessun giro vero finora, o un record
 * scritto da un deck che non lo conservava — `l` apre il tentativo, e la
 * schermata lo dichiara come tale: il testo di un tentativo non compare mai
 * sotto l'esito di un giro vero. Ogni altro record (in corso, esito perso,
 * giro vero) è l'ultimo giro lanciato, `<slug>.log`.
 */
export interface LaunchLogPick {
  file: LaunchLogFile;
  /** Il log del tentativo sta su disco accanto a quello del giro vero. */
  alternate: boolean;
}

export function pickLaunchLog(
  rec: LaunchRecord | null,
  noOutcome: readonly number[] | null | undefined,
  outcomeLogOnDisk: boolean,
): LaunchLogPick {
  if (rec && isNoOutcome(rec.exit, noOutcome) && rec.lastOutcome && outcomeLogOnDisk) {
    return { file: 'outcome', alternate: true };
  }
  return { file: 'last', alternate: false };
}

/**
 * Il giro finito merita la notifica desktop. A tasto sempre (P14): l'ha
 * chiesto l'utente, che aspetta di sapere com'è andata. Da startup e da
 * scadenza solo quando l'exit è DIVERSO da quello dell'ultimo giro vero (T190
 * P6): 0→1, 1→2, 2→0 notificano, 1→1 no. Il deck non sa cosa vogliono dire i
 * codici di un comando — per uno 1 è «degrada» e 2 «rotto» —, quindi ogni
 * cambio di codice è una notizia, non solo il passaggio fra verde e rosso. Al
 * primo giro di sempre (`prev` nullo) vale come cambio il solo rosso: un verde
 * dal nulla non è una notizia.
 *
 * Un giro senza esito non arriva qui: chi chiama lo scarta prima.
 */
export function launchNotifies(prev: number | null, exit: number, origin: LaunchOrigin): boolean {
  if (origin === 'tasto') return true;
  return prev === null ? exit !== 0 : prev !== exit;
}

/** Ciò che la testata mostra (P23): 🚨 vince su 🔄, e il verde non compare. */
export interface LaunchIndicator {
  kind: 'running' | 'red';
  label: string;
  count: number;
}

/**
 * Il glifo di testata delle voci con esito. Una voce in corso conta come 🔄;
 * le altre contano come 🚨 quando il loro ultimo giro VERO è rosso — un giro
 * senza esito dopo un rosso lascia 🚨 acceso, dopo un verde lascia la testata
 * vuota (T190).
 */
export function launchIndicatorOf(
  entries: readonly LaunchEntry[],
  records: ReadonlyMap<string, LaunchRecord | null>,
): LaunchIndicator | null {
  const running: LaunchEntry[] = [];
  const red: LaunchEntry[] = [];
  for (const e of entries) {
    if (!e.capture || !e.slug || e.enabled === false) continue;
    const r = records.get(e.slug) ?? null;
    if (launchRunning(r)) {
      running.push(e);
      continue;
    }
    const truth = lastTrueRecord(r, e.noOutcome);
    if (truth && truth.exit !== null && truth.exit !== 0) red.push(e);
  }
  if (red.length > 0) return { kind: 'red', label: red[0]!.label, count: red.length };
  if (running.length > 0) return { kind: 'running', label: running[0]!.label, count: running.length };
  return null;
}

/**
 * Lancia la voce con l'esito su disco, e restituisce il figlio (il wrapper) e
 * il record appena scritto.
 *
 * Il log è un fd aperto dal padre e passato come stdout e stderr: è ciò che fa
 * arrivare in fondo il figlio anche a deck chiuso (una pipe lo ucciderebbe alla
 * prima scrittura, misurato nel DLV1). Il padre lo chiude subito dopo lo spawn:
 * il figlio ne ha la sua copia.
 *
 * Il record nuovo porta con sé l'ultimo giro vero (`lastOutcome`), letto dal
 * record che sta per sostituire: chi lancia lo ha già fuso col suo `.exit`
 * (`settleLaunchRecord` davanti alla guardia), quindi qui basta leggerlo. Lo
 * stesso record decide, prima che il log si tronchi, cosa resta del log
 * dell'ultimo giro vero (`outcomeLogStep`).
 *
 * Con `LOOM_DECK_NO_SPAWN` niente si scrive sul disco: i gate pty girano sul
 * progetto vero, e un record scritto lì marcherebbe «in corso» una voce che non
 * è mai partita.
 */
export function runCaptured(
  entry: LaunchEntry,
  cwd: string,
  origin: LaunchOrigin,
  now: number = Date.now(),
): { child: ChildProcess; record: LaunchRecord } {
  const slug = entry.slug ?? 'voce';
  const prev = readLaunchRecord(cwd, slug);
  const record: LaunchRecord = {
    pid: null,
    procStart: null,
    startedAt: now,
    endedAt: null,
    exit: null,
    origin,
    lastOutcome: carriedOutcome(prev, entry.noOutcome),
  };
  if (NO_SPAWN) {
    const fake = new EventEmitter() as ChildProcess;
    fake.unref = () => fake;
    return { child: fake, record };
  }
  mkdirSync(launchStateDir(cwd), { recursive: true });
  const exitFile = launchExitPath(cwd, slug);
  if (existsSync(exitFile)) unlinkSync(exitFile);
  applyOutcomeLogStep(cwd, slug, outcomeLogStep(prev, entry.noOutcome));
  const fd = openSync(launchLogPath(cwd, slug), 'w');
  let child: ChildProcess;
  try {
    child = spawnOut('bash', ['-c', LAUNCH_WRAPPER, 'loom-launch', entry.command, exitFile], {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  record.pid = child.pid ?? null;
  record.procStart = record.pid !== null ? readProcStart(record.pid) : null;
  writeLaunchRecord(cwd, slug, record);
  return { child, record };
}

/** La coda di uno dei due log, al più `maxBytes` dalla fine; `null` se non c'è. */
export function readLaunchLog(
  projectRoot: string,
  slug: string,
  file: LaunchLogFile = 'last',
  maxBytes = 256 * 1024,
): string | null {
  try {
    const text = readFileSync(logPathOf(projectRoot, slug, file), 'utf8');
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
  } catch {
    return null;
  }
}
