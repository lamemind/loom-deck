// T179 — come si lancia il comando di una voce launch: la forma per
// piattaforma (`launchSpawn`, puro) e il tramite di Windows, provato davvero.
//
// Il tramite è uno script `node -e` che non dipende da Windows: lancia l'argv
// dell'env e scrive l'exit nel file. Il gate lo esegue su ogni piattaforma col
// bash che c'è — il bash di Git su Windows, `bash` del sistema altrove —, così
// la parte che conta (l'exit, il log, l'argv intatto) è misurata anche dove il
// deck non lo usa. Le finestre su Windows non si vedono da un test: che il bash
// lanciato dal tramite non apra console e lasci visibili i programmi grafici si
// misura a mano, sull'elenco delle finestre top-level di UI Automation, contro
// un `cmd` `detached` di controllo che una finestra la apre.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  LAUNCH_ARGV_ENV,
  LAUNCH_EXIT_ENV,
  LAUNCH_RELAY_SCRIPT,
  LAUNCH_WRAPPER,
  launchField,
  launchOffReason,
  launchSpawn,
} from '../src/launch-platform.js';
import { gitBash } from '../src/git-bash.js';

const BASH = 'C:\\Git\\bin\\bash.exe';

test('launchSpawn su Linux: bash -lic per il launcher nudo, il wrapper per la voce con esito', () => {
  assert.deepEqual(launchSpawn('codium .', null, 'linux'), { cmd: 'bash', args: ['-lic', 'codium .'] });
  assert.deepEqual(launchSpawn('git pull', '/p/.claude/loom/launch/pull.exit', 'linux'), {
    cmd: 'bash',
    args: ['-c', LAUNCH_WRAPPER, 'loom-launch', 'git pull', '/p/.claude/loom/launch/pull.exit'],
  });
});

test('launchSpawn su Linux non cerca il bash di Git', () => {
  const never = () => {
    throw new Error('il bash di Git si cerca solo su win32');
  };
  assert.equal(launchSpawn('x', null, 'linux', never)!.cmd, 'bash');
});

test('launchSpawn su Windows: il tramite node, con argv e file di esito nell\'env', () => {
  const spec = launchSpawn("printf '%s' \"a'b\"", 'C:\\p\\x.exit', 'win32', () => BASH, 'C:\\node.exe', { PATH: 'X' })!;
  assert.equal(spec.cmd, 'C:\\node.exe');
  assert.deepEqual(spec.args, ['-e', LAUNCH_RELAY_SCRIPT]);
  assert.deepEqual(JSON.parse(spec.env![LAUNCH_ARGV_ENV]!), [BASH, '-lc', "printf '%s' \"a'b\""]);
  assert.equal(spec.env![LAUNCH_EXIT_ENV], 'C:\\p\\x.exit');
  assert.equal(spec.env!.PATH, 'X', 'il resto dell\'env è quello del deck');
});

test('launchSpawn su Windows senza file di esito: nessuna variabile di esito, nemmeno ereditata', () => {
  const spec = launchSpawn('code .', null, 'win32', () => BASH, 'node', { [LAUNCH_EXIT_ENV]: 'vecchio' })!;
  assert.equal(spec.env![LAUNCH_EXIT_ENV], undefined);
});

test('launchSpawn su Windows senza bash di Git: null', () => {
  assert.equal(launchSpawn('code .', null, 'win32', () => null), null);
});

test('il tramite attraversa la riga di comando di Windows come un argomento solo', () => {
  assert.equal(LAUNCH_RELAY_SCRIPT.includes('"'), false);
});

test('il campo e la causa di una voce n/d nominano la piattaforma', () => {
  assert.equal(launchField('win32'), 'windows');
  assert.equal(launchField('linux'), 'command');
  assert.equal(launchField('darwin'), 'command');
  assert.equal(launchOffReason('win32'), 'n/d su Windows: manca il campo windows');
  assert.equal(launchOffReason('linux'), 'n/d su Linux: manca il campo command');
});

// ── il tramite, vero ─────────────────────────────────────────────────────────

/** Il bash con cui il gate esegue il tramite. */
function realBash(): string | null {
  if (process.platform === 'win32') return gitBash();
  const r = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const BASH_REAL = realBash();
const SKIP = BASH_REAL === null ? 'nessun bash su questa macchina' : false;

/** Lancia il tramite come lo lancia il deck: `detached`, stdout e stderr sul
 *  log. Restituisce il figlio e i due file. */
function relay(command: string, bash: string = BASH_REAL!) {
  const dir = mkdtempSync(join(tmpdir(), 'deck-relay-'));
  const exitFile = join(dir, 'voce.exit');
  const logFile = join(dir, 'voce.log');
  const spec = launchSpawn(command, exitFile, 'win32', () => bash)!;
  const fd = openSync(logFile, 'w');
  try {
    const child = spawn(spec.cmd, spec.args, { cwd: dir, detached: true, stdio: ['ignore', fd, fd], env: spec.env, windowsHide: true });
    child.unref();
    return { child, dir, exitFile, logFile };
  } finally {
    closeSync(fd);
  }
}

/** Aspetta il file di esito a poll: il figlio è `unref()` (`launch-run.test.ts`
 *  spiega perché non con `once('exit')`). */
async function waitFile(path: string, ms = 20_000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.endsWith('\n')) return text;
    }
    await sleep(50);
  }
  throw new Error(`nessun file ${path} entro ${ms}ms`);
}

test('tramite: exit del bash nel file, stdout e stderr nel log, cwd della voce', { skip: SKIP }, async () => {
  const r = relay('echo ciao; echo errore >&2; pwd; exit 7');
  assert.equal(await waitFile(r.exitFile), '7\n');
  const log = readFileSync(r.logFile, 'utf8');
  assert.match(log, /ciao/);
  assert.match(log, /errore/);
  // `pwd` del bash di Git stampa la cartella in una delle sue forme: basta il
  // nome finale, che è univoco.
  const leaf = r.dir.split(/[\\/]/).pop()!;
  assert.ok(log.includes(leaf), `il comando gira nella cartella della voce: ${log}`);
});

test('tramite: apici e $ arrivano intatti, e le variabili del tramite non passano al bash', { skip: SKIP }, async () => {
  const r = relay(`printf '%s' "a'b" && echo " \${HOME:+ok} [\${${LAUNCH_ARGV_ENV}-assente}] [\${${LAUNCH_EXIT_ENV}-assente}]"`);
  assert.equal(await waitFile(r.exitFile), '0\n');
  assert.match(readFileSync(r.logFile, 'utf8'), /a'b ok \[assente\] \[assente\]/);
});

test('tramite: un bash che non parte vale exit 127', { skip: SKIP }, async () => {
  const r = relay('echo mai', join(tmpdir(), 'nessun-bash-qui', 'bash.exe'));
  assert.equal(await waitFile(r.exitFile), '127\n');
});
