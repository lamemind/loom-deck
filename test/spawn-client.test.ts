// T196 — `loom-deck-spawn`: argomenti, uscite, e lo scambio con un endpoint vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenEndpoint, type RequestHandler } from '../src/endpoint-server.js';
import { parseClientArgs, queuedLines, orchestratorSessionOf, runClient } from '../src/spawn-client.js';
import { endpointFor, type SpawnReply, type SpawnRequest } from '../src/spawn-endpoint.js';

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

// T220 — l'orchestrator dichiarato con --orchestrator; la sua sessione il client la legge
// dal proprio ambiente, e solo se è un sessionId intero.
const ORCHESTRATOR_SID = '0a1b2c3d-1111-2222-3333-444455556666';

test('argomenti: --orchestrator, con la sessione dell’orchestrator letta dall’ambiente', () => {
  assert.deepEqual(parseClientArgs(['T5', 'run', '--orchestrator', 'T197'], { CLAUDE_CODE_SESSION_ID: ORCHESTRATOR_SID }), {
    request: { verb: 'spawn', task: 'T5', kind: 'run', orchestrator: 'T197', orchestratorSession: ORCHESTRATOR_SID },
    root: null,
  });
  assert.deepEqual(parseClientArgs(['T5', 'run', '--orchestrator', 'T197']), {
    request: { verb: 'spawn', task: 'T5', kind: 'run', orchestrator: 'T197' },
    root: null,
  });
  // La sessione senza --orchestrator non parte: chi non si dichiara orchestrator non lo è.
  assert.deepEqual(parseClientArgs(['T5', 'run'], { CLAUDE_CODE_SESSION_ID: ORCHESTRATOR_SID }), {
    request: { verb: 'spawn', task: 'T5', kind: 'run' },
    root: null,
  });
  assert.ok('usage' in parseClientArgs(['T5', 'run', '--orchestrator', 'epica']));
  assert.ok('usage' in parseClientArgs(['T5', 'run', '--orchestrator']));
  assert.equal(orchestratorSessionOf({ CLAUDE_CODE_SESSION_ID: '0a1b2c3d' }), null, 'un prefisso non è una sessione');
  assert.equal(orchestratorSessionOf({}), null);
});

// T221 — il kind orchestrator: il successore di un passaggio di consegne, chiesto
// dall'orchestrator stesso, che il client nomina dal proprio ambiente.
test('argomenti: kind orchestrator porta chi passa le consegne, e senza la sessione è un errore d’uso', () => {
  assert.deepEqual(parseClientArgs(['T197', 'orchestrator'], { CLAUDE_CODE_SESSION_ID: ORCHESTRATOR_SID }), {
    request: { verb: 'spawn', task: 'T197', kind: 'orchestrator', from: ORCHESTRATOR_SID },
    root: null,
  });
  const missing = parseClientArgs(['T197', 'orchestrator']);
  assert.ok('usage' in missing);
  assert.match(missing.usage[0]!, /kind orchestrator: serve CLAUDE_CODE_SESSION_ID/);
});

test('orchestrator: la marca sull’orchestrator che passa le consegne nella riga consegne', async () => {
  const p = project();
  let seen: SpawnRequest | null = null;
  const env = { ...p.env, CLAUDE_CODE_SESSION_ID: ORCHESTRATOR_SID };
  const r = await withDeck(
    p,
    async (req) => {
      seen = req;
      return {
        ok: true as const,
        sessionId: 'nuova',
        task: req.task,
        kind: req.kind,
        model: 'opus' as const,
        prompt: '/loom-works:orchestrate-mandate T197',
        title: 't',
        inTab: 'c',
        orchestrator: null,
        handoff: ORCHESTRATOR_SID,
      };
    },
    () => client(['T197', 'orchestrator'], { root: p.root, env }),
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen, { verb: 'spawn', task: 'T197', kind: 'orchestrator', from: ORCHESTRATOR_SID });
  assert.match(r.out, new RegExp(`^consegne: +${ORCHESTRATOR_SID} marcata origin orchestrator, chiudibile dal successore$`, 'm'));
});

