// T204 — la terminazione per piattaforma: SIGHUP su un processo vero e attesa
// della fine su Linux, marcatori e TerminateProcess su Windows (con le
// dipendenze iniettate, quindi anche su Linux), lo stato zombie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCloseRequest } from '../src/endpoint-close.js';
import { createWindowsTerminator, linuxTerminator, platformTerminator } from '../src/close-terminate.js';
import { closeMarkerPaths } from '../src/close-marker.js';
import { procStartOf, statRunning, type LiveSession } from '../src/live-sessions.js';
import { unixOnly } from './platform-gates.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Un processo vero che fa da conversazione: `sleep`, che muore di SIGHUP. */
async function fakeConversation(): Promise<{ target: LiveSession; exited: Promise<number | null> }> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  const pid = child.pid!;
  let stat = '';
  for (let i = 0; i < 200 && !stat; i++) {
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const exited = new Promise<number | null>((r) => child.on('exit', (_c, s) => r(s === 'SIGHUP' ? 129 : _c)));
  return {
    target: {
      sessionId: SID,
      pid,
      status: 'idle',
      state: 'idle',
      procStart: procStartOf(stat)!,
      name: 'n',
      cwd: '/p',
      startedAt: 0,
    },
    exited,
  };
}

test('stato del processo: uno zombie con lo stesso avvio è finito, un avvio diverso non è lui', () => {
  const line = (state: string, start: string) =>
    `1234 (claude (beta)) ${state} 1 1234 1234 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;
  assert.equal(statRunning(line('S', '777'), '777'), true);
  assert.equal(statRunning(line('R', '777'), '777'), true);
  assert.equal(statRunning(line('Z', '777'), '777'), false, 'zombie: uscito, non ancora raccolto');
  assert.equal(statRunning(line('S', '778'), '777'), false, 'pid riciclato');
  assert.equal(statRunning('rotta', '777'), false);
});

test('piattaforma: SIGHUP su Linux, TerminateProcess su Windows, il resto spento col motivo', () => {
  assert.equal((platformTerminator('linux') as { how: string }).how, 'SIGHUP');
  assert.equal((platformTerminator('win32') as { how: string }).how, 'TerminateProcess');
  assert.match((platformTerminator('darwin') as { off: string }).off, /non ancora disponibile su macOS/);
});

const target = (pid: number): LiveSession => ({
  sessionId: SID,
  pid,
  status: 'idle',
  state: 'idle',
  procStart: '1',
  name: 'n',
  cwd: 'C:/p',
  startedAt: 0,
});

test('Windows: i marcatori prima della terminazione, per pid e sessionId; la fine è il pid che sparisce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-wt-'));
  const alive = new Set([42]);
  const seen: string[] = [];
  const term = createWindowsTerminator({
    dir,
    exists: (pid) => alive.has(pid),
    kill: (pid) => {
      // Al momento della terminazione i marcatori ci sono già.
      for (const p of closeMarkerPaths(pid, SID, dir)) seen.push(existsSync(p) ? 'marcatore' : 'assente');
      alive.delete(pid);
    },
  });
  assert.equal(term.alive(target(42)), true);
  assert.equal(term.terminate(target(42)), null);
  assert.deepEqual(seen, ['marcatore', 'marcatore']);
  assert.equal(term.alive(target(42)), false);
});

test('Windows: processo già finito → ESRCH, nessun marcatore; kill fallita → marcatori tolti', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-wt-'));
  const gone = createWindowsTerminator({ dir, exists: () => false, kill: () => assert.fail('nessuna kill') });
  assert.equal(gone.terminate(target(7)), 'ESRCH');
  for (const p of closeMarkerPaths(7, SID, dir)) assert.equal(existsSync(p), false);

  const denied = createWindowsTerminator({
    dir,
    exists: () => true,
    kill: () => {
      throw Object.assign(new Error('accesso negato'), { code: 'EPERM' });
    },
  });
  assert.equal(denied.terminate(target(8)), 'EPERM');
  for (const p of closeMarkerPaths(8, SID, dir)) assert.equal(existsSync(p), false, 'nessun marcatore orfano');
});

test(
  'Linux: SIGHUP a un processo vero, la guardia vede la fine, la risposta arriva dopo',
  { skip: unixOnly('segnali POSIX e /proc') },
  async () => {
    const { target, exited } = await fakeConversation();
    assert.equal(linuxTerminator.alive(target), true);
    const retired: string[] = [];
    const r = await handleCloseRequest(
      { verb: 'close', session: SID },
      {
        closeOff: () => null,
        terminator: () => linuxTerminator,
        live: () => new Map([[SID, target]]),
        sidecar: () => ({ endpointBorn: new Set([SID]), bindings: new Map([[SID, 'T1']]) }),
        retire: (sid) => retired.push(sid),
        pollMs: 20,
      },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await exited, 129, 'il processo è morto di SIGHUP');
    assert.equal(linuxTerminator.alive(target), false);
    assert.deepEqual(retired, [SID]);
  },
);

test(
  'Linux: un pid che non è più la conversazione non riceve il segnale',
  { skip: unixOnly('segnali POSIX e /proc') },
  async () => {
    const { target, exited } = await fakeConversation();
    const other = { ...target, procStart: String(Number(target.procStart) - 1) };
    assert.equal(linuxTerminator.terminate(other), 'ESRCH');
    assert.equal(linuxTerminator.alive(target), true, 'il processo vero è intatto');
    process.kill(target.pid, 'SIGTERM');
    await exited;
  },
);
