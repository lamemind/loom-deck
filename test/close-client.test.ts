// T204 — `loom-deck-close`: argomenti, uscite, mittente, e lo scambio con un
// endpoint vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenEndpoint, type RequestHandlers } from '../src/endpoint-server.js';
import { callerSession, parseCloseArgs, runCloseClient } from '../src/close-client.js';
import { endpointFor, type CloseReply, type CloseRequest } from '../src/spawn-endpoint.js';
import { unixOnly } from './platform-gates.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ME = 'ffffffff-0000-4000-8000-000000000000';

function project(id = 'demo'): { root: string; env: Record<string, string> } {
  const base = mkdtempSync(join(tmpdir(), 'loom-cc-'));
  const root = join(base, 'p');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'loom-works.json'), JSON.stringify({ id, name: id }));
  const run = join(base, 'run');
  mkdirSync(run, { mode: 0o700 });
  return { root, env: { XDG_RUNTIME_DIR: run } };
}

async function client(
  argv: string[],
  p: { root: string; env: Record<string, string> },
  extraEnv: Record<string, string> = {},
  timeoutMs?: number,
) {
  let out = '';
  let err = '';
  const code = await runCloseClient(argv, {
    cwd: p.root,
    env: { ...p.env, ...extraEnv },
    platform: process.platform,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    timeoutMs,
  });
  return { code, out, err };
}

async function withDeck<T>(
  p: { root: string; env: Record<string, string> },
  close: (req: CloseRequest) => Promise<CloseReply>,
  fn: () => Promise<T>,
) {
  const handlers: RequestHandlers = { spawn: async () => ({ ok: false, reason: 'non qui' }), close };
  const r = await listenEndpoint(endpointFor(p.root, process.platform, p.env), handlers);
  assert.equal(r.state, 'listening');
  try {
    return await fn();
  } finally {
    if (r.state === 'listening') await r.close();
  }
}

test('argomenti: sessionId intero o prefisso, --root, aiuto', () => {
  assert.deepEqual(parseCloseArgs([SID.toUpperCase()]), { session: SID, root: null });
  assert.deepEqual(parseCloseArgs(['0a1b2c3d', '--root', '/r']), { session: '0a1b2c3d', root: '/r' });
  assert.deepEqual(parseCloseArgs(['-h']), { help: true });
  for (const argv of [[], ['0a1b2c3'], ['T12'], [SID, 'altro'], [SID, '--root'], [SID, '--force']]) {
    assert.ok('usage' in parseCloseArgs(argv), argv.join(' '));
  }
});

test('mittente: il sessionId della conversazione che chiama, solo se ben formato', () => {
  assert.equal(callerSession({ CLAUDE_CODE_SESSION_ID: ME }), ME);
  assert.equal(callerSession({ CLAUDE_CODE_SESSION_ID: 'boh' }), undefined);
  assert.equal(callerSession({}), undefined);
});

test('errore d’uso: uscita 2, nessuna connessione', async () => {
  const r = await client(['T12'], project());
  assert.equal(r.code, 2);
  assert.match(r.err, /sessionId non valido: 'T12'/);
  assert.match(r.err, /^uso: loom-deck-close/m);
});

test('nessun deck sul progetto: uscita 3, il messaggio nomina le due versioni', async () => {
  const r = await client([SID], project());
  assert.equal(r.code, 3);
  assert.equal(r.out, '');
  assert.match(r.err, /nessun deck in ascolto per .*p \(.*loom-deck-demo-[0-9a-f]{8}.*, ENOENT\)/);
  assert.match(r.err, /l'endpoint c'è da loom-deck 0\.87\.0, la chiusura da 0\.88\.0/);
});

test('chiusa: uscita 0, la richiesta porta il mittente, stdout dice sessione, task e processo', async () => {
  const p = project();
  let seen: CloseRequest | null = null;
  const r = await withDeck(
    p,
    async (req) => {
      seen = req;
      return { ok: true, sessionId: SID, pid: 4242, task: 'T9', how: 'SIGHUP', ms: 380 };
    },
    () => client(['0a1b2c3d'], p, { CLAUDE_CODE_SESSION_ID: ME }),
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen, { verb: 'close', session: '0a1b2c3d', from: ME });
  assert.match(r.out, /^✔ conversazione chiusa dal deck di /);
  assert.match(r.out, /^sessionId: 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d$/m);
  assert.match(r.out, /^task: +T9$/m);
  assert.match(r.out, /^processo: +pid 4242 · SIGHUP · finito in 0\.4 s$/m);
});

test('chiusa con avviso e spot: uscita 0, l’avviso su stdout', async () => {
  const p = project();
  const r = await withDeck(
    p,
    async () => ({ ok: true, sessionId: SID, pid: 1, task: null, how: 'SIGHUP', ms: 0, warning: 'marca live non ritirata' }),
    () => client([SID], p),
  );
  assert.equal(r.code, 0);
  assert.match(r.out, /^task: +\(spot\)$/m);
  assert.match(r.out, /^⚠ marca live non ritirata$/m);
});

test('rifiuto e processo non terminato: uscita 1 col motivo del deck', async () => {
  const p = project();
  const refused = await withDeck(
    p,
    async () => ({ ok: false, reason: '0a1b2c3d: sta lavorando (busy): si chiude solo ferma' }),
    () => client([SID], p),
  );
  assert.equal(refused.code, 1);
  assert.match(refused.err, /il deck ha rifiutato: 0a1b2c3d: sta lavorando \(busy\)/);

  const stuck = await withDeck(
    p,
    async () => ({ ok: false, reason: '0a1b2c3d: processo 9 non terminato entro 10 s', sessionId: SID, pid: 9 }),
    () => client([SID], p),
  );
  assert.equal(stuck.code, 1);
  assert.match(stuck.err, /non terminato entro 10 s/);
});

test('deck 0.87.0 (endpoint senza close): uscita 1, il messaggio nomina la versione da cui c’è', async () => {
  const p = project();
  const r = await withDeck(
    p,
    async () => ({ ok: false, reason: 'verbo ignoto: "close" (solo spawn)' }),
    () => client([SID], p),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /più vecchio di loom-deck 0\.88\.0: aggiornalo/);
});

test('deck che non risponde: uscita 1 allo scadere dell’attesa', async () => {
  const p = project();
  const r = await withDeck(p, () => new Promise(() => {}), () => client([SID], p, {}, 100));
  assert.equal(r.code, 1);
  assert.match(r.err, /nessuna risposta dal deck entro/);
});

// Su Windows l'endpoint è una named pipe: né XDG_RUNTIME_DIR né il limite di
// byte del path di un socket Unix esistono lì.
test('cartella runtime troppo lunga: uscita 1 col motivo, nessuna connessione a un path troncato', { skip: unixOnly('limite di 107 byte del path di un socket Unix') }, async () => {
  const p = project();
  const r = await client([SID], { root: p.root, env: { XDG_RUNTIME_DIR: `/tmp/${'x'.repeat(100)}` } });
  assert.equal(r.code, 1);
  assert.match(r.err, /oltre i 107 byte di un socket Unix: cartella runtime troppo lunga/);
});
