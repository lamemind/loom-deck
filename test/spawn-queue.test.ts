// T229 — la coda degli spawn: messa in coda col `sessionId` annunciato, rifiuto
// quando l'attesa non può partire, apertura in ordine d'arrivo al ritorno del
// focus, ritorno in attesa, scadenza, morte con nota e notifica.
//
// Compass, orologio e spawn sono finti: `awaitFocus` registra le chiamate e il
// test risponde quando vuole, `open` registra lo spawn vero.
//
// T234 — anche lo shell: `screenLocked` risponde ciò che il test dichiara e
// conta le domande, `awaitCompass` registra le attese dello sblocco come
// `awaitFocus`. Il blocco dello schermo si collauda senza bloccarlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompassReply } from '../src/focus-session.js';
import type { OkPlan, SpawnPlan } from '../src/endpoint-spawn.js';
import type { CompassBack } from '../src/screen-lock.js';
import type { SpawnReply, SpawnRequest } from '../src/spawn-endpoint.js';
import { QUEUE_NOTIFY_TITLE, QUEUE_TTL_MS, SpawnQueue, spawnLabel } from '../src/spawn-queue.js';
import type { WindowCheck } from '../src/window-check.js';

interface AwaitCall {
  projectId: string;
  notice: string;
  deadlineS: number;
  reply: (r: CompassReply) => void;
  stopped: boolean;
}

interface CompassWait {
  deadlineS: number;
  reply: (r: CompassBack) => void;
  stopped: boolean;
}

const PLAN: OkPlan = {
  ok: true,
  kind: 'preflight',
  model: 'opus',
  note: 'preflight-titolo',
  prompt: '/loom-works:preflight-task T9',
  regia: null,
};

const req = (r: Partial<SpawnRequest> = {}): SpawnRequest => ({ verb: 'spawn', task: 'T9', kind: 'preflight', ...r });

const T0 = Date.UTC(2026, 10, 20, 17, 0, 0);

function harness(
  over: {
    recheck?: () => Promise<WindowCheck>;
    replan?: (r: SpawnRequest) => SpawnPlan;
    screenLocked?: () => Promise<boolean>;
  } = {},
) {
  const awaits: AwaitCall[] = [];
  const compassWaits: CompassWait[] = [];
  const lockProbes = { count: 0 };
  const opened: Array<{ task: string; sessionId: string }> = [];
  const notes: string[] = [];
  const notified: Array<[string, string]> = [];
  const clock = { now: T0 };
  let sid = 0;
  const openResult: { next: SpawnReply | null } = { next: null };
  const queue = new SpawnQueue({
    projectId: () => 'demo',
    name: () => 'demo',
    awaitFocus: (projectId, notice, deadlineS, reply) => {
      const call: AwaitCall = { projectId, notice, deadlineS, reply, stopped: false };
      awaits.push(call);
      return () => {
        call.stopped = true;
      };
    },
    recheck: over.recheck ?? (async () => ({ ok: true })),
    screenLocked: () => {
      lockProbes.count++;
      return over.screenLocked ? over.screenLocked() : Promise.resolve(false);
    },
    awaitCompass: (deadlineS, reply) => {
      const wait: CompassWait = { deadlineS, reply, stopped: false };
      compassWaits.push(wait);
      return () => {
        wait.stopped = true;
      };
    },
    replan: over.replan ?? (() => PLAN),
    open: async (r, plan, sessionId) => {
      opened.push({ task: r.task, sessionId });
      return (
        openResult.next ?? {
          ok: true,
          sessionId,
          task: r.task,
          kind: plan.kind,
          model: plan.model,
          prompt: plan.prompt,
          title: 't',
          inTab: 'c',
          regia: null,
        }
      );
    },
    note: (s) => notes.push(s),
    notify: (title, body) => notified.push([title, body]),
    now: () => clock.now,
    newSessionId: () => `sid-${++sid}`,
    probeMs: 20,
  });
  return { queue, awaits, compassWaits, lockProbes, opened, notes, notified, clock, openResult };
}

