// T176 — `deck-run` come programma: legge l'argv, compone la tab, la annuncia e
// la apre nel terminale della piattaforma.
//
// Il contratto verso chi lo lancia è quello dello script bash che ha sostituito:
//  - uscita 2 e messaggio su stderr per un errore d'uso, nessun annuncio;
//  - prima di aprire la tab, su stdout, la riga `LOOM_DECK_INTAB <comando>` col
//    comando che gira nella tab — il deck la legge e la mostra nella riga di
//    stato (`onInTabCommand`), invece di ricomporla;
//  - poi il terminale, e l'uscita è la sua: `ptyxis --tab` e `wt.exe new-tab`
//    escono appena hanno consegnato la tab all'istanza già aperta.
//
// L'I/O verso l'esterno passa da `DeckRunIo`, così il test della composizione
// completa non apre tab. Il filesystem no: file di progetto e catalogo si
// leggono dal disco anche nei test, su cartelle temporanee.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsageError, parseTabArgs } from './tab-args.js';
import { composeTab, ptyxisArgv } from './tab-compose.js';
import { loadPromptCatalog, PROMPT_CATALOG } from './prompt-catalog.js';
import { configFilePath } from './config.js';
import { liveRequestedNames, liveSessionsRoot } from './live-sessions.js';
import { resolveGitBash } from './git-bash.js';
import {
  semicolonArg,
  TAB_ARGV_ENV,
  windowsTabEnv,
  WT_CMD,
  wtNewTabArgs,
  wtProfile,
} from './windows-terminal.js';

/** Il wrapper che gira dentro una tab di Windows Terminal, nel build: lo esegue
 *  il node del deck, e `src/` sotto `tsx` non ha un `.js` da dargli. */
export const TAB_WRAPPER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tab-wrapper.js');

export interface DeckRunIo {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  platform: NodeJS.Platform;
  /** Il node che eseguirà il wrapper della tab su Windows. */
  nodePath: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Lancia il terminale e restituisce la sua uscita; rifiuta se non parte. */
  launch: (cmd: string, args: string[], env?: Record<string, string | undefined>) => Promise<number>;
}

/**
 * La cartella di lavoro della tab: `LOOM_DECK_WORKDIR`, altrimenti la cartella
 * corrente.
 *
 * Su Linux la cartella corrente è quella LOGICA, come il `$PWD` di bash: `PWD`
 * se punta alla stessa cartella di `cwd` (un symlink resta un symlink nel
 * titolo e nel `-d` di Ptyxis), `cwd` altrimenti. Su Windows `PWD` arriva da
 * Git Bash in forma `/c/…`, che `wt -d` non capisce: vale solo `cwd`.
 */
export function workdirOf(io: Pick<DeckRunIo, 'env' | 'cwd' | 'platform'>): string {
  if (io.env.LOOM_DECK_WORKDIR) return io.env.LOOM_DECK_WORKDIR;
  const pwd = io.env.PWD;
  if (io.platform !== 'win32' && pwd) {
    try {
      const a = statSync(pwd);
      const b = statSync(io.cwd);
      if (a.dev === b.dev && a.ino === b.ino) return pwd;
    } catch {
      // PWD che non esiste più → la cartella vera
    }
  }
  return io.cwd;
}

/** La cartella che contiene `.claude/loom-works.json`, risalendo da `start`
 *  fino alla radice compresa; `null` fuori da un progetto loom. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(configFilePath(dir))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Il file di progetto parsato, o `null` se manca o è malformato: il titolo
 *  ricade su `cc`, il permission mode su `manual`, e lo spawn parte lo stesso. */
function loadConfig(root: string | null): unknown {
  if (!root) return null;
  try {
    return JSON.parse(readFileSync(configFilePath(root), 'utf8'));
  } catch {
    return null;
  }
}

/** Un argv come una shell POSIX lo leggerebbe: per le diagnostiche. */
function describe(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

export async function runDeckRun(argv: readonly string[], io: DeckRunIo): Promise<number> {
  const req = parseTabArgs(argv);
  if (isUsageError(req)) {
    for (const line of req.lines) io.stderr(`${line}\n`);
    return 2;
  }
  const workdir = workdirOf(io);
  const catalogPath = io.env.LOOM_DECK_PROMPT_CATALOG || PROMPT_CATALOG;
  const plan = composeTab(req, {
    env: io.env,
    config: loadConfig(findProjectRoot(workdir)),
    catalog: loadPromptCatalog(catalogPath),
    catalogPath,
    platform: io.platform,
    // Su Windows il nome chiesto non si legge: viene dall'argv di
    // `/proc/<pid>/cmdline`, che lì non esiste. La liveness c'è (T177), ma
    // interrogarla qui lancerebbe la query di PowerShell e terrebbe `deck-run`
    // in vita fino alla sua risposta, per una lista che esce comunque vuota: il
    // titolo resta quello base, il comportamento di prima del gemello.
    liveRequestedNames: io.platform === 'win32' ? [] : liveRequestedNames(liveSessionsRoot(io.env)),
  });
  for (const w of plan.warnings) io.stderr(`${w}\n`);

  let cmd: string;
  let args: string[];
  let env: Record<string, string | undefined> | undefined;
  if (io.platform === 'win32') {
    cmd = WT_CMD;
    args = wtNewTabArgs({
      newWindow: req.newWindow,
      profile: wtProfile(io.env),
      cwd: workdir,
      title: plan.title,
      command: [io.nodePath, TAB_WRAPPER_JS],
    });
    const bad = semicolonArg(args);
    if (bad !== null) {
      io.stderr(`argomento con ';' non passabile a ${WT_CMD}, che lo legge come separatore: '${bad}'\n`);
      return 2;
    }
    env = {
      ...windowsTabEnv(io.env, req.noTask ? null : req.task, resolveGitBash(io.env, existsSync)),
      [TAB_ARGV_ENV]: JSON.stringify(plan.claudeArgs),
    };
    io.stdout(`LOOM_DECK_INTAB ${plan.inTab}\n`);
  } else {
    // L'override esiste per i probe empirici (un comando non-CC nella tab): è
    // una riga per bash, quindi vale solo dove la tab la esegue con bash.
    const inTab = io.env.LOOM_DECK_INTAB_CMD || plan.inTab;
    cmd = 'ptyxis';
    args = ptyxisArgv(req.newWindow, workdir, plan.title, inTab);
    io.stdout(`LOOM_DECK_INTAB ${inTab}\n`);
  }

  try {
    return await io.launch(cmd, args, env);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? String(e);
    io.stderr(`deck-run: ${cmd} non lanciabile (${code}): ${describe(cmd, args)}\n`);
    return 127;
  }
}

/**
 * Il lancio vero: stdio ereditato, così chi legge lo stdout di `deck-run` vede
 * anche quello del terminale, come quando lo script finiva con `exec`.
 *
 * `windowsHide: false` e non il `true` degli altri spawn del deck: `wt.exe` è
 * un'applicazione GUI, e con `true` la finestra di `-w new` partirebbe nascosta.
 * Un processo GUI non apre console, quindi non c'è niente da nascondere.
 */
export function launchTerminal(
  cmd: string,
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv | undefined, windowsHide: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolveExit(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}

export function realIo(): DeckRunIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    nodePath: process.execPath,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    launch: launchTerminal,
  };
}
