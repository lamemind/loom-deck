// T196 — `loom-deck-spawn`: argomenti, uscite, e lo scambio con un endpoint vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenEndpoint, type RequestHandler } from '../src/endpoint-server.js';
import { parseClientArgs, runClient } from '../src/spawn-client.js';
import { endpointFor, type SpawnRequest } from '../src/spawn-endpoint.js';

/** Un progetto con file di progetto e una cartella runtime propria per i
 *  socket: ogni test ha il suo indirizzo. */
function project(id = 'demo'): { root: string; env: Record<string, string> } {
  const base = mkdtempSync(join(tmpdir(), 'loom-cl-'));
  const root = join(base, 'p');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'loom-works.json'), JSON.stringify({ id, name: id }));
  const run = join(base, 'run');
  mkdirSync(run, { mode: 0o700 });
  return { root, env: { XDG_RUNTIME_DIR: run } };
}

async function client(argv: string[], p: { root: string; env: Record<string, string> }, cwd = p.root, timeoutMs?: number) {
  let out = '';
  let err = '';
  const code = await runClient(argv, {
    cwd,
    env: p.env,
    platform: process.platform,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    timeoutMs,
  });
  return { code, out, err };
}

async function withDeck<T>(p: { root: string; env: Record<string, string> }, handle: RequestHandler, fn: () => Promise<T>) {
  const r = await listenEndpoint(endpointFor(p.root, process.platform, p.env), handle);
  assert.equal(r.state, 'listening');
  try {
    return await fn();
  } finally {
    if (r.state === 'listening') await r.close();
  }
}

test('argomenti: kind, perimetro solo con run, modello e nota', () => {
  assert.deepEqual(parseClientArgs(['T5', 'preflight']), {
    request: { verb: 'spawn', task: 'T5', kind: 'preflight' },
    root: null,
  });
  assert.deepEqual(parseClientArgs(['T5', 'run', '1,3-4', '--model', 'haiku', '--note', 'x', '--root', '/r']), {
    request: { verb: 'spawn', task: 'T5', kind: 'run', scope: [1, 3, 4], model: 'haiku', note: 'x' },
    root: '/r',
  });
  assert.deepEqual(parseClientArgs(['--help']), { help: true });
  const bad: string[][] = [
    [],
    ['T5'],
    ['5', 'run'],
    ['T5', 'bogus'],
    ['T5', 'preflight', '1'],
    ['T5', 'run', '3-1'],
    ['T5', 'run', '1', 'extra'],
    ['T5', 'run', '--model', 'gpt'],
    ['T5', 'run', '--model'],
    ['T5', 'run', '--force'],
  ];
  for (const argv of bad) assert.ok('usage' in parseClientArgs(argv), argv.join(' '));
});

test('errore d’uso: uscita 2, nessuna connessione', async () => {
  const p = project();
  const r = await client(['T5', 'bogus'], p);
  assert.equal(r.code, 2);
  assert.match(r.err, /kind ignoto/);
  assert.match(r.err, /^uso: loom-deck-spawn/m);
});

test('nessun deck sul progetto: uscita 3 e un messaggio che nomina root e versione', async () => {
  const p = project();
  const r = await client(['T5', 'preflight'], p);
  assert.equal(r.code, 3);
  assert.equal(r.out, '');
  assert.match(r.err, /nessun deck in ascolto per .*p \(.*loom-deck-demo-[0-9a-f]{8}.*, ENOENT\)/);
  assert.match(r.err, /loom-deck 0\.87\.0/);
});

test('tab aperta: uscita 0, sessionId, titolo e comando in-tab su stdout', async () => {
  const p = project();
  let seen: SpawnRequest | null = null;
  const r = await withDeck(
    p,
    async (req) => {
      seen = req;
      return {
        ok: true,
        sessionId: 'sid-9',
        task: req.task,
        kind: req.kind,
        model: 'fable',
        prompt: '/loom-works:run-task T5 DLV 2',
        title: '🧪 demo · T5 🚀 x',
        inTab: "LOOM_TASK=T5 claude --name '🧪 demo · T5 🚀 x'",
      };
    },
    () => client(['T5', 'run', 'DLV 2'], p),
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen, { verb: 'spawn', task: 'T5', kind: 'run', scope: [2] });
  assert.match(r.out, /^✔ tab aperta dal deck di /);
  assert.match(r.out, /^sessionId: sid-9$/m);
  assert.match(r.out, /^task: +T5 · run · fable$/m);
  assert.match(r.out, /^prompt: +\/loom-works:run-task T5 DLV 2$/m);
  assert.match(r.out, /^titolo: +🧪 demo · T5 🚀 x$/m);
  assert.match(r.out, /^in-tab: +LOOM_TASK=T5 claude/m);
});

test('da una sottocartella il client risale alla root del progetto', async () => {
  const p = project();
  const sub = join(p.root, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = await withDeck(
    p,
    async () => ({ ok: false, reason: 'raggiunto' }),
    () => client(['T5', 'preflight'], p, sub),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /il deck ha rifiutato: raggiunto/);
});

test('rifiuto del deck: uscita 1 col motivo; spawn inerte: uscita 0 e avviso', async () => {
  const p = project();
  const refused = await withDeck(
    p,
    async () => ({ ok: false, reason: 'T5 non è nella lista task del progetto' }),
    () => client(['T5', 'preflight'], p),
  );
  assert.equal(refused.code, 1);
  assert.match(refused.err, /il deck ha rifiutato: T5 non è nella lista task/);

  const inert = await withDeck(
    p,
    async (req) => ({
      ok: true,
      sessionId: 's',
      task: req.task,
      kind: req.kind,
      model: 'opus',
      prompt: '',
      title: null,
      inTab: null,
      inert: true,
    }),
    () => client(['T5', 'none'], p),
  );
  assert.equal(inert.code, 0);
  assert.match(inert.out, /^⚠ spawn inerte/);
  assert.match(inert.out, /^prompt: +\(nessuno\)$/m);
  assert.doesNotMatch(inert.out, /in-tab/);
});

test('deck che non risponde: uscita 1 allo scadere dell’attesa', async () => {
  const p = project();
  const r = await withDeck(
    p,
    () => new Promise(() => {}),
    () => client(['T5', 'preflight'], p, p.root, 100),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /nessuna risposta dal deck entro/);
});

test('due progetti, due deck: ogni richiesta arriva al deck del proprio progetto', async () => {
  const a = project('alfa');
  const b = { ...project('beta'), env: a.env }; // stessa cartella runtime, come sulla macchina vera
  const reply = (who: string) => async (req: SpawnRequest) => ({ ok: false as const, reason: `${who}:${req.task}` });
  await withDeck(a, reply('alfa'), () =>
    withDeck(b, reply('beta'), async () => {
      assert.match((await client(['T1', 'preflight'], a)).err, /rifiutato: alfa:T1/);
      assert.match((await client(['T2', 'preflight'], b)).err, /rifiutato: beta:T2/);
    }),
  );
});
