// T196 — il trasporto dell'endpoint: richiesta e risposta sulla stessa
// connessione, secondo deck sullo stesso indirizzo, riavvio dopo un'uscita
// forzata, cartella dei socket non sicura. T216 — il guardiano: attesa,
// subentro, gara persa, `failed` senza ritentativo, `stop` in volo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepEndpoint, listenEndpoint, type KeeperEvent } from '../src/endpoint-server.js';
import type { Endpoint, SpawnReply } from '../src/spawn-endpoint.js';
import { unixOnly } from './platform-gates.js';

let seq = 0;
/** Un indirizzo nuovo per ogni test: named pipe su Windows, socket in una
 *  cartella 0700 altrove. */
function freshEndpoint(): Endpoint {
  const name = `loom-deck-test-${process.pid}-${++seq}`;
  if (process.platform === 'win32') return { name, address: `\\\\.\\pipe\\${name}`, dir: null };
  const dir = join(mkdtempSync(join(tmpdir(), 'loom-ep-')), 'sock');
  return { name, address: join(dir, `${name}.sock`), dir };
}

function call(address: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(address);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(line));
    s.on('data', (c: string) => (buf += c));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}

const echo = async (req: { task: string; kind: string }): Promise<SpawnReply> => ({
  ok: true,
  sessionId: `sid-${req.task}`,
  task: req.task,
  kind: req.kind as 'run',
  model: 'opus',
  prompt: '',
  title: 't',
  inTab: 'c',
});

test('una riga di richiesta, una riga di risposta sulla stessa connessione', async () => {
  const ep = freshEndpoint();
  const r = await listenEndpoint(ep, echo);
  assert.equal(r.state, 'listening');
  try {
    const out = await call(ep.address, '{"verb":"spawn","task":"T5","kind":"run"}\n');
    assert.ok(out.endsWith('\n'));
    assert.deepEqual(JSON.parse(out), await echo({ task: 'T5', kind: 'run' }));
  } finally {
    if (r.state === 'listening') r.close();
  }
});

test('una richiesta malformata riceve ok:false col motivo, e il deck resta in ascolto', async () => {
  const ep = freshEndpoint();
  const r = await listenEndpoint(ep, echo);
  try {
    const bad = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"x","kind":"run"}\n'));
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /task non valida/);
    const good = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T1","kind":"run"}\n'));
    assert.equal(good.ok, true);
  } finally {
    if (r.state === 'listening') r.close();
  }
});

test('T204 — dispatch per verbo: close al gestore close, spawn al gestore spawn', async () => {
  const ep = freshEndpoint();
  const seen: string[] = [];
  const r = await listenEndpoint(ep, {
    spawn: async (req) => {
      seen.push(`spawn ${req.task}`);
      return echo(req);
    },
    close: async (req) => {
      seen.push(`close ${req.session}`);
      return { ok: true, sessionId: req.session, pid: 7, task: null, how: 'SIGHUP', ms: 1 };
    },
  });
  try {
    const c = JSON.parse(await call(ep.address, '{"verb":"close","session":"0a1b2c3d"}\n'));
    assert.deepEqual(c, { ok: true, sessionId: '0a1b2c3d', pid: 7, task: null, how: 'SIGHUP', ms: 1 });
    const s = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T4","kind":"run"}\n'));
    assert.equal(s.sessionId, 'sid-T4');
    const bad = JSON.parse(await call(ep.address, '{"verb":"close","session":"zz"}\n'));
    assert.match(bad.reason, /sessione non valida/);
    assert.deepEqual(seen, ['close 0a1b2c3d', 'spawn T4']);
  } finally {
    if (r.state === 'listening') await r.close();
  }
});

test('un gestore di solo spawn (forma di T196): close riceve un rifiuto, non un deck caduto', async () => {
  const ep = freshEndpoint();
  const r = await listenEndpoint(ep, echo);
  try {
    const c = JSON.parse(await call(ep.address, '{"verb":"close","session":"0a1b2c3d"}\n'));
    assert.equal(c.ok, false);
    assert.match(c.reason, /close non servito/);
  } finally {
    if (r.state === 'listening') await r.close();
  }
});

test('un gestore che lancia diventa una risposta, non un deck caduto', async () => {
  const ep = freshEndpoint();
  const r = await listenEndpoint(ep, async () => {
    throw new Error('boom');
  });
  try {
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T1","kind":"run"}\n'));
    assert.equal(out.ok, false);
    assert.match(out.reason, /boom/);
  } finally {
    if (r.state === 'listening') r.close();
  }
});

test('secondo deck sullo stesso indirizzo: busy, e il primo continua a rispondere', async () => {
  const ep = freshEndpoint();
  const first = await listenEndpoint(ep, echo);
  assert.equal(first.state, 'listening');
  try {
    const second = await listenEndpoint(ep, echo);
    assert.equal(second.state, 'busy');
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T2","kind":"run"}\n'));
    assert.equal(out.sessionId, 'sid-T2');
  } finally {
    if (first.state === 'listening') first.close();
  }
});

