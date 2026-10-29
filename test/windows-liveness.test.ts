import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindowsLiveness,
  parseStartTimes,
  pidExists,
  queryStartTimes,
  RETRY_MS,
  startTimeScript,
  type LivePair,
} from '../src/windows-liveness.js';
import { windowsOnly } from './platform-gates.js';

// Coppie vere della macchina Windows (T174, verdetto 2): `procStart` del
// registro, uguale al tick a `(Get-Process -Id <pid>).StartTime.ToFileTimeUtc()`.
const A: LivePair = { pid: 17192, procStart: '134371439599957616' };
const B: LivePair = { pid: 14984, procStart: '134371432653345923' };

const stdoutOf = (rows: [number, string][]): string =>
  rows.map(([pid, ft]) => `${pid} ${ft}\r\n`).join('') + 'OK\r\n';

/** Un verificatore con i processi e la query finti: `pids` è l'insieme dei pid
 *  che esistono, `starts` la risposta di `Get-Process`. */
function harness(starts: Map<number, string>, pids = new Set([A.pid, B.pid])) {
  const queries: number[][] = [];
  let clock = 0;
  let fail = false;
  const liveness = createWindowsLiveness({
    exists: (pid) => pids.has(pid),
    now: () => clock,
    query: async (asked) => {
      queries.push([...asked]);
      if (fail) throw new Error('powershell assente');
      return stdoutOf([...starts].filter(([pid]) => asked.includes(pid)));
    },
  });
  return {
    liveness,
    queries,
    pids,
    advance: (ms: number) => (clock += ms),
    failNext: (v: boolean) => (fail = v),
  };
}

test('startTimeScript: tutti i pid in una query, niente virgolette doppie', () => {
  const s = startTimeScript([A.pid, B.pid]);
  assert.match(s, /Get-Process -Id 17192,14984 /);
  assert.match(s, /ToFileTimeUtc\(\)/);
  // Senza virgolette doppie lo script passa intero come un argomento solo
  // nella riga di comando di Windows.
  assert.ok(!s.includes('"'));
  assert.match(s, /'OK'$/);
});

test('parseStartTimes tiene il FILETIME come stringa, cifra per cifra', () => {
  // Come numero, 134371439599957616 diventerebbe 134371439599957620: oltre
  // 2^53 un double perde le ultime cifre, e il confronto con procStart fallirebbe.
  const m = parseStartTimes(stdoutOf([[A.pid, A.procStart], [B.pid, B.procStart]]));
  assert.deepEqual(m, new Map([[A.pid, A.procStart], [B.pid, B.procStart]]));
});

test('parseStartTimes: senza la riga di chiusura lo stdout non vale', () => {
  // Uno stdout vuoto o tronco direbbe «tutti morti».
  assert.equal(parseStartTimes(''), null);
  assert.equal(parseStartTimes(`${A.pid} ${A.procStart}\r\n`), null);
  assert.deepEqual(parseStartTimes('OK\r\n'), new Map());
});

test('parseStartTimes ignora le righe che non sono pid + FILETIME', () => {
  const m = parseStartTimes(`WARNING: qualcosa\r\n${A.pid} ${A.procStart}\r\nOK`);
  assert.deepEqual(m, new Map([[A.pid, A.procStart]]));
});

test('coppia nuova: viva provvisoria, poi il verdetto della query', async () => {
  // B ha il pid giusto ma l'ora di avvio di un altro processo: pid riusato.
  const h = harness(new Map([[A.pid, A.procStart], [B.pid, '134371500000000000']]));
  assert.deepEqual(h.liveness.check([A, B]), [true, true]);
  assert.deepEqual(h.queries, [[A.pid, B.pid]], 'una query sola per tutte le coppie nuove');
  await h.liveness.settled();
  assert.deepEqual(h.liveness.check([A, B]), [true, false]);
  assert.equal(h.queries.length, 1, 'una coppia verificata non si rimisura');
});

test('pid assente dall output della query: morta', async () => {
  // Processo finito mentre la query partiva, o di un altro utente: StartTime
  // non leggibile, nessuna riga.
  const h = harness(new Map([[A.pid, A.procStart]]));
  h.liveness.check([A, B]);
  await h.liveness.settled();
  assert.deepEqual(h.liveness.check([A, B]), [true, false]);
});

