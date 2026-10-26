// T176 — `deck-run` su Windows: argv di `wt.exe`, env della tab, annuncio, e il
// wrapper che dentro la tab lancia `claude`.
//
// `runDeckRun` gira con un I/O finto (`DeckRunIo`): nessuna tab si apre, e
// l'argv e l'env passati a `wt.exe` si leggono così come sarebbero partiti. Il
// wrapper invece gira davvero, in un sottoprocesso, con un `claude` finto che
// scrive su file l'argv e l'env ricevuti.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeckRun, TAB_WRAPPER_JS, type DeckRunIo } from '../src/tab-launch.js';
import {
  parseTabArgv,
  semicolonArg,
  SESSION_MARKERS,
  TAB_ARGV_ENV,
  windowsTabEnv,
  wtNewTabArgs,
  wtProfile,
  wtTitle,
} from '../src/windows-terminal.js';
import { deckRunLauncher, DECK_RUN, DECK_RUN_JS } from '../src/spawn.js';

const SID = '11111111-2222-3333-4444-555555555555';
const NASTY = `tutti ; ' " & % ^ | $ \` \\ ! 🧵 à\nseconda riga`;

// ── argv di wt ─────────────────────────────────────────────────────────────

test('wt: tab nella finestra attiva, profilo, cartella, titolo bloccato, comando dopo --', () => {
  assert.deepEqual(
    wtNewTabArgs({ newWindow: false, profile: 'loom-deck', cwd: 'C:\\p', title: '🧵 p · T1', command: ['node', 'w.js'] }),
    ['-w', '0', 'new-tab', '-p', 'loom-deck', '-d', 'C:\\p', '--title', '🧵 p · T1', '--suppressApplicationTitle', '--', 'node', 'w.js'],
  );
});

test('wt: finestra nuova, nessun profilo, nessun titolo, nessun comando', () => {
  assert.deepEqual(wtNewTabArgs({ newWindow: true, profile: null, cwd: 'C:\\p', title: null }), [
    '-w',
    'new',
    'new-tab',
    '-d',
    'C:\\p',
  ]);
});

test('wt: il `;` sparisce dal titolo e ferma ogni altro argomento', () => {
  // Misurato su Windows Terminal 1.24: `;` spezza il comando in QUALUNQUE
  // argomento, anche dopo `--` e anche escapato `\;`.
  assert.equal(wtTitle('a;b · T1'), 'ab · T1');
  assert.equal(semicolonArg(['-d', 'C:\\a;b']), 'C:\\a;b');
  assert.equal(semicolonArg(['-d', 'C:\\ab']), null);
});

test('wt: il profilo è loom-deck, LOOM_DECK_WT_PROFILE lo cambia, vuota lo toglie', () => {
  assert.equal(wtProfile({}), 'loom-deck');
  assert.equal(wtProfile({ LOOM_DECK_WT_PROFILE: 'mio' }), 'mio');
  assert.equal(wtProfile({ LOOM_DECK_WT_PROFILE: '' }), null);
});

// ── env della tab ──────────────────────────────────────────────────────────

const PARENT: Record<string, string> = {
  PATH: 'C:\\x',
  CLAUDE_CONFIG_DIR: 'C:\\cfg',
  LOOM_TASK: 'T9',
  [TAB_ARGV_ENV]: '["vecchio"]',
  ...Object.fromEntries(SESSION_MARKERS.map((m) => [m, '1'])),
  claude_pid: '42',
};