test('orchestrator: riportato dal deck nella sua riga; un deck vecchio che lo ignora dà l’avviso, uscita 0', async () => {
  const p = project();
  const reply = (req: SpawnRequest, orchestrator?: string | null) => ({
    ok: true as const,
    sessionId: 's',
    task: req.task,
    kind: req.kind,
    model: 'opus' as const,
    prompt: '',
    title: 't',
    inTab: 'c',
    ...(orchestrator === undefined ? {} : { orchestrator }),
  });
  let seen: SpawnRequest | null = null;
  const env = { ...p.env, CLAUDE_CODE_SESSION_ID: ORCHESTRATOR_SID };
  const known = await withDeck(
    p,
    async (req) => {
      seen = req;
      return reply(req, 'T197');
    },
    () => client(['T5', 'none', '--orchestrator', 'T197'], { root: p.root, env }),
  );
  assert.equal(known.code, 0, known.err);
  assert.deepEqual(seen, { verb: 'spawn', task: 'T5', kind: 'none', orchestrator: 'T197', orchestratorSession: ORCHESTRATOR_SID });
  assert.match(known.out, /^orchestrator: +T197 \(LOOM_ORCHESTRATOR\)$/m);
  assert.doesNotMatch(known.out, /⚠/);

  const old = await withDeck(p, async (req) => reply(req), () => client(['T5', 'none', '--orchestrator', 'T197'], p));
  assert.equal(old.code, 0, 'la tab esiste già');
  assert.match(old.out, /^⚠ LOOM_ORCHESTRATOR non impostata: il deck acceso è più vecchio, riavvialo$/m);
  assert.doesNotMatch(old.out, /^orchestrator:/m);

  // Scartata di proposito (kind orchestrator, P3): `orchestrator: null`, nessun avviso.
  const dropped = await withDeck(p, async (req) => reply(req, null), () => client(['T5', 'none', '--orchestrator', 'T197'], p));
  assert.doesNotMatch(dropped.out, /⚠|^orchestrator:/m);
  // Nessun orchestrator chiesto, nessun avviso anche da un deck vecchio.
  const plain = await withDeck(p, async (req) => reply(req), () => client(['T5', 'none'], p));
  assert.doesNotMatch(plain.out, /⚠/);
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

// T198 — il rifiuto per la finestra arriva com'è, istruzione compresa; la tab
// aperta senza verifica porta l'avviso subito sotto la prima riga.
test('finestra del progetto: rifiuto con l’istruzione, o tab aperta con l’avviso', async () => {
  const p = project();
  const refused = await withDeck(
    p,
    async () => ({
      ok: false,
      reason:
        'finestra del progetto non in focus (demo): la tab nascerebbe nella finestra di un altro progetto. Porta davanti una finestra del progetto e richiedi lo spawn',
    }),
    () => client(['T5', 'preflight'], p),
  );
  assert.equal(refused.code, 1);
  assert.match(refused.err, /il deck ha rifiutato: finestra del progetto non in focus \(demo\)/);
  assert.match(refused.err, /Porta davanti una finestra del progetto e richiedi lo spawn/);
  assert.equal(refused.out, '');

  const warned = await withDeck(
    p,
    async (req) => ({
      ok: true,
      sessionId: 's',
      task: req.task,
      kind: req.kind,
      model: 'opus',
      prompt: '',
      title: 't',
      inTab: 'c',
      warning: 'finestra non verificata (compass non raggiungibile: ENOENT): la tab nasce nella finestra di terminale attiva',
    }),
    () => client(['T5', 'none'], p),
  );
  assert.equal(warned.code, 0);
  const lines = warned.out.split('\n');
  assert.match(lines[0]!, /^✔ tab aperta/);
  assert.equal(
    lines[1],
    '⚠ finestra non verificata (compass non raggiungibile: ENOENT): la tab nasce nella finestra di terminale attiva',
  );
});

// T229 — la richiesta in coda: uscita 4, sessionId e scadenza su stdout, niente
// titolo; il motivo «in coda» resta per i client più vecchi, che escono 1.
test('richiesta in coda: uscita 4, sessionId, task, prompt, orchestrator e scadenza su stdout', async () => {
  const p = project();
  const expires = new Date(Date.UTC(2026, 10, 20, 17, 30, 0));
  const queuedReply = (req: SpawnRequest): SpawnReply => ({
    ok: false,
    reason: 'in coda: finestra del progetto non in focus (demo), la tab nasce quando …',
    queued: {
      sessionId: '0a1b2c3d-1111-2222-3333-444455556666',
      task: req.task,
      kind: req.kind,
      model: 'opus',
      prompt: '/loom-works:preflight-task T5',
      orchestrator: 'T197',
      expiresAt: expires.toISOString(),
    },
  });
  let out = '';
  let err = '';
  const code = await withDeck(p, async (req) => queuedReply(req as SpawnRequest), () =>
    runClient(['T5', 'preflight', '--orchestrator', 'T197'], {
      cwd: p.root,
      env: p.env,
      platform: process.platform,
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      now: () => expires.getTime() - 30 * 60_000,
    }),
  );
  assert.equal(code, 4);
  assert.equal(err, '');
  const lines = out.trimEnd().split('\n');
  // T234 — la prima riga porta il motivo del deck, senza il suo `in coda: `.
  assert.match(lines[0]!, /^⏳ in coda sul deck di .*: finestra del progetto non in focus \(demo\), la tab nasce quando …$/);
  assert.deepEqual(lines.slice(1, 5), [
    'sessionId: 0a1b2c3d-1111-2222-3333-444455556666',
    'task:      T5 · preflight · opus',
    'prompt:    /loom-works:preflight-task T5',
    'orchestrator:     T197 (LOOM_ORCHESTRATOR)',
  ]);
  assert.match(lines[5]!, /^scade: {5}\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \(fra 30 min\)$/);
  assert.equal(new Date(lines[5]!.slice(11, 36)).getTime(), expires.getTime(), 'l’ora locale è la stessa scadenza');
  assert.ok(!out.includes('titolo:'), 'in coda il titolo non esiste ancora');
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

// T234 — a schermo bloccato la stessa forma, col motivo del deck nella prima
// riga: chi ha chiesto dice all'utente che la tab aspetta lo sblocco.
test('richiesta in coda a schermo bloccato: la prima riga dice lo sblocco, il resto non cambia', () => {
  const expires = new Date(Date.UTC(2026, 10, 20, 17, 30, 0));
  const lines = queuedLines(
    {
      sessionId: '0a1b2c3d-1111-2222-3333-444455556666',
      task: 'T5',
      kind: 'run',
      model: 'opus',
      prompt: '/loom-works:run-task T5',
      orchestrator: null,
      expiresAt: expires.toISOString(),
    },
    '/progetti/demo',
    expires.getTime() - 12 * 60_000,
    'in coda: schermo bloccato (demo), allo sblocco la tab nasce quando una finestra del progetto è in focus (scade alle 18:30)',
  );
  assert.equal(
    lines[0],
    '⏳ in coda sul deck di /progetti/demo: schermo bloccato (demo), allo sblocco la tab nasce quando una finestra del progetto è in focus (scade alle 18:30)',
  );
  assert.deepEqual(lines.slice(1, 4), [
    'sessionId: 0a1b2c3d-1111-2222-3333-444455556666',
    'task:      T5 · run · opus',
    'prompt:    /loom-works:run-task T5',
  ]);
  assert.match(lines[4]!, /^scade: {5}.* \(fra 12 min\)$/);
  assert.equal(lines.length, 5);
});
