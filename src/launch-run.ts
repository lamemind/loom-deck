// T168 — l'ESECUZIONE CON ESITO di una voce launch: il file di esito su disco,
// lo spawn col wrapper che scrive l'exit code, la guardia di concorrenza, la
// scadenza.
//
// Lettore puro + spawn, nessun React: provabile senza pseudo-terminale, come
// `gitlink.ts` e `wrap-scan.ts`. Lo strato React (`overlays/launch.ts`) decide
// QUANDO lanciare e cosa mostrare; qui c'è solo COME, e cosa resta su disco.
//
// ── Il file di esito (P7/P8 preflight) ─────────────────────────────────────
// Per voce, in `.claude/loom/launch/` — la sede macchina-locale per progetto
// che tiene già `session-tasks.jsonl` e `deck-view.json`, non il tmpdir del
// project status: l'ora dell'ultimo giro deve sopravvivere al riavvio, o un
// deck riaperto non sa se la scadenza è passata.
//
//   <slug>.json  pid, ora d'inizio, exit e ora di fine dell'ultimo giro
//   <slug>.log   stdout e stderr del giro, riscritto a ogni lancio
//   <slug>.exit  l'exit code, scritto dal FIGLIO a fine corsa
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

export function launchExitPath(projectRoot: string, slug: string): string {
  return join(launchStateDir(projectRoot), `${slug}.exit`);
}

/** Da dove è partito il giro: decide la notifica (P14) e la nota a schermo. */
export type LaunchOrigin = 'tasto' | 'startup' | 'every';

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

/**
 * Lancia la voce con l'esito su disco, e restituisce il figlio (il wrapper) e
 * il record appena scritto.
 *
 * Il log è un fd aperto dal padre e passato come stdout e stderr: è ciò che fa
 * arrivare in fondo il figlio anche a deck chiuso (una pipe lo ucciderebbe alla
 * prima scrittura, misurato nel DLV1). Il padre lo chiude subito dopo lo spawn:
 * il figlio ne ha la sua copia.
 *
 * Con `LOOM_DECK_NO_SPAWN` niente tocca il disco: i gate pty girano sul
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
  const record: LaunchRecord = { pid: null, procStart: null, startedAt: now, endedAt: null, exit: null, origin };
  if (NO_SPAWN) {
    const fake = new EventEmitter() as ChildProcess;
    fake.unref = () => fake;
    return { child: fake, record };
  }
  mkdirSync(launchStateDir(cwd), { recursive: true });
  const exitFile = launchExitPath(cwd, slug);
  if (existsSync(exitFile)) unlinkSync(exitFile);
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

/** La coda del log, al più `maxBytes` dalla fine; `null` se non c'è. */
export function readLaunchLog(projectRoot: string, slug: string, maxBytes = 256 * 1024): string | null {
  try {
    const text = readFileSync(launchLogPath(projectRoot, slug), 'utf8');
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
  } catch {
    return null;
  }
}
