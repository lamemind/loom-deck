// T196 — il trasporto dell'endpoint: richiesta e risposta sulla stessa
// connessione, secondo deck sullo stesso indirizzo, riavvio dopo un'uscita
// forzata, cartella dei socket non sicura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenEndpoint } from '../src/endpoint-server.js';
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

test('cartella dei socket leggibile da altri: l’endpoint non parte', { skip: unixOnly('permessi POSIX') }, async () => {
  const ep = freshEndpoint();
  mkdirSync(ep.dir!, { recursive: true });
  chmodSync(ep.dir!, 0o755);
  const r = await listenEndpoint(ep, echo);
  assert.equal(r.state, 'failed');
  assert.match((r as { reason: string }).reason, /accessibile ad altri/);
});