/** Aspetta che le promesse e i timer della coda abbiano girato. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('messa in coda: risposta col sessionId e la scadenza, attesa su compass, nessuno spawn', async () => {
  const h = harness();
  const r = await h.queue.enqueue(req(), PLAN);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.queued, JSON.stringify(r));
  if (r.ok || !r.queued) return;
  assert.deepEqual(r.queued, {
    sessionId: 'sid-1',
    task: 'T9',
    kind: 'preflight',
    model: 'opus',
    prompt: '/loom-works:preflight-task T9',
    regia: null,
    expiresAt: new Date(T0 + QUEUE_TTL_MS).toISOString(),
  });
  assert.match(r.reason, /^in coda: finestra del progetto non in focus \(demo\)/);
  assert.equal(h.awaits.length, 1);
  assert.deepEqual(
    { projectId: h.awaits[0]!.projectId, notice: h.awaits[0]!.notice, deadlineS: h.awaits[0]!.deadlineS },
    { projectId: 'demo', notice: 'spawn in attesa: T9 preflight', deadlineS: QUEUE_TTL_MS / 1000 },
  );
  assert.equal(h.opened.length, 0, 'il binding lo scrive lo spawn vero, che non è partito');
  assert.match(h.notes.at(-1)!, /^⏳ T9 preflight in coda: .* \(scade alle \d\d:\d\d\)$/);
  assert.deepEqual(h.queue.pending(), [{ sessionId: 'sid-1', task: 'T9', state: 'waiting' }]);
});

test('compass senza AwaitProjectFocus, o canale caduto subito: rifiuto come T198, niente in coda', async () => {
  const cases: Array<[CompassReply, RegExp]> = [
    [
      { unreachable: 'GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Method AwaitProjectFocus is not implemented' },
      /Coda non disponibile: compass senza AwaitProjectFocus, da aggiornare$/,
    ],
    [{ unreachable: 'GDBus.Error:…ServiceUnknown' }, /Coda non disponibile: attesa del focus caduta: .*ServiceUnknown$/],
    [{ word: 'ignoto' }, /Coda non disponibile: compass non conosce il progetto$/],
  ];
  for (const [early, re] of cases) {
    const h = harness();
    const pending = h.queue.enqueue(req(), PLAN);
    h.awaits[0]!.reply(early);
    const r = await pending;
    assert.equal(r.ok, false);
    if (r.ok) continue;
    assert.equal(r.queued, undefined, JSON.stringify(early));
    assert.match(r.reason, /^finestra del progetto non in focus \(demo\)/);
    assert.match(r.reason, re);
    assert.deepEqual(h.queue.pending(), []);
    assert.equal(h.opened.length, 0);
  }
});

test('il focus torna fra il no e l’attesa: risposta in coda, e la tab nasce subito col sessionId annunciato', async () => {
  const h = harness();
  const pending = h.queue.enqueue(req(), PLAN);
  h.awaits[0]!.reply({ word: 'si' });
  const r = await pending;
  assert.ok(!r.ok && r.queued);
  await settle();
  assert.deepEqual(h.opened, [{ task: 'T9', sessionId: 'sid-1' }]);
  assert.match(h.notes.at(-1)!, /^✔ T9 preflight aperta dalla coda \(sid-1\)$/);
});

test('ritorno del focus: tutte le richieste si aprono in ordine d’arrivo, col loro sessionId', async () => {
  const h = harness();
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10', kind: 'run', scope: [1, 3] }), { ...PLAN, kind: 'run' });
  await h.queue.enqueue(req({ task: 'T11' }), PLAN);
  assert.equal(h.awaits.length, 3);
  assert.equal(h.awaits[1]!.notice, 'spawn in attesa: T10 run DLV 1,3');
  // Risponde per prima l'attesa della seconda: si aprono lo stesso tutte, in
  // ordine d'arrivo, e le attese ancora aperte si interrompono.
  h.awaits[1]!.reply({ word: 'si' });
  await settle(5);
  assert.deepEqual(h.opened, [
    { task: 'T9', sessionId: 'sid-1' },
    { task: 'T10', sessionId: 'sid-2' },
    { task: 'T11', sessionId: 'sid-3' },
  ]);
  assert.equal(h.awaits[0]!.stopped, true);
  assert.equal(h.awaits[2]!.stopped, true);
  // Le risposte tardive delle attese interrotte non riaprono niente.
  h.awaits[0]!.reply({ word: 'si' });
  h.awaits[2]!.reply({ unreachable: 'timeout (SIGTERM)' });
  await settle(5);
  assert.equal(h.opened.length, 3);
  assert.deepEqual(h.notified, []);
  assert.deepEqual(h.queue.pending(), []);
});

test('prima di ogni apertura ProjectFocused di nuovo: l’utente è già andato via, le restanti tornano in attesa', async () => {
  const answers: WindowCheck[] = [{ ok: true }, { refuse: 'finestra del progetto non in focus (demo)' }];
  const h = harness({ recheck: async () => answers.shift() ?? { ok: true } });
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.clock.now += 10 * 60 * 1000;
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.deepEqual(h.opened, [{ task: 'T9', sessionId: 'sid-1' }], 'la prima apre, la seconda trova il focus altrove');
  assert.equal(h.awaits.length, 3, 'una attesa nuova per la richiesta tornata in coda');
  assert.equal(h.awaits[2]!.deadlineS, 20 * 60, 'con la scadenza che le resta');
  assert.deepEqual(h.queue.pending(), [{ sessionId: 'sid-2', task: 'T10', state: 'waiting' }]);
  h.awaits[2]!.reply({ word: 'si' });
  await settle(5);
  assert.deepEqual(h.opened.at(-1), { task: 'T10', sessionId: 'sid-2' });
});

test('compass sparito all’apertura: nessuna tab alla cieca, la richiesta muore con nota e notifica', async () => {
  const h = harness({ recheck: async () => ({ warning: 'finestra non verificata (compass non raggiungibile: ServiceUnknown): …' }) });
  await h.queue.enqueue(req(), PLAN);
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.opened.length, 0);
  assert.match(h.notes.at(-1)!, /^⚠ T9 preflight tolto dalla coda: finestra non verificabile all'apertura: /);
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0]![0], QUEUE_NOTIFY_TITLE);
  assert.match(h.notified[0]![1], /^demo: T9 preflight annullato — /);
});

test('la task è cambiata in coda: il piano di adesso fallisce, la richiesta muore col suo motivo', async () => {
  const h = harness({ replan: () => ({ ok: false, reason: 'DLV già chiusi in T9: 1' }) });
  await h.queue.enqueue(req({ kind: 'run', scope: [1] }), { ...PLAN, kind: 'run' });
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.opened.length, 0);
  assert.match(h.notes.at(-1)!, /tolto dalla coda: DLV già chiusi in T9: 1$/);
});

test('scadenza: compass risponde scaduta, nessuna tab, nota e notifica della scadenza', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN);
  h.clock.now += QUEUE_TTL_MS;
  h.awaits[0]!.reply({ word: 'scaduta' });
  await settle();
  assert.equal(h.opened.length, 0);
  assert.equal(h.notes.at(-1), '⌛ T9 preflight scaduta in coda: nessuna tab aperta');
  assert.deepEqual(h.notified, [[QUEUE_NOTIFY_TITLE, 'demo: T9 preflight scaduto dopo 30 min in coda — nessuna tab aperta']]);
  assert.deepEqual(h.queue.pending(), []);
});

test('attesa caduta: prima della scadenza è un annullamento col motivo, dopo è la scadenza', async () => {
  const h = harness();
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.awaits[0]!.reply({ word: 'interrotta' });
  await settle();
  assert.match(h.notes.at(-1)!, /^⚠ T9 preflight tolto dalla coda: compass spento o ricaricato durante l'attesa$/);
  h.clock.now += QUEUE_TTL_MS + 61_000;
  h.awaits[1]!.reply({ unreachable: 'timeout (SIGTERM)' });
  await settle();
  assert.equal(h.notes.at(-1), '⌛ T10 preflight scaduta in coda: nessuna tab aperta');
  assert.equal(h.opened.length, 0);
});

test('il deck si chiude: le attese si interrompono, nessuna notifica, le risposte tardive si ignorano', async () => {
  const h = harness();
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.queue.stop();
  assert.deepEqual(
    h.awaits.map((a) => a.stopped),
    [true, true],
  );
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.notified, []);
  const r = await h.queue.enqueue(req({ task: 'T11' }), PLAN);
  assert.ok(!r.ok && !r.queued, 'un deck fermato non mette più in coda');
});

test('la tab che esce dalla coda non si apre: nota e notifica col motivo', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN);
  h.openResult.next = { ok: false, reason: 'deck-run uscito con 2 prima di aprire la tab' };
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.opened.length, 1);
  assert.match(h.notes.at(-1)!, /^⚠ T9 preflight dalla coda, tab non aperta: deck-run uscito con 2/);
  assert.equal(h.notified.length, 1);
});

test('spawnLabel: task, kind effettivo e perimetro', () => {
  assert.equal(spawnLabel(req(), { kind: 'recap-task' }), 'T9 recap-task');
  assert.equal(spawnLabel(req({ kind: 'run', scope: [2, 4] }), { kind: 'run' }), 'T9 run DLV 2,4');
});

// T234 — lo schermo bloccato.

test('T234 richiesta a schermo bloccato: in coda col sessionId, attesa del ritorno di compass, nessuna domanda a compass', async () => {
  const h = harness();
  const r = await h.queue.enqueue(req(), PLAN, 'locked');
  assert.ok(!r.ok && r.queued, JSON.stringify(r));
  if (r.ok || !r.queued) return;
  assert.equal(r.queued.sessionId, 'sid-1');
  assert.equal(r.queued.expiresAt, new Date(T0 + QUEUE_TTL_MS).toISOString(), 'la scadenza di T229 (D2)');
  assert.match(r.reason, /^in coda: schermo bloccato \(demo\), allo sblocco la tab nasce quando una finestra del progetto è in focus \(scade alle \d\d:\d\d\)$/);
  assert.equal(h.awaits.length, 0, 'compass è spento: AwaitProjectFocus non si chiede');
  assert.deepEqual(h.compassWaits.map((w) => w.deadlineS), [QUEUE_TTL_MS / 1000]);
  assert.match(h.notes.at(-1)!, /^⏳ T9 preflight in coda: schermo bloccato, allo sblocco/);
  assert.deepEqual(h.notified, [], 'nessuna notifica alla messa in coda (D1)');
  assert.deepEqual(h.queue.pending(), [{ sessionId: 'sid-1', task: 'T9', state: 'locked' }]);
  assert.equal(h.opened.length, 0);
});

test('T234 sblocco: compass torna, la richiesta aspetta il focus con la scadenza che resta, e nasce al si', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN, 'locked');
  h.clock.now += 12 * 60 * 1000;
  h.compassWaits[0]!.reply({ back: true });
  assert.equal(h.awaits.length, 1, 'AwaitProjectFocus allo sblocco: «Vai» se la finestra è di un altro progetto');
  assert.deepEqual(
    { projectId: h.awaits[0]!.projectId, notice: h.awaits[0]!.notice, deadlineS: h.awaits[0]!.deadlineS },
    { projectId: 'demo', notice: 'spawn in attesa: T9 preflight', deadlineS: 18 * 60 },
  );
  assert.deepEqual(h.queue.pending(), [{ sessionId: 'sid-1', task: 'T9', state: 'waiting' }]);
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.deepEqual(h.opened, [{ task: 'T9', sessionId: 'sid-1' }]);
});

test('T234 schermo bloccato oltre la scadenza: nessuna tab, nota e notifica della scadenza', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN, 'locked');
  // `gdbus wait` conta in secondi interi: una fine a ridosso della scadenza è la scadenza.
  h.clock.now += QUEUE_TTL_MS - 500;
  h.compassWaits[0]!.reply({ unreachable: 'exit 1' });
  await settle();
  assert.equal(h.opened.length, 0);
  assert.equal(h.notes.at(-1), '⌛ T9 preflight scaduta in coda: nessuna tab aperta');
  assert.equal(h.notified.length, 1);
  assert.deepEqual(h.queue.pending(), []);
});

test('T234 attesa dello sblocco caduta prima della scadenza: la richiesta muore col motivo', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN, 'locked');
  h.compassWaits[0]!.reply({ unreachable: 'ENOENT' });
  await settle();
  assert.match(h.notes.at(-1)!, /^⚠ T9 preflight tolto dalla coda: attesa dello sblocco caduta: ENOENT$/);
  assert.equal(h.notified.length, 1);
  assert.equal(h.opened.length, 0);
});

test('T234 lo schermo si blocca con richieste in coda: interrotta, lo shell dice bloccato, restano in coda fino allo sblocco (D3)', async () => {
  const h = harness({ screenLocked: async () => true });
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.clock.now += 5 * 60 * 1000;
  h.awaits[0]!.reply({ word: 'interrotta' });
  h.awaits[1]!.reply({ word: 'interrotta' });
  await settle(5);
  assert.equal(h.lockProbes.count, 1, 'lo stesso blocco, una domanda sola allo shell');
  assert.deepEqual(
    h.queue.pending().map((p) => p.state),
    ['locked', 'locked'],
  );
  assert.deepEqual(h.compassWaits.map((w) => w.deadlineS), [25 * 60, 25 * 60]);
  assert.match(h.notes.at(-1)!, /^🔒 T10 preflight: schermo bloccato, resta in coda fino allo sblocco \(scade alle \d\d:\d\d\)$/);
  assert.deepEqual(h.notified, []);
  // Allo sblocco, finestra del progetto in focus: la tab nasce subito (D1).
  h.compassWaits[0]!.reply({ back: true });
  h.compassWaits[1]!.reply({ back: true });
  h.awaits[2]!.reply({ word: 'si' });
  await settle(5);
  assert.deepEqual(h.opened, [
    { task: 'T9', sessionId: 'sid-1' },
    { task: 'T10', sessionId: 'sid-2' },
  ]);
});

test('T234 interrotta a schermo sbloccato (compass reload): la richiesta muore come in T229', async () => {
  const h = harness({ screenLocked: async () => false });
  await h.queue.enqueue(req(), PLAN);
  h.awaits[0]!.reply({ word: 'interrotta' });
  await settle(5);
  assert.equal(h.lockProbes.count, 1);
  assert.equal(h.compassWaits.length, 0);
  assert.match(h.notes.at(-1)!, /^⚠ T9 preflight tolto dalla coda: compass spento o ricaricato durante l'attesa$/);
  assert.equal(h.notified.length, 1);
});

test('T234 il focus arriva mentre lo shell risponde: la richiesta si apre, la risposta del blocco si ignora', async () => {
  let answer: (locked: boolean) => void = () => {};
  const h = harness({ screenLocked: () => new Promise((r) => (answer = r)) });
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.awaits[0]!.reply({ word: 'interrotta' });
  await settle();
  h.awaits[1]!.reply({ word: 'si' });
  await settle(5);
  answer(true);
  await settle(5);
  assert.deepEqual(
    h.opened.map((o) => o.task),
    ['T9', 'T10'],
  );
  assert.equal(h.compassWaits.length, 0, 'nessuna attesa dello sblocco per una richiesta già aperta');
});

test('T234 lo schermo si blocca fra il ritorno del focus e l’apertura: le pronte aspettano lo sblocco (D3)', async () => {
  const h = harness({ recheck: async () => ({ locked: 'schermo bloccato (demo): …' }) });
  await h.queue.enqueue(req({ task: 'T9' }), PLAN);
  await h.queue.enqueue(req({ task: 'T10' }), PLAN);
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(
    h.queue.pending().map((p) => p.state),
    ['locked', 'locked'],
  );
  assert.equal(h.compassWaits.length, 2);
  assert.equal(h.lockProbes.count, 0, 'il controllo l’ha già detto');
  assert.deepEqual(h.notified, []);
});

test('T234 avviso all’apertura dentro la finestra in cui lo shell non dichiara ancora il blocco: lo shell lo conferma, in coda', async () => {
  const h = harness({
    recheck: async () => ({ warning: 'finestra non verificata (compass non raggiungibile: ServiceUnknown): …' }),
    screenLocked: async () => true,
  });
  await h.queue.enqueue(req(), PLAN);
  h.awaits[0]!.reply({ word: 'si' });
  await settle(5);
  assert.equal(h.lockProbes.count, 1);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.queue.pending(), [{ sessionId: 'sid-1', task: 'T9', state: 'locked' }]);
});

test('T234 il deck si chiude con richieste in attesa dello sblocco: le attese si interrompono, nessuna notifica', async () => {
  const h = harness();
  await h.queue.enqueue(req(), PLAN, 'locked');
  h.queue.stop();
  assert.equal(h.compassWaits[0]!.stopped, true);
  h.compassWaits[0]!.reply({ back: true });
  await settle(5);
  assert.equal(h.awaits.length, 0);
  assert.deepEqual(h.notified, []);
});
