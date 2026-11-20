// T196 — l'indirizzo dell'endpoint e il protocollo: le due regole che server e
// client devono calcolare uguali.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addressProblem,
  endpointFor,
  endpointName,
  normalizeSession,
  parseEndpointRequest,
  parseScope,
  parseSpawnRequest,
  socketDir,
} from '../src/spawn-endpoint.js';
import { unixOnly } from './platform-gates.js';

function project(id: string | null, parent = mkdtempSync(join(tmpdir(), 'loom-ep-'))): string {
  const root = join(parent, 'progetto');
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (id !== null) writeFileSync(join(root, '.claude', 'loom-works.json'), JSON.stringify({ id, name: id }));
  return root;
}

test('nome: id del file più 8 caratteri di hash, stabile sulla stessa root', () => {
  const root = project('loom-works');
  const name = endpointName(root);
  assert.match(name, /^loom-deck-loom-works-[0-9a-f]{8}$/);
  assert.equal(endpointName(root), name);
});

test('stesso id, root diverse (il worktree di una lane): nomi diversi', () => {
  // P1 preflight — il file di progetto è committato, quindi il worktree porta
  // lo stesso `id`: a distinguere i due deck è l'hash del path.
  const a = endpointName(project('loom-works'));
  const b = endpointName(project('loom-works'));
  assert.notEqual(a, b);
  assert.equal(a.slice(0, -8), b.slice(0, -8));
});

test('senza file di progetto: il nome della cartella al posto dell’id', () => {
  assert.match(endpointName(project(null)), /^loom-deck-progetto-[0-9a-f]{8}$/);
});

test('id con caratteri fuori alfabeto o troppo lungo: ripulito e tagliato', () => {
  const name = endpointName(project(`a b/c\\d:${'x'.repeat(80)}`));
  assert.match(name, /^loom-deck-a_b_c_d_x+-[0-9a-f]{8}$/);
  assert.ok(name.length <= 'loom-deck-'.length + 40 + 9, name);
});

test('una root raggiunta da un symlink ha il nome della root vera', { skip: unixOnly('symlink di cartella') }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'loom-ep-'));
  const root = project('demo', parent);
  const link = join(parent, 'scorciatoia');
  symlinkSync(root, link);
  assert.equal(endpointName(link), endpointName(root));
});

test('Windows: la stessa cartella con grafie diverse dà lo stesso nome', () => {
  // NTFS non distingue le maiuscole, e la forma di confronto è minuscola: il
  // deck avviato da Windows Terminal e il client da VS Code arrivano allo
  // stesso nome. Qui il path non esiste, quindi nessun realpath lo normalizza:
  // lo fa solo `comparablePath`.
  assert.equal(endpointName('C:\\Lavoro\\Demo', 'win32'), endpointName('c:/lavoro/demo/', 'win32'));
});

