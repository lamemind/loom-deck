// T205 — l'I/O vero di un turno headless: il lancio staccato, la liveness del
// processo, il registro dei vivi. Il test usa un `HeadlessIo` proprio; questo
// file lo usa solo l'ingresso `loom-deck-headless.ts`.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { claudeLauncher } from './claude-cmd.js';
import type { HeadlessIo, LaunchOptions } from './headless.js';
import { procRunning, procStartOf, sessionProcesses } from './live-sessions.js';

/**
 * Il processo del turno, STACCATO: sessione propria (`detached`, `setsid` su
 * Linux), stdin chiuso, stdout e stderr sui due file, nessun riferimento che
 * tenga vivo chi lancia (`unref`).
 *
 * Staccato perché il turno deve sopravvivere a chi lo lancia (misura 6 della
 * sonda): la regia che chiude la propria tab manda SIGHUP alla sessione del suo
 * terminale, e un processo in un'altra sessione non lo riceve. Lo stdin chiuso
 * evita i tre secondi che `claude -p` aspetta un input mai arrivato (misura
 * 12). I file si aprono qui e si chiudono subito dopo lo spawn: il figlio ha
 * già le sue copie dei descrittori.
 *
 * L'esito arriva dall'evento `spawn` (partito) o `error` (`ENOENT` per un
 * `claude` assente), e non prima: il pid di un processo che non è partito non
 * va scritto nello stato.
 */
export function launchDetached(
  cmd: string,
  args: string[],
  opts: LaunchOptions,
): Promise<{ pid: number } | { error: string }> {
  let out: number;
  let err: number;
  try {
    mkdirSync(dirname(opts.outFile), { recursive: true });
    out = openSync(opts.outFile, 'w');
    err = openSync(opts.errFile, 'w');
  } catch (e) {
    return Promise.resolve({ error: `file d'esito non scrivibile (${(e as NodeJS.ErrnoException).code ?? String(e)})` });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['ignore', out, err],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ error: `${cmd} non lanciabile (${(e as NodeJS.ErrnoException).code ?? String(e)})` });
      return;
    } finally {
      closeSync(out);
      closeSync(err);
    }
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid! });
    });
    child.once('error', (e: NodeJS.ErrnoException) => resolve({ error: `${cmd} non lanciabile (${e.code ?? String(e)})` }));
  });
}

/** L'ora di avvio dal campo 22 di `/proc/<pid>/stat`; `''` dove `/proc` non
 *  c'è (Windows) o il processo è già finito. */
function readProcStart(pid: number): string {
  try {
    return procStartOf(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? '';
  } catch {
    return '';
  }
}

/** Il segnale 0 non tocca il processo: dice solo se il pid esiste. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Il turno è ancora in corso? Su Linux col confronto dell'ora di avvio, che
 * esclude un pid riciclato e un processo zombie (`procRunning`). Dove l'ora di
 * avvio non si legge, la sola esistenza del pid: un pid riciclato nei minuti di
 * un turno è improbabile, e l'errore che produrrebbe è un «in corso» di troppo,
 * non un esito falso.
 */
function turnRunning(pid: number, procStart: string): boolean {
  if (procStart) return procRunning(pid, procStart);
  return pidExists(pid);
}

export function realHeadlessIo(): HeadlessIo {
  return {
    env: process.env,
    platform: process.platform,
    claude: claudeLauncher(),
    now: () => new Date(),
    newId: randomUUID,
    launch: launchDetached,
    procStartOf: readProcStart,
    running: turnRunning,
    processes: (sessionId) => sessionProcesses(sessionId),
  };
}