test('env: via i marker di sessione (anche in minuscolo), resta la configurazione dell’utente', () => {
  const env = windowsTabEnv(PARENT, 'T1', null);
  for (const m of SESSION_MARKERS) assert.equal(env[m], undefined, m);
  assert.equal(env.claude_pid, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\cfg');
  assert.equal(env.PATH, 'C:\\x');
  assert.equal(env[TAB_ARGV_ENV], undefined);
});

test('env: LOOM_TASK è la task della conversazione, e sparisce senza task', () => {
  assert.equal(windowsTabEnv(PARENT, 'T1', null).LOOM_TASK, 'T1');
  assert.equal(windowsTabEnv(PARENT, null, null).LOOM_TASK, undefined);
});

test('env: il bash di Git entra solo se manca', () => {
  assert.equal(windowsTabEnv({}, null, 'C:\\Git\\bin\\bash.exe').CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Git\\bin\\bash.exe');
  assert.equal(
    windowsTabEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\mio\\bash.exe' }, null, 'C:\\Git\\bin\\bash.exe').CLAUDE_CODE_GIT_BASH_PATH,
    'D:\\mio\\bash.exe',
  );
});

test('parseTabArgv: solo un array di stringhe', () => {
  assert.deepEqual(parseTabArgv('["a","b"]'), ['a', 'b']);
  assert.equal(parseTabArgv(undefined), null);
  assert.equal(parseTabArgv('{"a":1}'), null);
  assert.equal(parseTabArgv('[1]'), null);
  assert.equal(parseTabArgv('non json'), null);
});

// ── runDeckRun con un I/O finto ────────────────────────────────────────────

interface Launch {
  cmd: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

function fakeRun(argv: string[], over: Partial<DeckRunIo> = {}, code = 0) {
  const out: string[] = [];
  const err: string[] = [];
  const launches: Launch[] = [];
  const io: DeckRunIo = {
    env: { LOOM_DECK_PROMPT_CATALOG: '/non/esiste', LOOM_DECK_WT_PROFILE: undefined },
    cwd: mkdtempSync(join(tmpdir(), 'loom-deck-tl-')),
    platform: 'win32',
    nodePath: 'C:\\node\\node.exe',
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    launch: async (cmd, args, env) => {
      out.push('<launch>');
      launches.push({ cmd, args, env });
      return code;
    },
    ...over,
  };
  return runDeckRun(argv, io).then((exit) => ({ exit, out, err, launches, cwd: io.cwd }));
}

test('Windows: la conversazione è una tab di wt col wrapper, e l’argv di claude sta nell’env', async () => {
  const r = await fakeRun(['T1', '--session-id', SID, '--prompt', NASTY, '--model', 'haiku']);
  assert.equal(r.exit, 0);
  assert.equal(r.launches.length, 1);
  const l = r.launches[0]!;
  assert.equal(l.cmd, 'wt.exe');
  assert.deepEqual(l.args, [
    '-w', '0', 'new-tab', '-p', 'loom-deck', '-d', r.cwd, '--title', 'cc T1', '--suppressApplicationTitle',
    '--', 'C:\\node\\node.exe', TAB_WRAPPER_JS,
  ]);
  // Il prompt non è sulla riga di wt: viaggia nell'env, identico.
  assert.ok(!l.args.some((a) => a.includes('tutti')));
  const claudeArgs = parseTabArgv(l.env?.[TAB_ARGV_ENV]);
  assert.deepEqual(claudeArgs, [
    '--name', 'cc T1', '--permission-mode', 'manual', '--model', 'haiku', '--session-id', SID, NASTY,
  ]);
  assert.equal(l.env?.LOOM_TASK, 'T1');
  // L'annuncio esce prima del lancio, come prima dell'exec.
  assert.match(r.out[0]!, /^LOOM_DECK_INTAB LOOM_TASK=T1 claude --name 'cc T1' /);
  assert.equal(r.out[1], '<launch>');
});

test('Windows: --no-task toglie LOOM_TASK ereditata, --new-window apre una finestra', async () => {
  const r = await fakeRun(['--no-task', '--new-window'], {
    env: { LOOM_TASK: 'T9', CLAUDE_CODE_CHILD_SESSION: '1', LOOM_DECK_PROMPT_CATALOG: '/non/esiste' },
  });
  const l = r.launches[0]!;
  assert.deepEqual(l.args.slice(0, 3), ['-w', 'new', 'new-tab']);
  assert.equal(l.env?.LOOM_TASK, undefined);
  assert.equal(l.env?.CLAUDE_CODE_CHILD_SESSION, undefined);
});

test('Windows: fork con --session-id, nessun prompt', async () => {
  const r = await fakeRun(['T1', '--resume', SID, '--fork', '--session-id', 'NEW', '--model', 'opus']);
  const claudeArgs = parseTabArgv(r.launches[0]!.env?.[TAB_ARGV_ENV])!;
  assert.deepEqual(claudeArgs.slice(-5), ['--session-id', 'NEW', '--resume', SID, '--fork-session']);
  assert.equal(r.launches[0]!.args[r.launches[0]!.args.indexOf('--title') + 1], 'cc T1 · fork');
});

test('Windows: un path col `;` ferma lo spawn prima dell’annuncio', async () => {
  const r = await fakeRun(['T1'], { env: { LOOM_DECK_WORKDIR: 'C:\\a;b', LOOM_DECK_PROMPT_CATALOG: '/x' } });
  assert.equal(r.exit, 2);
  assert.equal(r.launches.length, 0);
  assert.ok(!r.out.some((s) => s.startsWith('LOOM_DECK_INTAB')));
  assert.match(r.err.join(''), /argomento con ';' non passabile a wt\.exe/);
});

test('Linux: la stessa richiesta apre una tab Ptyxis con bash -lc', async () => {
  const r = await fakeRun(['T1', '--prompt-kind', 'none'], { platform: 'linux' });
  const l = r.launches[0]!;
  assert.equal(l.cmd, 'ptyxis');
  assert.equal(l.env, undefined);
  assert.deepEqual(l.args.slice(-3, -1), ['bash', '-lc']);
});

test('un errore d’uso esce 2 senza annuncio né lancio', async () => {
  const r = await fakeRun(['T1', '--prompt-kind', 'bogus']);
  assert.equal(r.exit, 2);
  assert.equal(r.launches.length, 0);
  assert.deepEqual(r.out, []);
});

test('il terminale che non parte esce 127 e lo nomina', async () => {
  const r = await fakeRun(['T1'], {
    launch: async () => {
      throw Object.assign(new Error('spawn wt.exe ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(r.exit, 127);
  assert.match(r.err.join(''), /wt\.exe non lanciabile \(ENOENT\)/);
});

test('l’uscita è quella del terminale', async () => {
  assert.equal((await fakeRun(['T1'], {}, 3)).exit, 3);
});

// ── dal deck ───────────────────────────────────────────────────────────────

test('il deck lancia lo shim su Linux, il proprio node sul punto d’ingresso su Windows', () => {
  assert.deepEqual(deckRunLauncher('linux', '/n'), { cmd: DECK_RUN, prefix: [] });
  assert.deepEqual(deckRunLauncher('win32', 'C:\\n.exe'), { cmd: 'C:\\n.exe', prefix: [DECK_RUN_JS] });
});

// ── il wrapper della tab, davvero ──────────────────────────────────────────

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

/** Un `claude` finto: scrive su file l'argv e le due env che contano, ed esce 7. */
function fakeClaude(dir: string): string {
  const out = join(dir, 'probe.json');
  writeFileSync(
    join(dir, 'probe.js'),
    `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), ` +
      `tabArgv: process.env.${TAB_ARGV_ENV} ?? null, task: process.env.LOOM_TASK ?? null })); process.exit(7);`,
  );
  if (process.platform === 'win32') {
    // La forma di cmd-shim: `claude-cmd.ts` la legge e lancia il `.js` col node.
    const shim = join(dir, 'claude.cmd');
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\probe.js" %*\r\n');
    return shim;
  }
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(join(dir, 'probe.js'))});\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function runWrapper(tabArgv: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-deck-wrap-'));
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, LOOM_DECK_CLAUDE_CMD: fakeClaude(dir), LOOM_TASK: 'T1' };
  if (tabArgv === undefined) delete env[TAB_ARGV_ENV];
  else env[TAB_ARGV_ENV] = tabArgv;
  const r = spawnSync(process.execPath, [tsxCli, join('src', 'tab-wrapper.ts')], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    windowsHide: true,
  });
  let probe: { argv: string[]; tabArgv: string | null; task: string | null } | null = null;
  try {
    probe = JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8'));
  } catch {
    // claude finto mai partito
  }
  return { status: r.status, stderr: r.stderr, probe };
}

test('wrapper: claude riceve l’argv identico, senza la variabile, ed esce col suo codice', () => {
  const argv = ['--name', '🧵 p · T1', '--model', 'opus', NASTY];
  const r = runWrapper(JSON.stringify(argv));
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(r.probe?.argv, argv);
  assert.equal(r.probe?.tabArgv, null);
  assert.equal(r.probe?.task, 'T1');
});

test('wrapper: senza la variabile non lancia niente ed esce 2', () => {
  const r = runWrapper(undefined);
  assert.equal(r.status, 2);
  assert.equal(r.probe, null);
  assert.match(r.stderr, /LOOM_DECK_TAB_ARGV assente o malformata/);
});
