// T204 — dalla richiesta di chiusura alla fine del processo: le guardie prima
// di toccare qualunque processo, l'attesa della fine, la marca live ritirata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSABLE_STATES,
  handleCloseRequest,
  resolveTarget,
  stateProblem,
  type CloseRequestDeps,
  type Terminator,
} from '../src/endpoint-close.js';
import type { LiveSession } from '../src/live-sessions.js';
import type { CloseRequest } from '../src/spawn-endpoint.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const A2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const B = 'bbbbbbbb-3333-4333-8333-333333333333';
const ME = 'cccccccc-4444-4444-8444-444444444444';

function live(sessionId: string, pid: number, state = 'idle'): LiveSession {
  return {
    sessionId,
    pid,
    status: state === 'busy' ? 'busy' : 'idle',
    state,
    procStart: `${pid}0`,
    name: 'n',
    cwd: '/p',
    startedAt: 0,
  };
}

/** Un terminatore finto: il processo muore dopo `diesAfter` misure di
 *  liveness successive alla terminazione, o mai. */
function fakeTerm(diesAfter: number | null, failure: string | null = null) {
  const calls = { terminated: [] as number[], probes: 0 };
  let left = diesAfter;
  let started = false;
  const term: Terminator = {
    how: 'SIGHUP',
    terminate: (t) => {
      calls.terminated.push(t.pid);
      started = failure === null;
      return failure;
    },
    alive: () => {
      calls.probes++;
      if (!started || left === null) return true;
      if (left <= 0) return false;
      left--;
      return true;
    },
  };
  return { term, calls };
}

function deps(over: Partial<CloseRequestDeps> & { term?: Terminator } = {}) {
  const retired: string[] = [];
  let clock = 0;
  const d: CloseRequestDeps = {
    closeOff: () => null,
    terminator: () => over.term ?? fakeTerm(2).term,
    live: () => new Map([[A, live(A, 101)], [A2, live(A2, 102)], [B, live(B, 103, 'busy')], [ME, live(ME, 104)]]),
    sidecar: () => ({ endpointBorn: new Set([A, A2, B, ME]), bindings: new Map([[A, 'T9']]) }),
    retire: (sid) => retired.push(sid),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { d, retired };
}

const req = (session: string, from?: string): CloseRequest => (from ? { verb: 'close', session, from } : { verb: 'close', session });

test('chiusura: terminazione, attesa della fine, marca live ritirata, task nella risposta', async () => {
  const { term, calls } = fakeTerm(2);
  const { d, retired } = deps({ term });
  const r = await handleCloseRequest(req(A), d);
  assert.deepEqual(r, { ok: true, sessionId: A, pid: 101, task: 'T9', how: 'SIGHUP', ms: 400 });
  assert.deepEqual(calls.terminated, [101]);
  assert.deepEqual(retired, [A], 'la marca si ritira nella chiusura stessa, non con l’isteresi');
});

test('conversazione spot: task null', async () => {
  const { d } = deps({ term: fakeTerm(0).term });
  const r = await handleCloseRequest(req(A2), d);
  assert.equal(r.ok, true);
  assert.equal((r as { task: string | null }).task, null);
});

test('processo che non termina: la risposta lo dice, porta il bersaglio, e la marca resta', async () => {
  const { term, calls } = fakeTerm(null);
  const { d, retired } = deps({ term, waitMs: 1_000, pollMs: 200 });
  const r = await handleCloseRequest(req(A), d);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /processo 101 non terminato entro 1 s dopo SIGHUP/);
  assert.equal((r as { sessionId?: string }).sessionId, A);
  assert.equal((r as { pid?: number }).pid, 101);
  assert.deepEqual(retired, []);
  assert.ok(calls.probes >= 5);
});

test('rifiuti prima di toccare un processo, col motivo', async () => {
  const cases: Array<[CloseRequest, Partial<CloseRequestDeps>, RegExp]> = [
    [req(A), { closeOff: () => 'chiusura delle conversazioni n/d su Windows' }, /n\/d su Windows/],
    [req(A), { terminator: () => ({ off: 'non ancora disponibile su Linux' }) }, /non ancora disponibile/],
    [req('dddddddd'), {}, /dddddddd: nessuna conversazione viva di questo progetto/],
    [req('aaaaaaaa'), {}, /prefisso ambiguo aaaaaaaa: 2 vive \(aaaaaaaa, aaaaaaaa\)/],
    [req(ME, ME), {}, /è la conversazione che chiede la chiusura/],
    [req(A), { sidecar: () => ({ endpointBorn: new Set(), bindings: new Map() }) }, /non è nata da una richiesta spawn/],
    [req(B), {}, /bbbbbbbb: sta lavorando \(busy\)/],
  ];
  for (const [r, over, re] of cases) {
    const { term, calls } = fakeTerm(0);
    const { d, retired } = deps({ term, ...over });
    const out = await handleCloseRequest(r, d);
    assert.equal(out.ok, false, re.source);
    assert.match((out as { reason: string }).reason, re);
    assert.deepEqual(calls.terminated, [], `${re.source}: nessun processo toccato`);
    assert.deepEqual(retired, []);
  }
});

