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
import { awaitAnnounce, handleSpawnRequest, planSpawnRequest, spawnPlanned, type SpawnRequestDeps } from '../src/endpoint-spawn.js';
import { HEADLESS_USAGE } from '../src/headless-client.js';
import { CLIENT_USAGE } from '../src/spawn-client.js';
import { PROMPT_KINDS } from '../src/tab-args.js';
import {
  kindRefusal,
  requestKinds,
  type RequestChannel,
  type SpawnRequest,
} from '../src/spawn-endpoint.js';
import { spawnDeck } from '../src/spawn.js';
import type { PromptKind } from '../src/spawn-catalog.js';
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
      return {
        model: 'sonnet',
        title: `${kind}-titolo`,
        prompt: kind === 'none' ? '' : `/loom-works:${kind} ${taskId}`,
        overridden: new Set(),
      };
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
    regia: null,
    title: '🧵 demo · T9',
    inTab: 'claude …',
  });
  assert.deepEqual(calls.spawned, [{ id: 'T9', model: 'sonnet', note: 'preflight-titolo', prompt: '/loom-works:preflight T9' }]);
});

// T220 — la regia che chiede: verificata contro il progetto, passata allo spawn
// con la sua sessione, riportata nella risposta.
const EPIC_TEXT = '# Task: cappello\n\n- **Size**: Epic\n';
const REGIA_SID = '0a1b2c3d-1111-2222-3333-444455556666';

function regiaDeps(spawnedRegia: unknown[], over: Partial<SpawnRequestDeps> = {}): SpawnRequestDeps {
  const base = deps();
  return {
    ...base,
    taskExists: (id) => id === 'T9' || id === 'T197' || id === 'T8',
    taskText: (id) => (id === 'T197' ? EPIC_TEXT : TASK_TEXT),
    spawn: (id, model, note, prompt, regia) => {
      spawnedRegia.push(regia);
      return base.spawn(id, model, note, prompt, regia);
    },
    ...over,
  };
}

test('regia: un’epica del progetto passa allo spawn con la sessione, e torna nella risposta', async () => {
  const seen: unknown[] = [];
  const sid = '0a1b2c3d-1111-2222-3333-444455556666';
  const r = await handleSpawnRequest(req({ regia: 'T197', regiaSession: sid }), regiaDeps(seen));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.regia, 'T197');
  assert.deepEqual(seen, [{ regia: 'T197', session: sid }]);
  // Senza la sessione: la regia passa da sola.
  await handleSpawnRequest(req({ regia: 'T197' }), regiaDeps(seen));
  assert.deepEqual(seen[1], { regia: 'T197' });
  // Senza regia: `null` allo spawn e nella risposta.
  const plain = await handleSpawnRequest(req({}), regiaDeps(seen));
  assert.deepEqual(seen[2], null);
  assert.equal(plain.ok && plain.regia, null);
});

test('regia: una task che non è un perimetro, o che non c’è, è un rifiuto senza tab', async () => {
  const seen: unknown[] = [];
  const notPerimeter = await handleSpawnRequest(req({ regia: 'T8' }), regiaDeps(seen));
  assert.deepEqual(notPerimeter, { ok: false, reason: "regia T8: non è un'epica né un mandato" });
  const missing = await handleSpawnRequest(req({ regia: 'T404' }), regiaDeps(seen));
  assert.deepEqual(missing, { ok: false, reason: 'regia T404: non è nella lista task del progetto' });
  assert.deepEqual(seen, [], 'nessuno spawn');
  // Un mandato è un perimetro come un'epica.
  const mandate = planSpawnRequest(
    req({ regia: 'T197' }),
    { ...regiaDeps(seen), taskText: (id) => (id === 'T197' ? '- **Size**: Mandate\n' : TASK_TEXT) },
    'endpoint',
  );
  assert.equal(mandate.ok && mandate.regia?.regia, 'T197');
});

