// T196 — dalla richiesta allo spawn: verifiche del deck prima della tab, prompt
// e modello come li comporrebbe il tasto, risposta all'annuncio di `deck-run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitAnnounce, handleSpawnRequest, type SpawnRequestDeps } from '../src/endpoint-spawn.js';
import { spawnDeck } from '../src/spawn.js';
import type { PromptKind } from '../src/spawn-catalog.js';
import type { SpawnRequest } from '../src/spawn-endpoint.js';
import { unixOnly } from './platform-gates.js';

const TASK_TEXT = `# Task: demo

- **Size**: M

## Deliverables Checklist

- [x] primo
- [ ] secondo
- [ ] terzo
`;

/** Un figlio finto che annuncia come `deck-run`, o esce senza annunciare. */
function fakeChild(lines: string[] | null, exitCode = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough };
  child.stdout = new PassThrough();
  setImmediate(() => {
    if (lines) for (const l of lines) child.stdout.write(`${l}\n`);
    child.stdout.end();
    child.emit('close', exitCode);
  });
  return child;
}

interface Calls {
  spawned: Array<{ id: string; model: string; note: string; prompt: string }>;
  defaults: PromptKind[];
}

function deps(over: Partial<SpawnRequestDeps> = {}, calls: Calls = { spawned: [], defaults: [] }): SpawnRequestDeps {
  return {
    spawnOff: () => null,
    taskExists: (id) => id === 'T9',
    taskText: () => TASK_TEXT,
    defaults: (kind, taskId) => {
      calls.defaults.push(kind);
      return { model: 'sonnet', title: `${kind}-titolo`, prompt: kind === 'none' ? '' : `/loom-works:${kind} ${taskId}` };
    },
    spawn: (id, model, note, prompt) => {
      calls.spawned.push({ id, model, note, prompt });
      return {
        sessionId: 'sid-1',
        spawned: { child: fakeChild(['LOOM_DECK_TITLE 🧵 demo · T9', 'LOOM_DECK_INTAB claude …']), cmd: 'deck-run' },
      };
    },
    ...over,
  };
}

const req = (r: Partial<SpawnRequest>): SpawnRequest => ({ verb: 'spawn', task: 'T9', kind: 'preflight', ...r });

test('preflight: la terna del catalogo, e la risposta porta titolo e comando in-tab', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const r = await handleSpawnRequest(req({}), deps({}, calls));
  assert.deepEqual(r, {
    ok: true,
    sessionId: 'sid-1',
    task: 'T9',
    kind: 'preflight',
    model: 'sonnet',
    prompt: '/loom-works:preflight T9',
    title: '🧵 demo · T9',
    inTab: 'claude …',
  });
  assert.deepEqual(calls.spawned, [{ id: 'T9', model: 'sonnet', note: 'preflight-titolo', prompt: '/loom-works:preflight T9' }]);
});

test('run col perimetro: DLV in coda al prompt di run già risolto, come il modo DLV', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const r = await handleSpawnRequest(req({ kind: 'run', scope: [3, 2] }), deps({}, calls));
  assert.equal(r.ok, true);
  assert.equal(calls.spawned[0]!.prompt, '/loom-works:run T9 DLV 2,3');
});

test('modello e nota della richiesta vincono sul catalogo', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  await handleSpawnRequest(req({ model: 'haiku', note: 'a mano' }), deps({}, calls));
  assert.deepEqual(calls.spawned[0], { id: 'T9', model: 'haiku', note: 'a mano', prompt: '/loom-works:preflight T9' });
});

test('recap su un’epica: la sotto-skill dell’epica, come il detail', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  await handleSpawnRequest(req({ kind: 'recap' }), deps({ taskText: () => '- **Size**: Epic\n' }, calls));
  assert.deepEqual(calls.defaults, ['recap-epic']);
  await handleSpawnRequest(req({ kind: 'recap' }), deps({ taskText: () => null }, calls));
  assert.equal(calls.defaults[1], 'recap', 'senza task file resta il dispatcher');
});