test('indirizzo: named pipe su Windows, socket in $XDG_RUNTIME_DIR/loom-deck altrove', () => {
  const root = project('demo');
  const win = endpointFor(root, 'win32');
  assert.equal(win.address, `\\\\.\\pipe\\${win.name}`);
  assert.equal(win.dir, null);
  const lin = endpointFor(root, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.equal(lin.dir, '/run/user/1000/loom-deck');
  assert.equal(lin.address, `/run/user/1000/loom-deck/${lin.name}.sock`);
});

test('senza $XDG_RUNTIME_DIR: una cartella per utente nella temporanea', () => {
  assert.match(socketDir({}), /loom-deck-\d+$/);
});

test('il path del socket sta sotto il limite di 107 byte anche con un id lungo', () => {
  const lin = endpointFor(project('x'.repeat(200)), 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.ok(Buffer.byteLength(lin.address) < 107, lin.address);
});

test('T204 — un socket oltre 107 byte è un problema che nomina la causa; una pipe no', () => {
  const root = project('demo');
  const short = endpointFor(root, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.equal(addressProblem(short), null);
  const long = endpointFor(root, 'linux', { XDG_RUNTIME_DIR: `/tmp/${'x'.repeat(90)}` });
  assert.match(addressProblem(long)!, /path del socket di \d+ byte, oltre i 107 .*cartella runtime troppo lunga/);
  assert.equal(addressProblem(endpointFor(root, 'win32', {})), null);
});

test('richiesta valida: verbo, task, kind e i campi opzionali', () => {
  assert.deepEqual(parseSpawnRequest('{"verb":"spawn","task":"T7","kind":"preflight"}'), {
    verb: 'spawn',
    task: 'T7',
    kind: 'preflight',
  });
  assert.deepEqual(
    parseSpawnRequest(JSON.stringify({ verb: 'spawn', task: 'T7', kind: 'run', scope: [4, 2, 2], model: 'haiku', note: 'n' })),
    { verb: 'spawn', task: 'T7', kind: 'run', scope: [2, 4], model: 'haiku', note: 'n' },
  );
});

const REGIA_SID = '0a1b2c3d-1111-2222-3333-444455556666';

// T220 — la regia che chiede lo spawn, e la sua sessione in minuscolo.
test('richiesta con la regia: perimetro e sessione della regia', () => {
  assert.deepEqual(
    parseSpawnRequest(JSON.stringify({ verb: 'spawn', task: 'T7', kind: 'run', regia: 'T197', regiaSession: REGIA_SID.toUpperCase() })),
    { verb: 'spawn', task: 'T7', kind: 'run', regia: 'T197', regiaSession: REGIA_SID },
  );
  assert.deepEqual(parseSpawnRequest(JSON.stringify({ verb: 'spawn', task: 'T7', kind: 'run', regia: 'T197' })), {
    verb: 'spawn',
    task: 'T7',
    kind: 'run',
    regia: 'T197',
  });
});

test('richieste rifiutate nella forma, col motivo', () => {
  const cases: Array<[unknown, RegExp]> = [
    ['non json', /non è JSON/],
    [[1], /non è un oggetto/],
    [{ verb: 'kill', task: 'T1', kind: 'run' }, /verbo ignoto/],
    [{ verb: 'spawn', task: 'T1; rm', kind: 'run' }, /task non valida/],
    [{ verb: 'spawn', task: 'T1', kind: 'bogus' }, /kind ignoto/],
    [{ verb: 'spawn', task: 'T1', kind: 'preflight', scope: [1] }, /solo con kind run/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', scope: [] }, /perimetro non valido/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', scope: [0] }, /perimetro non valido/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', model: 'gpt' }, /modello ignoto/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', note: 'a\nb' }, /nota non valida/],
    // T220 — la regia è un id di task, la sua sessione un sessionId intero.
    [{ verb: 'spawn', task: 'T1', kind: 'run', regia: 'epica' }, /regia non valida/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', regia: 197 }, /regia non valida/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', regiaSession: REGIA_SID }, /regiaSession senza regia/],
    [{ verb: 'spawn', task: 'T1', kind: 'run', regia: 'T197', regiaSession: '0a1b2c3d' }, /sessione della regia non valida/],
  ];
  for (const [raw, re] of cases) {
    const r = parseSpawnRequest(typeof raw === 'string' ? raw : JSON.stringify(raw));
    assert.ok('error' in r, JSON.stringify(raw));
    assert.match(r.error, re);
  }
});

test('close: sessionId intero o prefisso ≥ 8, minuscolo; mittente opzionale', () => {
  const sid = '0A1B2C3D-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.deepEqual(parseEndpointRequest(JSON.stringify({ verb: 'close', session: sid })), {
    verb: 'close',
    session: sid.toLowerCase(),
  });
  assert.deepEqual(parseEndpointRequest('{"verb":"close","session":"0a1b2c3d","from":"ffffffff-0000"}'), {
    verb: 'close',
    session: '0a1b2c3d',
    from: 'ffffffff-0000',
  });
  assert.equal(normalizeSession(' 0a1b2c3d '), '0a1b2c3d');
});

test('close rifiutate nella forma, col motivo; spawn passa dallo stesso smistatore', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ verb: 'close' }, /sessione non valida/],
    [{ verb: 'close', session: '0a1b2c3' }, /almeno 8 caratteri/],
    [{ verb: 'close', session: '0a1b2c3d; rm -rf' }, /sessione non valida/],
    [{ verb: 'close', session: 'x'.repeat(8) }, /sessione non valida/],
    [{ verb: 'close', session: '0'.repeat(37) }, /sessione non valida/],
    [{ verb: 'close', session: '0a1b2c3d', from: 'io' }, /mittente non valido/],
    [{ verb: 'kill', session: '0a1b2c3d' }, /verbo ignoto: "kill" \(usa spawn\|close\)/],
  ];
  for (const [raw, re] of cases) {
    const r = parseEndpointRequest(JSON.stringify(raw));
    assert.ok('error' in r, JSON.stringify(raw));
    assert.match(r.error, re);
  }
  assert.equal(
    (parseEndpointRequest('{"verb":"spawn","task":"T1","kind":"run"}') as { verb: string }).verb,
    'spawn',
  );
  const notSpawn = parseSpawnRequest('{"verb":"close","session":"0a1b2c3d"}');
  assert.ok('error' in notSpawn && /non di spawn/.test(notSpawn.error));
});

test('perimetro: la grammatica di run-task, con o senza DLV in testa', () => {
  assert.deepEqual(parseScope('1,3-5'), [1, 3, 4, 5]);
  assert.deepEqual(parseScope('DLV 2,4'), [2, 4]);
  assert.deepEqual(parseScope(' 5 , 1 '), [1, 5]);
  for (const bad of ['', 'DLV', 'a', '3-1', '0', '1,,2', '1-2000']) {
    assert.ok('error' in (parseScope(bad) as object), bad);
  }
});