// T220/P3 — la regia dichiarata si scarta quando la conversazione aperta è a sua
// volta una regia. T221 — il kind `regia` passa dall'endpoint (passaggio di
// consegne): la regola vale con la tabella vera.
test('regia: con il kind regia sull’endpoint, la regia dichiarata si scarta senza rifiuto', () => {
  const d = regiaDeps([]);
  assert.equal(kindRefusal('regia', 'endpoint'), null);
  assert.notEqual(kindRefusal('regia', 'headless'), null);
  const asRegia = planSpawnRequest(
    req({ task: 'T197', kind: 'regia', regia: 'T197', regiaSession: REGIA_SID, from: REGIA_SID }),
    d,
    'endpoint',
  );
  assert.equal(asRegia.ok, true, JSON.stringify(asRegia));
  assert.equal(asRegia.ok && asRegia.kind, 'regia');
  assert.equal(asRegia.ok && asRegia.regia, null, 'una regia non è un membro: nessuna LOOM_REGIA');
  // Kind di un membro: la regia resta, sessione compresa.
  const asMember = planSpawnRequest(req({ kind: 'run', regia: 'T197', regiaSession: REGIA_SID }), d, 'endpoint');
  assert.deepEqual(asMember.ok && asMember.regia, { regia: 'T197', session: REGIA_SID });
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

// T212/P4 — un mandato: il run si rifiuta prima della tab, col motivo, anche
// col perimetro; il recap è quello del perimetro; gli altri kind partono.
const MANDATE_TEXT = `# Task: mandato

- **Size**: Mandate

## Membri

- T1
- T2

## Deliverables Checklist

- [ ] una checklist che non conta
`;

test('mandato: run rifiutato prima della tab, recap del perimetro, il resto parte', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const over = { taskText: () => MANDATE_TEXT };
  for (const r of [req({ kind: 'run' }), req({ kind: 'run', scope: [1] })]) {
    const out = await handleSpawnRequest(r, deps(over, calls));
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, /T9 è un mandato: il lavoro sta nei membri, niente run/);
  }
  assert.equal(calls.spawned.length, 0, 'nessuna tab per un rifiuto certo');
  const recap = await handleSpawnRequest(req({ kind: 'recap' }), deps(over, calls));
  assert.equal(recap.ok, true);
  assert.deepEqual(calls.defaults, ['recap-epic']);
  const preflight = await handleSpawnRequest(req({ kind: 'preflight' }), deps(over, calls));
  assert.equal(preflight.ok, true);
});

// T221 — la regia si apre da una richiesta solo come successora di un passaggio
// di consegne: su un perimetro, con chi passa le consegne (`from`), che il deck
// marca `origin: regia` dopo l'annuncio della successora.
const OLD_REGIA = '9f8e7d6c-1111-2222-3333-444455556666';

test('regia: successora su un’epica e su un mandato, la marca su chi passa le consegne', async () => {
  for (const text of ['- **Size**: Epic\n', MANDATE_TEXT]) {
    const calls: Calls = { spawned: [], defaults: [] };
    const marked: string[] = [];
    const out = await handleSpawnRequest(
      req({ kind: 'regia', from: OLD_REGIA }),
      deps({ taskText: () => text, markHandoff: (sid) => marked.push(sid) }, calls),
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.ok && out.handoff, OLD_REGIA);
    assert.equal(out.ok && out.regia, null);
    assert.deepEqual(marked, [OLD_REGIA]);
    assert.deepEqual(calls.defaults, ['regia']);
    assert.equal(calls.spawned.length, 1);
  }
});

test('regia: senza chi passa le consegne, o su una task che non è un perimetro, nessuna tab', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const marked: string[] = [];
  const noFrom = await handleSpawnRequest(
    req({ kind: 'regia' }),
    deps({ taskText: () => '- **Size**: Epic\n', markHandoff: (sid) => marked.push(sid) }, calls),
  );
  assert.equal(noFrom.ok, false);
  assert.match((noFrom as { reason: string }).reason, /non porta il sessionId di chi passa le consegne \(from\)/);
  const notPerimeter = await handleSpawnRequest(
    req({ kind: 'regia', from: OLD_REGIA }),
    deps({ markHandoff: (sid) => marked.push(sid) }, calls),
  );
  assert.deepEqual(notPerimeter, { ok: false, reason: "regia T9: non è un'epica né un mandato" });
  assert.equal(calls.spawned.length, 0);
  assert.deepEqual(marked, [], 'nessuna marca senza successora');
});

test('regia: la marca solo a successora annunciata, anche quando esce dalla coda', async () => {
  const plan = planSpawnRequest(req({ kind: 'regia', from: OLD_REGIA }), deps({ taskText: () => MANDATE_TEXT }), 'endpoint');
  assert.ok(plan.ok);
  const marked: string[] = [];
  // deck-run esce senza annunciare: la tab non c'è, la regia vecchia resta com'è.
  const failed = await spawnPlanned(req({ kind: 'regia', from: OLD_REGIA }), plan, {
    spawn: () => ({ sessionId: 'sid-x', spawned: { child: fakeChild(null, 2), cmd: 'deck-run' } }),
    markHandoff: (sid) => marked.push(sid),
  });
  assert.equal(failed.ok, false);
  assert.equal(marked.length, 0);
  // Dalla coda: il sessionId annunciato, e la marca allo spawn vero.
  const seen: Array<string | undefined> = [];
  const queued = await spawnPlanned(
    req({ kind: 'regia', from: OLD_REGIA }),
    plan,
    {
      spawn: (_id, _m, _n, _p, _r, sid) => {
        seen.push(sid);
        return { sessionId: sid ?? 'sid-y', spawned: { child: fakeChild(['LOOM_DECK_INTAB claude …']), cmd: 'deck-run' } };
      },
      markHandoff: (sid) => marked.push(sid),
    },
    null,
    'sid-coda',
  );
  assert.equal(queued.ok && queued.sessionId, 'sid-coda');
  assert.deepEqual(seen, ['sid-coda']);
  assert.deepEqual(marked, [OLD_REGIA]);
});