test('pid che non esiste: morta subito, senza query', () => {
  const h = harness(new Map(), new Set());
  assert.deepEqual(h.liveness.check([A]), [false]);
  assert.equal(h.queries.length, 0);
});

test('conversazione chiusa: morta al giro dopo', async () => {
  const h = harness(new Map([[A.pid, A.procStart]]));
  h.liveness.check([A]);
  await h.liveness.settled();
  assert.deepEqual(h.liveness.check([A]), [true]);
  h.pids.delete(A.pid);
  assert.deepEqual(h.liveness.check([A]), [false]);
});

test('una coppia morta resta morta anche se il pid torna, senza query', async () => {
  // Kill a mano: il file di registro resta, il pid sparisce e un altro
  // processo lo riprende più tardi.
  const h = harness(new Map([[A.pid, A.procStart]]));
  h.liveness.check([A]);
  await h.liveness.settled();
  h.pids.delete(A.pid);
  h.liveness.check([A]);
  h.pids.add(A.pid);
  assert.deepEqual(h.liveness.check([A]), [false]);
  assert.equal(h.queries.length, 1);
});

test('una query alla volta: le coppie arrivate durante la query vanno nella successiva', async () => {
  const h = harness(new Map([[A.pid, A.procStart], [B.pid, B.procStart]]));
  h.liveness.check([A]);
  assert.deepEqual(h.liveness.check([A, B]), [true, true]);
  assert.deepEqual(h.queries, [[A.pid]]);
  await h.liveness.settled();
  h.liveness.check([A, B]);
  assert.deepEqual(h.queries, [[A.pid], [B.pid]]);
  await h.liveness.settled();
  assert.deepEqual(h.liveness.check([A, B]), [true, true]);
});

test('query fallita: resta la sola esistenza del pid, si riprova dopo RETRY_MS', async () => {
  const h = harness(new Map([[A.pid, '134371500000000000']]));
  h.failNext(true);
  h.liveness.check([A]);
  await h.liveness.settled();
  // Viva finché il pid esiste: la direzione d'errore che non toglie un
  // transcript a una conversazione aperta.
  assert.deepEqual(h.liveness.check([A]), [true]);
  assert.equal(h.queries.length, 1, 'nessun nuovo lancio prima del ritardo');
  h.failNext(false);
  h.advance(RETRY_MS);
  h.liveness.check([A]);
  assert.equal(h.queries.length, 2);
  await h.liveness.settled();
  assert.deepEqual(h.liveness.check([A]), [false]);
});

test('stdout senza riga di chiusura: vale come query fallita', async () => {
  const liveness = createWindowsLiveness({
    exists: () => true,
    now: () => 0,
    query: async () => '',
  });
  liveness.check([A]);
  await liveness.settled();
  assert.deepEqual(liveness.check([A]), [true]);
});

test('una coppia sparita dal registro si dimentica', async () => {
  const h = harness(new Map([[A.pid, A.procStart]]));
  h.liveness.check([A]);
  await h.liveness.settled();
  h.liveness.check([]);
  h.liveness.check([A]);
  assert.equal(h.queries.length, 2);
});

test('pidExists: il processo corrente esiste, un pid fuori range no', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(2_147_483_644), false);
});

test(
  'queryStartTimes: il FILETIME del processo corrente è la sua ora di avvio',
  { skip: windowsOnly('Get-Process via PowerShell') },
  async () => {
    const starts = parseStartTimes(await queryStartTimes([process.pid, 2_147_483_644]));
    assert.ok(starts, 'stdout senza riga di chiusura');
    assert.equal(starts.size, 1, 'il pid inesistente non ha riga');
    const filetime = BigInt(starts.get(process.pid)!);
    // FILETIME: intervalli di 100 ns dal 1601-01-01; 11644473600000 ms separano
    // quella data dall'epoch Unix.
    const startedMs = Number(filetime / 10_000n) - 11_644_473_600_000;
    const expectedMs = Date.now() - process.uptime() * 1000;
    assert.ok(Math.abs(startedMs - expectedMs) < 5000, `avvio ${startedMs} contro ${expectedMs}`);
  },
);