test('chiusura pulita: nessun residuo, e un deck nuovo ascolta sullo stesso indirizzo', async () => {
  const ep = freshEndpoint();
  const a = await listenEndpoint(ep, echo);
  assert.equal(a.state, 'listening');
  if (a.state === 'listening') a.close();
  await new Promise((res) => setTimeout(res, 50));
  if (ep.dir !== null) assert.equal(existsSync(ep.address), false, 'il file del socket resta dopo close()');
  const b = await listenEndpoint(ep, echo);
  assert.equal(b.state, 'listening');
  if (b.state === 'listening') b.close();
});

test('deck ucciso a forza: chi chiama riceve un rifiuto, il deck nuovo ascolta al primo colpo', async () => {
  // Il deck "vecchio" è un processo vero, ucciso con SIGKILL: su Linux il file
  // del socket resta, su Windows la pipe muore col processo.
  const ep = freshEndpoint();
  if (ep.dir !== null) mkdirSync(ep.dir, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer(()=>{}).listen(${JSON.stringify(ep.address)},()=>console.log('up'))`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((res) => child.stdout!.once('data', () => res()));
  child.kill('SIGKILL');
  await new Promise((res) => child.once('exit', res));
  if (ep.dir !== null) assert.ok(existsSync(ep.address), 'su Linux il socket orfano resta come file');
  await assert.rejects(call(ep.address, '{}\n'), (e: NodeJS.ErrnoException) =>
    ['ECONNREFUSED', 'ENOENT'].includes(e.code ?? ''),
  );
  const r = await listenEndpoint(ep, echo);
  assert.equal(r.state, 'listening');
  try {
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T3","kind":"run"}\n'));
    assert.equal(out.sessionId, 'sid-T3');
  } finally {
    if (r.state === 'listening') r.close();
  }
});

test('T204 — path del socket troppo lungo: l’endpoint non parte, invece di ascoltare su un path troncato', { skip: unixOnly('socket Unix') }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'loom-ep-')), 'x'.repeat(120));
  const ep: Endpoint = { name: 'lungo', address: join(dir, 'lungo.sock'), dir };
  const r = await listenEndpoint(ep, echo);
  assert.equal(r.state, 'failed');
  assert.match((r as { reason: string }).reason, /oltre i 107 byte/);
  assert.equal(existsSync(dir), false, 'nessuna cartella né socket creati');
});

test('cartella dei socket leggibile da altri: l’endpoint non parte', { skip: unixOnly('permessi POSIX') }, async () => {
  const ep = freshEndpoint();
  mkdirSync(ep.dir!, { recursive: true });
  chmodSync(ep.dir!, 0o755);
  const r = await listenEndpoint(ep, echo);
  assert.equal(r.state, 'failed');
  assert.match((r as { reason: string }).reason, /accessibile ad altri/);
});

// ── T216 — il guardiano ─────────────────────────────────────────────────────

/** Il giro del guardiano nei test: corto, perché i casi chiedono più giri. */
const TICK = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('attesa scaduta');
    await sleep(10);
  }
}

/** Timer e server aperti nel processo: dopo `stop` devono tornare quelli di
 *  prima, o qualcosa terrebbe vivo il deck. */
function openHandles(): string {
  const kinds = process.getActiveResourcesInfo().filter((k) => k === 'Timeout' || k === 'PipeServerWrap');
  return kinds.sort().join(',');
}

/** Un deck "vecchio" in un processo vero: ascolta sull'indirizzo come faceva il
 *  deck prima di T216, direttamente sul path. */
async function oldDeck(ep: Endpoint) {
  if (ep.dir !== null) mkdirSync(ep.dir, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer(()=>{}).listen(${JSON.stringify(ep.address)},()=>console.log('up'))`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((res) => child.stdout!.once('data', () => res()));
  return child;
}

test('T216 — col primo deck vivo il secondo resta busy, e lo dice una volta sola', async () => {
  const ep = freshEndpoint();
  const first = await listenEndpoint(ep, echo);
  assert.equal(first.state, 'listening');
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  try {
    await sleep(TICK * 8);
    assert.deepEqual(events, [{ kind: 'busy' }]);
    // L'indirizzo resta del primo.
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T6","kind":"run"}\n'));
    assert.equal(out.sessionId, 'sid-T6');
    if (first.state === 'listening') assert.equal(first.owns(), true);
  } finally {
    await keeper.stop();
    if (first.state === 'listening') await first.close();
  }
});

test('T216 — chiuso il primo deck, il secondo subentra entro due giri', async () => {
  const ep = freshEndpoint();
  const first = await listenEndpoint(ep, echo);
  assert.equal(first.state, 'listening');
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  try {
    await until(() => events.length === 1);
    if (first.state === 'listening') await first.close();
    const closedAt = Date.now();
    await until(() => events.length === 2);
    assert.ok(Date.now() - closedAt <= TICK * 2 + 200, `subentro dopo ${Date.now() - closedAt} ms`);
    assert.deepEqual(events, [{ kind: 'busy' }, { kind: 'listening', waited: true }]);
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T7","kind":"run"}\n'));
    assert.equal(out.sessionId, 'sid-T7');
  } finally {
    await keeper.stop();
  }
});

test('T216 — deck vecchio morto di SIGHUP: il secondo sostituisce l’orfano e subentra', async () => {
  const ep = freshEndpoint();
  const child = await oldDeck(ep);
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  try {
    await until(() => events.length === 1);
    assert.deepEqual(events, [{ kind: 'busy' }]);
    const orphan = ep.dir !== null ? statSync(ep.address, { bigint: true }).ino : null;
    // La tab chiusa: SIGHUP, che termina senza l'evento `exit`. Windows non ha
    // segnali, e la pipe muore col processo comunque lo si termini.
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGHUP');
    await new Promise((res) => child.once('exit', res));
    await until(() => events.length === 2);
    assert.deepEqual(events[1], { kind: 'listening', waited: true });
    // Su Linux il file dell'indirizzo non è più l'orfano: è il socket nuovo.
    // I due inode esistono insieme al momento del `rename`, quindi differiscono.
    if (orphan !== null) assert.notEqual(statSync(ep.address, { bigint: true }).ino, orphan);
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T8","kind":"run"}\n'));
    assert.equal(out.sessionId, 'sid-T8');
  } finally {
    await keeper.stop();
  }
});

test('T216 — gara persa: chi perde il file torna in attesa senza cancellare quello dell’altro, e subentra dopo', { skip: unixOnly('socket Unix come file') }, async () => {
  const ep = freshEndpoint();
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  // L'altro deck della gara: il suo socket arriva sull'indirizzo dopo il nostro.
  const other = net.createServer((c) => c.on('data', () => c.end('{"other":true}\n')));
  try {
    await until(() => events.length === 1);
    assert.deepEqual(events, [{ kind: 'listening', waited: false }]);
    const otherAt = join(ep.dir!, 'altro.sock');
    await new Promise<void>((res) => other.listen(otherAt, () => res()));
    renameSync(otherAt, ep.address);
    await until(() => events.length === 2);
    assert.deepEqual(events[1], { kind: 'lost' });
    // Il file dell'altro resta, e i client arrivano all'altro.
    await sleep(TICK * 3);
    assert.ok(existsSync(ep.address), 'chi ha perso la gara ha cancellato il socket dell’altro');
    const out = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T9","kind":"run"}\n'));
    assert.deepEqual(out, { other: true });
    // Finché l'altro vive, nessun subentro.
    assert.equal(events.length, 2);
    // L'altro si chiude: il suo file resta orfano (era legato su un altro path),
    // e il nostro lo sostituisce.
    await new Promise<void>((res) => other.close(() => res()));
    await until(() => events.length === 3);
    assert.deepEqual(events[2], { kind: 'listening', waited: true });
    const back = JSON.parse(await call(ep.address, '{"verb":"spawn","task":"T10","kind":"run"}\n'));
    assert.equal(back.sessionId, 'sid-T10');
  } finally {
    await keeper.stop();
    if (other.listening) other.close();
  }
});

test('T216 — uno stato failed non si ritenta', { skip: unixOnly('permessi POSIX') }, async () => {
  const ep = freshEndpoint();
  mkdirSync(ep.dir!, { recursive: true });
  chmodSync(ep.dir!, 0o755);
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  try {
    await sleep(TICK * 8);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'failed');
    assert.match((events[0] as { reason: string }).reason, /accessibile ad altri/);
    assert.equal(existsSync(ep.address), false);
  } finally {
    await keeper.stop();
  }
});

test('T216 — stop con un listen in volo: il server appena aperto si chiude, nessun timer resta', async () => {
  const ep = freshEndpoint();
  const before = openHandles();
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  await keeper.stop();
  assert.equal(openHandles(), before);
  await sleep(TICK * 4);
  assert.deepEqual(events, [], 'nessun evento dopo stop');
  if (ep.dir !== null) assert.equal(existsSync(ep.address), false, 'il socket resta dopo stop');
  await assert.rejects(call(ep.address, '{}\n'));
});

test('T216 — stop in attesa: il timer si ferma, e chiuso il primo nessuno subentra', async () => {
  const ep = freshEndpoint();
  const first = await listenEndpoint(ep, echo);
  assert.equal(first.state, 'listening');
  const before = openHandles();
  const events: KeeperEvent[] = [];
  const keeper = keepEndpoint(ep, echo, TICK, (e) => events.push(e));
  await until(() => events.length === 1);
  await keeper.stop();
  assert.equal(openHandles(), before);
  if (first.state === 'listening') await first.close();
  await sleep(TICK * 4);
  assert.deepEqual(events, [{ kind: 'busy' }]);
  await assert.rejects(call(ep.address, '{}\n'));
});