test('rifiuti prima della tab: piattaforma, task assente, perimetro fuori range o chiuso', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const cases: Array<[SpawnRequest, Partial<SpawnRequestDeps>, RegExp]> = [
    [req({}), { spawnOff: () => 'apertura di tab n/d su Windows' }, /n\/d su Windows/],
    [req({ task: 'T404' }), {}, /T404 non è nella lista task/],
    [req({ kind: 'run', scope: [4] }), {}, /fuori range in T9: 4 \(ne ha 3\)/],
    [req({ kind: 'run', scope: [1, 2] }), {}, /già chiusi in T9: 1/],
    [req({ kind: 'run', scope: [1] }), { taskText: () => null }, /non trovato/],
    [req({}), { spawn: () => null }, /rifiutato/],
  ];
  for (const [r, over, re] of cases) {
    const out = await handleSpawnRequest(r, deps(over, calls));
    assert.equal(out.ok, false, re.source);
    assert.match((out as { reason: string }).reason, re);
  }
  assert.equal(calls.spawned.length, 0, 'nessun rifiuto passa dallo spawn');
});

test('deck-run che esce prima di annunciare: ok:false col codice', async () => {
  const r = await handleSpawnRequest(
    req({}),
    deps({ spawn: () => ({ sessionId: 's', spawned: { child: fakeChild(null, 2), cmd: 'x' } }) }),
  );
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /uscito con 2 prima di aprire la tab/);
});

test('spawn inerte (figlio senza stdout): ok e inert, senza aspettare', async () => {
  const inert = new EventEmitter() as ChildProcess;
  const r = await handleSpawnRequest(req({}), deps({ spawn: () => ({ sessionId: 's', spawned: { child: inert, cmd: 'x' } }) }));
  assert.deepEqual(r, {
    ok: true,
    sessionId: 's',
    task: 'T9',
    kind: 'preflight',
    model: 'sonnet',
    prompt: '/loom-works:preflight T9',
    title: null,
    inTab: null,
    inert: true,
  });
});

test('annuncio spezzato su più chunk e figlio muto: riga intera, o timeout', async () => {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough };
  child.stdout = new PassThrough();
  const p = awaitAnnounce(child, 5_000);
  child.stdout.write('LOOM_DECK_TIT');
  child.stdout.write('LE t\nrumore\nLOOM_DECK_IN');
  child.stdout.write('TAB cmd\n');
  assert.deepEqual(await p, { title: 't', inTab: 'cmd' });

  const mute = new EventEmitter() as ChildProcess & { stdout: PassThrough };
  mute.stdout = new PassThrough();
  assert.deepEqual(await awaitAnnounce(mute, 30), { error: 'nessun annuncio da deck-run entro 30 ms' });
});

test(
  'percorso intero con deck-run vero e un ptyxis finto: titolo e comando annunciati tornano nella risposta',
  { skip: unixOnly('deck-run è lo shim bash, ptyxis finto in testa al PATH') },
  async () => {
    const shim = mkdtempSync(join(tmpdir(), 'loom-ep-shim-'));
    writeFileSync(join(shim, 'ptyxis'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(shim, 'ptyxis'), 0o755);
    const cwd = mkdtempSync(join(tmpdir(), 'loom-ep-wd-'));
    const saved = { ...process.env };
    process.env.PATH = `${shim}:${process.env.PATH ?? ''}`;
    process.env.LOOM_DECK_STATE_PROFILE = '';
    process.env.LOOM_DECK_LIVE_SESSIONS_ROOT = mkdtempSync(join(tmpdir(), 'loom-ep-reg-'));
    try {
      const r = await handleSpawnRequest(
        req({ kind: 'run', scope: [2] }),
        deps({
          spawn: (id, model, note, prompt) => ({
            sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            spawned: spawnDeck(id, cwd, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', model, note, prompt),
          }),
        }),
      );
      assert.equal(r.ok, true, JSON.stringify(r));
      if (!r.ok) return;
      assert.equal(r.title, 'cc T9 run-titolo');
      assert.match(r.inTab!, /^LOOM_TASK=T9 claude --name 'cc T9 run-titolo' .*--model sonnet .*--session-id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee '\/loom-works:run T9 DLV 2'$/);
    } finally {
      process.env = saved;
    }
  },
);