test('conversazione nata dall’endpoint e non più viva: «già chiusa»', async () => {
  const gone = 'eeeeeeee-5555-4555-8555-555555555555';
  const { d } = deps({ sidecar: () => ({ endpointBorn: new Set([gone]), bindings: new Map() }) });
  const r = await handleCloseRequest(req(gone), d);
  assert.match((r as { reason: string }).reason, /non è viva \(già chiusa\)/);
});

test('un prefisso unico identifica la viva; il sessionId intero vince anche su un prefisso condiviso', async () => {
  const lv = new Map([[A, live(A, 1)], [B, live(B, 2)]]);
  assert.equal((resolveTarget('bbbbbbbb-33', lv) as { target: LiveSession }).target.sessionId, B);
  assert.deepEqual(resolveTarget('ffffffff', lv), { none: true });
  const twin = new Map([[A, live(A, 1)], [A2, live(A2, 2)]]);
  assert.equal((resolveTarget(A, twin) as { target: LiveSession }).target.sessionId, A);
});

test('stati: si chiudono idle e waiting, il resto si rifiuta — anche un valore nuovo', () => {
  assert.deepEqual([...CLOSABLE_STATES], ['idle', 'waiting']);
  assert.equal(stateProblem('idle'), null);
  assert.equal(stateProblem('waiting'), null);
  assert.match(stateProblem('busy')!, /busy/);
  assert.match(stateProblem('shell')!, /comando \(shell\)/);
  assert.match(stateProblem('')!, /non scrive lo stato/);
  assert.match(stateProblem('compacting')!, /«compacting» non previsto/);
});

test('una seconda richiesta sulla stessa conversazione mentre la prima aspetta: rifiutata', async () => {
  const { term, calls } = fakeTerm(3);
  const inFlight = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { d } = deps({ term, inFlight, sleep: () => gate });
  const first = handleCloseRequest(req(A), d);
  const second = await handleCloseRequest(req(A), d);
  assert.match((second as { reason: string }).reason, /chiusura già in corso/);
  release();
  assert.equal((await first).ok, true);
  assert.deepEqual(calls.terminated, [101]);
  assert.equal(inFlight.size, 0, 'la chiusura finita libera la conversazione');
});

test('terminazione fallita su un processo già finito: chiusa; su uno vivo: rifiuto', async () => {
  const dead: Terminator = { how: 'SIGHUP', terminate: () => 'ESRCH', alive: () => false };
  const { d, retired } = deps({ term: dead });
  const r = await handleCloseRequest(req(A), d);
  assert.equal(r.ok, true);
  assert.deepEqual(retired, [A]);

  const stuck: Terminator = { how: 'SIGHUP', terminate: () => 'EPERM', alive: () => true };
  const out = await handleCloseRequest(req(A), deps({ term: stuck }).d);
  assert.match((out as { reason: string }).reason, /terminazione non partita \(EPERM\)/);
});

test('marca live non ritirabile: chiusa lo stesso, con l’avviso', async () => {
  const { d } = deps({
    term: fakeTerm(0).term,
    retire: () => {
      throw new Error('EACCES');
    },
  });
  const r = await handleCloseRequest(req(A), d);
  assert.equal(r.ok, true);
  assert.match((r as { warning?: string }).warning!, /marca live non ritirata \(EACCES\)/);
});

test('attese: il client aspetta più del deck, sullo spawn e sulla chiusura', async () => {
  const { CLOSE_WAIT_MS } = await import('../src/endpoint-close.js');
  const { REPLY_TIMEOUT_MS } = await import('../src/endpoint-client.js');
  const { ANNOUNCE_TIMEOUT_MS } = await import('../src/endpoint-spawn.js');
  assert.equal(CLOSE_WAIT_MS, 30_000);
  assert.ok(REPLY_TIMEOUT_MS > CLOSE_WAIT_MS);
  assert.ok(REPLY_TIMEOUT_MS > ANNOUNCE_TIMEOUT_MS);
});
