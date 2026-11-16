// T204 — la terminazione per piattaforma: SIGHUP su un processo vero e attesa
// della fine su Linux, la piattaforma senza terminazione, lo stato zombie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { handleCloseRequest } from '../src/endpoint-close.js';
import { linuxTerminator, platformTerminator } from '../src/close-terminate.js';
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

test('piattaforma: SIGHUP su Linux, il resto spento col motivo', () => {
  assert.equal((platformTerminator('linux') as { how: string }).how, 'SIGHUP');
  assert.match((platformTerminator('win32') as { off: string }).off, /non ancora disponibile su Windows/);
  assert.match((platformTerminator('darwin') as { off: string }).off, /non ancora disponibile su macOS/);
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