// T203 S1 — l'help dei client elenca i kind che il canale accetta, e nasce
// dalla stessa regola del rifiuto: un kind fuori dall'elenco è un kind che
// `planSpawnRequest` rifiuta su quel canale, e viceversa.
test('requestKinds: la regia sull’endpoint e non sul turno headless, gli altri kind dentro', () => {
  assert.ok(requestKinds('endpoint').includes('regia'), "endpoint: la regia manca dall'elenco");
  assert.ok(!requestKinds('headless').includes('regia'), "headless: la regia è nell'elenco");
  for (const channel of ['endpoint', 'headless'] as const) {
    const kinds = requestKinds(channel);
    for (const k of ['recap', 'preflight', 'run', 'checkpoint'] as const) {
      assert.ok(kinds.includes(k), `${channel}: ${k} manca dall'elenco`);
    }
  }
});

test('requestKinds e il rifiuto di planSpawnRequest sono la stessa regola', () => {
  // La regia vuole un perimetro e chi passa le consegne: il resto della task
  // non deve decidere qui, la regola sotto misura il solo canale.
  const allow = {
    taskExists: () => true,
    taskText: (id: string) => (id === 'T1' ? '- **Size**: Epic\n' : TASK_TEXT),
    defaults: deps().defaults,
  };
  for (const channel of ['endpoint', 'headless'] as RequestChannel[]) {
    for (const kind of PROMPT_KINDS) {
      const r = kind === 'regia' ? req({ task: 'T1', kind, from: OLD_REGIA }) : req({ kind });
      const plan = planSpawnRequest(r, allow, channel);
      const listed = requestKinds(channel).includes(kind);
      assert.equal(plan.ok, listed, `${channel}/${kind}: elenco e rifiuto divergono`);
      if (!plan.ok) assert.equal(plan.reason, kindRefusal(kind, channel));
    }
  }
});

test('l help di loom-deck-spawn promette la regia, quello di loom-deck-headless no', () => {
  const kindLine = (usage: string) => usage.split('\n').find((l) => l.trim().startsWith('<kind>'))!;
  for (const [usage, regia] of [
    [CLIENT_USAGE, true],
    [HEADLESS_USAGE, false],
  ] as const) {
    const line = kindLine(usage);
    assert.ok(line, `riga <kind> assente: ${usage}`);
    if (regia) assert.match(line, /\| regia\b/, `la regia manca dall'help: ${line}`);
    else assert.doesNotMatch(line, /regia/, `la regia è nell'help: ${line}`);
    assert.match(line, /checkpoint/, `l'elenco non è quello dei kind: ${line}`);
  }
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

// T198 — il controllo della finestra: rifiuto sul `no` senza spawn, apertura
// con l'avviso su ogni «non lo so», nessun controllo su una richiesta sbagliata.
test('finestra del progetto non in focus: rifiuto col motivo, nessuno spawn e quindi nessun binding', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const r = await handleSpawnRequest(
    req({}),
    deps({ windowCheck: async () => ({ refuse: 'finestra del progetto non in focus (demo): …' }) }, calls),
  );
  assert.deepEqual(r, { ok: false, reason: 'finestra del progetto non in focus (demo): …' });
  assert.equal(calls.spawned.length, 0, 'il binding lo scrive spawn, e spawn non parte');
});

// T234 — schermo bloccato con compass abilitato: nessuna tab alla cieca.
test('schermo bloccato senza la coda: rifiuto col motivo, nessuno spawn', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const r = await handleSpawnRequest(
    req({}),
    deps({ windowCheck: async () => ({ locked: 'schermo bloccato (demo): …' }) }, calls),
  );
  assert.deepEqual(r, { ok: false, reason: 'schermo bloccato (demo): …' });
  assert.equal(calls.spawned.length, 0);
});

test('schermo bloccato con la coda: la richiesta va in coda con la causa locked, nessuno spawn', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const causes: Array<string | undefined> = [];
  const reply = { ok: false as const, reason: 'in coda: schermo bloccato (demo), …' };
  const r = await handleSpawnRequest(
    req({}),
    deps(
      {
        windowCheck: async () => ({ locked: 'schermo bloccato (demo): …' }),
        queue: {
          enqueue: async (_q, _plan, cause) => {
            causes.push(cause);
            return reply;
          },
        },
      },
      calls,
    ),
  );
  assert.equal(r, reply);
  assert.deepEqual(causes, ['locked']);
  assert.equal(calls.spawned.length, 0);
});

