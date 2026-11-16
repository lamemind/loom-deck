// T204 — il marcatore di una chiusura chiesta su Windows: il deck lo scrive
// prima di terminare, il wrapper della tab lo consuma all'uscita del figlio ed
// esce 0. Il modulo è puro filesystem e gira su ogni piattaforma; il wrapper
// vero si prova su Linux con un `claude` finto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_MARKER_TTL_MS,
  closeMarkerPaths,
  consumeCloseMarker,
  removeCloseMarkers,
  sessionIdInArgv,
  writeCloseMarkers,
} from '../src/close-marker.js';
import { unixOnly } from './platform-gates.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const dir = () => mkdtempSync(join(tmpdir(), 'loom-cm-'));
const argvOf = (sid: string) => ['--name', 'x', '--model', 'opus', '--session-id', sid, '/loom-works:run-task T1'];

test('path: per pid e per sessionId; valori fuori forma non producono un path', () => {
  const d = dir();
  assert.deepEqual(closeMarkerPaths(42, SID, d), [join(d, 'loom-deck-close-42'), join(d, `loom-deck-close-${SID}`)]);
  assert.deepEqual(closeMarkerPaths(null, null, d), []);
  assert.deepEqual(closeMarkerPaths(-1, '../../etc', d), []);
});

test('sessionId dall’argv: --session-id vince su --resume, forme con = comprese', () => {
  assert.equal(sessionIdInArgv(argvOf(SID)), SID);
  assert.equal(sessionIdInArgv(['--resume', SID]), SID);
  assert.equal(sessionIdInArgv([`--resume=${SID}`]), SID);
  assert.equal(sessionIdInArgv(['--resume', 'vecchio', '--fork-session', '--session-id', SID]), SID);
  assert.equal(sessionIdInArgv(['--name', 'x', 'prompt']), null);
});

test('chiusura chiesta: il wrapper trova il marcatore per pid, lo consuma, e la seconda volta no', () => {
  const d = dir();
  writeCloseMarkers(42, SID, d);
  assert.equal(consumeCloseMarker(42, ['--name', 'x'], d), true);
  for (const p of closeMarkerPaths(42, SID, d).slice(0, 1)) assert.equal(existsSync(p), false);
  assert.equal(consumeCloseMarker(42, ['--name', 'x'], d), false);
});

test('pid diverso (un lanciatore fra wrapper e claude): basta il sessionId dell’argv, e si consumano entrambi', () => {
  const d = dir();
  const paths = writeCloseMarkers(4242, SID, d);
  assert.equal(consumeCloseMarker(77, argvOf(SID), d), true);
  assert.equal(existsSync(paths[1]!), false, 'il marcatore per sessionId è consumato');
  assert.equal(existsSync(paths[0]!), true, 'quello per un pid che non è del wrapper resta');
});

test('nessun marcatore: un crash resta un crash', () => {
  assert.equal(consumeCloseMarker(42, argvOf(SID), dir()), false);
});

test('marcatore scaduto: si cancella e non vale — una tab di un crash vero resta aperta', () => {
  const d = dir();
  const [p] = writeCloseMarkers(42, SID, d);
  const old = (Date.now() - CLOSE_MARKER_TTL_MS - 5_000) / 1000;
  utimesSync(p!, old, old);
  writeFileSync(join(d, 'altro'), '');
  assert.equal(consumeCloseMarker(42, ['--name', 'x'], d), false);
  assert.equal(existsSync(p!), false);
});

test('terminazione non partita: il deck toglie i propri marcatori', () => {
  const d = dir();
  const paths = writeCloseMarkers(42, SID, d);
  removeCloseMarkers(paths);
  for (const p of paths) assert.equal(existsSync(p), false);
  removeCloseMarkers(paths); // idempotente
});

/** Il wrapper della tab compilato, con un `claude` finto che scrive il proprio
 *  pid e aspetta: la chiusura chiesta (marcatore) contro il crash (nessun
 *  marcatore), entrambi terminati di forza come fa Windows. */
async function wrapperExit(withMarker: boolean): Promise<number | null> {
  const d = dir();
  const pidFile = join(d, 'pid');
  const fake = join(d, 'claude-finto.sh');
  writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const wrapper = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tab-wrapper.js');
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, TMPDIR: d, LOOM_DECK_CLAUDE_CMD: fake, LOOM_DECK_TAB_ARGV: JSON.stringify(argvOf(SID)) },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  let pid = 0;
  for (let i = 0; i < 300 && !pid; i++) {
    try {
      pid = Number(readFileSync(pidFile, 'utf8').trim());
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (withMarker) writeCloseMarkers(pid, SID, d);
  process.kill(pid, 'SIGKILL');
  return exited;
}

test(
  'wrapper della tab: chiusura chiesta → esce 0 e la tab si chiude; crash → esce col suo codice',
  { skip: unixOnly('claude finto in sh; su Windows lo prova il collaudo reale') },
  async () => {
    assert.equal(await wrapperExit(true), 0);
    assert.notEqual(await wrapperExit(false), 0);
  },
);