// T229 — con la coda il `no` non rifiuta: la richiesta pianificata passa alla
// coda, che risponde «in coda»; lo spawn non parte, quindi nessun binding.
test('finestra del progetto non in focus con la coda: la richiesta pianificata va in coda, nessuno spawn', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const queued: Array<{ task: string; kind: string; prompt: string }> = [];
  const reply = {
    ok: false as const,
    reason: 'in coda: …',
    queued: {
      sessionId: 'sid-q',
      task: 'T9',
      kind: 'preflight' as const,
      model: 'sonnet' as const,
      prompt: '/loom-works:preflight T9',
      regia: null,
      expiresAt: '2026-11-20T17:30:00.000Z',
    },
  };
  const r = await handleSpawnRequest(
    req({}),
    deps(
      {
        windowCheck: async () => ({ refuse: 'finestra del progetto non in focus (demo): …' }),
        queue: {
          enqueue: async (q, plan) => {
            queued.push({ task: q.task, kind: plan.kind, prompt: plan.prompt });
            return reply;
          },
        },
      },
      calls,
    ),
  );
  assert.deepEqual(r, reply);
  assert.deepEqual(queued, [{ task: 'T9', kind: 'preflight', prompt: '/loom-works:preflight T9' }]);
  assert.equal(calls.spawned.length, 0);
});

test('la coda non vede le richieste con la finestra giusta né quelle sbagliate', async () => {
  let enqueued = 0;
  const queue = {
    enqueue: async () => {
      enqueued++;
      return { ok: false as const, reason: 'in coda' };
    },
  };
  const ok = await handleSpawnRequest(req({}), deps({ windowCheck: async () => ({ ok: true as const }), queue }));
  assert.equal(ok.ok, true);
  const bad = await handleSpawnRequest(req({ task: 'T404' }), deps({ windowCheck: async () => ({ refuse: 'x' }), queue }));
  assert.match((bad as { reason: string }).reason, /T404 non è nella lista task/);
  assert.equal(enqueued, 0);
});

test('spawnPlanned: il sessionId della coda arriva allo spawn, e la risposta è quella di una tab', async () => {
  const seen: Array<string | undefined> = [];
  const r = await spawnPlanned(
    req({}),
    { ok: true, kind: 'preflight', model: 'opus', note: 'n', prompt: 'p', regia: null },
    {
      spawn: (_id, _m, _n, _p, _r, sessionId) => {
        seen.push(sessionId);
        return {
          sessionId: sessionId ?? 'nuovo',
          spawned: { child: fakeChild(['LOOM_DECK_TITLE 🧵 demo · T9', 'LOOM_DECK_INTAB claude …']), cmd: 'deck-run' },
        };
      },
    },
    null,
    'sid-annunciato',
  );
  assert.deepEqual(seen, ['sid-annunciato']);
  assert.equal(r.ok, true);
  assert.equal((r as { sessionId: string }).sessionId, 'sid-annunciato');
  assert.equal((r as { title: string }).title, '🧵 demo · T9');
});

test('finestra non verificata: la tab si apre e la risposta porta l’avviso', async () => {
  const calls: Calls = { spawned: [], defaults: [] };
  const r = await handleSpawnRequest(
    req({}),
    deps({ windowCheck: async () => ({ warning: 'finestra non verificata (compass non raggiungibile: ENOENT): …' }) }, calls),
  );
  assert.equal(r.ok, true);
  assert.equal((r as { warning?: string }).warning, 'finestra non verificata (compass non raggiungibile: ENOENT): …');
  assert.equal(calls.spawned.length, 1);
});

test('finestra del progetto in focus, o nessun controllo: la tab si apre senza avviso', async () => {
  for (const windowCheck of [async () => ({ ok: true as const }), undefined]) {
    const calls: Calls = { spawned: [], defaults: [] };
    const r = await handleSpawnRequest(req({}), deps({ windowCheck }, calls));
    assert.equal(r.ok, true);
    assert.equal('warning' in r, false, 'nessun campo warning');
    assert.equal(calls.spawned.length, 1);
  }
});

test('una richiesta sbagliata si rifiuta col suo motivo, senza chiedere la finestra', async () => {
  let asked = 0;
  const r = await handleSpawnRequest(
    req({ task: 'T404' }),
    deps({
      windowCheck: async () => {
        asked++;
        return { refuse: 'finestra' };
      },
    }),
  );
  assert.match((r as { reason: string }).reason, /T404 non è nella lista task/);
  assert.equal(asked, 0);
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
    regia: null,
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
