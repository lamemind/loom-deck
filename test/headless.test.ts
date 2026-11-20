// T205 — `loom-deck-headless`: il turno headless senza tab. Ambiente e argv del
// turno, binding nel sidecar prima del processo, rifiuti, ripresa, esito dalle
// quattro classi, e il lancio staccato vero con un `claude` finto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// I transcript stanno sotto la home: il test la sposta su una cartella sua
// PRIMA di ogni lettura, o `transcriptIds` leggerebbe le conversazioni vere.
const HOME = mkdtempSync(join(tmpdir(), 'loom-hl-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.LOOM_DECK_DOCS_ROOT;

import {
  HEADLESS_DROP_ENV,
  HEADLESS_KEEP_MS,
  HEADLESS_ORPHAN_GRACE_MS,
  headlessArgs,
  headlessEnv,
  openHeadless,
  PENDING_MAX_MS,
  replyHeadless,
  resolveSession,
  staleHeadless,
  turnOutcome,
  type HeadlessIo,
  type LaunchOptions,
} from '../src/headless.js';
import { INHERITED_SESSION_ENV } from '../src/session-env.js';
import {
  classifyTurn,
  dropHeadlessState,
  errPath,
  headlessFiles,
  outPath,
  parseTurnOutput,
  readState,
  statePath,
  writeState,
  type HeadlessState,
} from '../src/headless-state.js';
import { HEADLESS_USAGE, parseHeadlessArgs, runHeadlessClient, statusText } from '../src/headless-client.js';
import { launchDetached } from '../src/headless-io.js';
import { parseLiveEntry, parseRegistryEntry, procRunning, procStartOf, sessionProcesses } from '../src/live-sessions.js';
import { projectDirName } from '../src/sessions.js';
import { loadSessionIndex, taskIndexPath } from '../src/task-index.js';
import { unixOnly } from './platform-gates.js';

const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const NOW = Date.parse('2026-11-17T10:00:00Z');

const TASK_TEXT = `# Task: demo

- **Size**: M

## Deliverables Checklist

- [x] primo
- [ ] secondo
`;

const MANDATE_TEXT = `# Task: mandato

- **Size**: Mandate

## Membri

- T9
`;

function project(cfg: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'loom-hl-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'loom-works.json'),
    JSON.stringify({ id: 'demo', emoji: '🧪', owner: 'LOCAL', name: 'demo', docsRoot: 'docs', permissionMode: 'auto', ...cfg }),
  );
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'tasks.md'),
    '# Tasks\n\n## Tasks Overview\n\n| ID | Pri | Prog | Task |\n| --- | --- | --- | --- |\n| T9 | ⚡ | 🔵 | Demo |\n| T10 | ⚡ | 🔵 | Mandato |\n',
  );
  writeFileSync(join(root, 'docs', 'tasks', 'T9-demo-task.md'), TASK_TEXT);
  writeFileSync(join(root, 'docs', 'tasks', 'T10-mandato.md'), MANDATE_TEXT);
  return root;
}

interface Launch {
  cmd: string;
  args: string[];
  opts: LaunchOptions;
  /** Il sidecar com'era nel momento del lancio. */
  sidecar: string;
}

/** L'ambiente di chi lancia: una regia dentro una tab del progetto. */
const REGIA_ENV: Record<string, string> = {
  PATH: '/usr/bin',
  PTYXIS_PROFILE: 'demo',
  LOOM_TASK: 'T1',
  PROJECT_ROOT: '/altrove',
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'regia',
  CLAUDE_EFFORT: 'xhigh',
  CLAUDE_CODE_MESSAGING_TOKEN: 'segreto',
  // T217 — l'inspector di Bun della regia: su Windows il turno che lo eredita
  // muore con EADDRINUSE prima di scrivere il transcript.
  BUN_INSPECT: 'ws://127.0.0.1:9222/',
  CLAUDE_CONFIG_DIR: '/cfg',
  CLAUDE_CODE_GIT_BASH_PATH: 'C:\\bash.exe',
};

function fakeIo(over: Partial<HeadlessIo> = {}): HeadlessIo & { launches: Launch[] } {
  const launches: Launch[] = [];
  return {
    env: REGIA_ENV,
    platform: 'linux',
    claude: { cmd: 'claude', prefix: [] },
    now: () => new Date(NOW),
    newId: () => SID,
    launch: async (cmd, args, opts) => {
      let sidecar = '';
      try {
        sidecar = readFileSync(taskIndexPath(opts.cwd), 'utf8');
      } catch {
        // nessun sidecar
      }
      launches.push({ cmd, args, opts, sidecar });
      return { pid: 4242 };
    },
    procStartOf: () => '777',
    running: () => false,
    processes: () => [],
    launches,
    ...over,
  };
}

const req = (task: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ verb: 'spawn', task, kind, ...extra }) as Parameters<typeof openHeadless>[0];

// ── ambiente e argv ────────────────────────────────────────────────────────

test('ambiente del turno: via i marcatori della conversazione, il profilo e il binding di chi lancia', () => {
  const env = headlessEnv(REGIA_ENV, { task: 'T9' }, 'linux');
  for (const k of HEADLESS_DROP_ENV) if (k !== 'LOOM_TASK') assert.equal(env[k], undefined, k);
  for (const k of INHERITED_SESSION_ENV) assert.ok(HEADLESS_DROP_ENV.includes(k), `${k} ereditata dal turno`);
  assert.equal(env.BUN_INSPECT, undefined);
  assert.equal(env.LOOM_TASK, 'T9');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg', 'la configurazione dell’utente passa');
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\bash.exe');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(headlessEnv(REGIA_ENV, { task: null }, 'linux').LOOM_TASK, undefined, 'una conversazione senza task non eredita la task di chi lancia');
});

test('argv del turno: -p, esito json, nessuno risponde ai permessi, -- prima del testo', () => {
  const args = headlessArgs(['--name', 'x', '--model', 'haiku'], '- comincia col trattino');
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--permission-prompts',
    'none',
    '--name',
    'x',
    '--model',
    'haiku',
    '--',
    '- comincia col trattino',
  ]);
});

// ── apertura ───────────────────────────────────────────────────────────────

test('open: binding, nota e modello nel sidecar PRIMA del processo; argv e stato come la tab', async () => {
  const root = project();
  const io = fakeIo();
  const r = await openHeadless(req('T9', 'preflight'), root, io);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(io.launches.length, 1);
  const l = io.launches[0]!;

  // il comando è claude, mai un terminale: nessuna tab, nessun focus
  assert.equal(l.cmd, 'claude');
  assert.ok(!l.args.some((a) => /ptyxis|wt\.exe/.test(a)));
  assert.equal(l.opts.cwd, root);

  // il binding c'era già quando il processo è partito
  const recs = l.sidecar.trim().split('\n').map((s) => JSON.parse(s));
  assert.deepEqual(recs.map((x) => Object.keys(x).filter((k) => k !== 'ts').sort().join(',')), [
    'sessionId,taskId',
    'note,sessionId',
    'model,sessionId',
  ]);
  assert.equal(recs[0].taskId, 'T9');
  assert.equal(loadSessionIndex(root).bindings.get(SID), 'T9');

  const a = l.args;
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'json', '--permission-prompts', 'none']);
  assert.equal(a[a.indexOf('--session-id') + 1], SID);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(a[a.indexOf('--model') + 1], 'fable', 'il modello di catalogo di preflight');
  assert.match(a[a.indexOf('--name') + 1]!, /^🧪 demo · T9 📐 demo task$/);
  assert.deepEqual(a.slice(-2), ['--', '/loom-works:preflight-task T9']);
  assert.equal(a.indexOf('--resume'), -1);

  assert.equal(l.opts.env.LOOM_TASK, 'T9');
  assert.equal(l.opts.env.PTYXIS_PROFILE, undefined);
  assert.equal(l.opts.env.CLAUDE_EFFORT, undefined);
  assert.equal(l.opts.outFile, outPath(root, SID));

  const st = readState(root, SID)!;
  assert.equal(st.pid, 4242);
  assert.equal(st.procStart, '777');
  assert.equal(st.turn, 1);
  assert.equal(st.kind, 'preflight');
  assert.equal(st.task, 'T9');
});

// T220 — un turno aperto da una regia porta LOOM_REGIA come una tab; il
// sidecar registra la regia prima del processo; una LOOM_REGIA di chi lancia
// non passa mai.
const REGIA_SID = '0a1b2c3d-1111-2222-3333-444455556666';

test('open --regia: LOOM_REGIA nel turno, regia e sessione nel sidecar prima del processo, regia nello stato', async () => {
  const root = project();
  const io = fakeIo({ env: { ...REGIA_ENV, LOOM_REGIA: 'T1' } });
  const r = await openHeadless(req('T9', 'preflight', { regia: 'T10', regiaSession: REGIA_SID }), root, io);
  assert.ok(r.ok, JSON.stringify(r));
  const l = io.launches[0]!;
  assert.equal(l.opts.env.LOOM_REGIA, 'T10');
  assert.equal(l.opts.env.LOOM_TASK, 'T9');
  const recs = l.sidecar.trim().split('\n').map((x) => JSON.parse(x));
  const regia = recs.find((x) => 'regia' in x);
  assert.deepEqual({ regia: regia.regia, regiaSession: regia.regiaSession, sessionId: regia.sessionId }, {
    regia: 'T10',
    regiaSession: REGIA_SID,
    sessionId: SID,
  });
  assert.equal(readState(root, SID)!.regia, 'T10');

  // Senza --regia: nessuna LOOM_REGIA, nemmeno quella di chi lancia.
  const root2 = project();
  const io2 = fakeIo({ env: { ...REGIA_ENV, LOOM_REGIA: 'T1' } });
  await openHeadless(req('T9', 'preflight'), root2, io2);
  assert.equal(io2.launches[0]!.opts.env.LOOM_REGIA, undefined);
  assert.doesNotMatch(io2.launches[0]!.sidecar, /"regia"/);
  assert.equal(readState(root2, SID)!.regia, undefined);
});

test('open --regia: una regia che non è un perimetro è un rifiuto, senza processo né sidecar', async () => {
  const root = project();
  const io = fakeIo();
  const r = await openHeadless(req('T9', 'preflight', { regia: 'T9' }), root, io);
  assert.deepEqual(r, { ok: false, reason: "regia T9: non è un'epica né un mandato" });
  assert.equal(io.launches.length, 0);
  assert.throws(() => readFileSync(taskIndexPath(root)));
});

test('open: override di progetto sul modello, perimetro del run in coda al prompt', async () => {
  const root = project({ spawn: { run: { model: 'haiku' } } });
  const io = fakeIo();
  const r = await openHeadless(req('T9', 'run', { scope: [2] }), root, io);
  assert.ok(r.ok, JSON.stringify(r));
  const a = io.launches[0]!.args;
  assert.equal(a[a.indexOf('--model') + 1], 'haiku');
  assert.equal(a.at(-1), '/loom-works:run-task T9 DLV 2');
});

test('open: recap si specializza come nel detail', async () => {
  const root = project();
  const io = fakeIo();
  await openHeadless(req('T10', 'recap'), root, io);
  assert.equal(io.launches[0]!.args.at(-1), '/loom-works:recap-status-epic T10');
});

test('open: rifiuti senza lanciare niente e senza scrivere il sidecar', async () => {
  const cases: Array<[Record<string, unknown>, ReturnType<typeof req>, RegExp]> = [
    [{}, req('T9', 'none'), /senza prompt/],
    [{}, req('T99', 'preflight'), /non è nella lista task/],
    [{}, req('T10', 'run'), /mandato/],
    [{}, req('T10', 'regia'), /regia: si apre dal detail/],
    [{}, req('T9', 'run', { scope: [1] }), /già chiusi/],
    [{ permissionMode: 'manual' }, req('T9', 'run'), /manual: run rifiutato/],
    [{ permissionMode: 'manual' }, req('T9', 'checkpoint'), /manual: checkpoint rifiutato/],
  ];
  for (const [cfg, request, reason] of cases) {
    const root = project(cfg);
    const io = fakeIo();
    const r = await openHeadless(request, root, io);
    assert.equal(r.ok, false, `${request.task} ${request.kind}`);
    if (!r.ok) assert.match(r.reason, reason);
    assert.equal(io.launches.length, 0);
    assert.throws(() => readFileSync(taskIndexPath(root)), 'nessun binding per un turno rifiutato');
  }
});

test('open su manual: preflight e recap passano, in manual', async () => {
  const root = project({ permissionMode: 'manual' });
  const io = fakeIo();
  const r = await openHeadless(req('T9', 'preflight'), root, io);
  assert.ok(r.ok);
  const a = io.launches[0]!.args;
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'manual');
});

test('open: un claude che non parte è un rifiuto, e lo stato lo dice', async () => {
  const root = project();
  const io = fakeIo({ launch: async () => ({ error: 'claude non lanciabile (ENOENT)' }) });
  const r = await openHeadless(req('T9', 'preflight'), root, io);
  assert.deepEqual(r, { ok: false, reason: 'claude non lanciabile (ENOENT)' });
  const st = readState(root, SID)!;
  assert.equal(st.pid, null);
  assert.equal(turnOutcome(root, st, io).cls, 'errore');
});

// ── risposta ───────────────────────────────────────────────────────────────

/** Un transcript della conversazione nella home del test. */
function transcript(root: string, sid: string, model = 'claude-sonnet-5-5') {
  const dir = join(HOME, '.claude', 'projects', projectDirName(root));
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', sessionId: sid, cwd: root, message: { role: 'user', content: 'ciao' }, timestamp: '2026-11-17T09:00:00Z' },
    { type: 'assistant', sessionId: sid, cwd: root, message: { role: 'assistant', model, content: [{ type: 'text', text: 'D1?' }] }, timestamp: '2026-11-17T09:00:05Z' },
  ];
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('reply: --resume sulla conversazione, task e nota dal sidecar, modello dal transcript, turno +1', async () => {
  const root = project();
  const io = fakeIo();
  await openHeadless(req('T9', 'preflight'), root, io);
  transcript(root, SID);
  const r = await replyHeadless(SID.slice(0, 8), 'D1: A', root, io);
  assert.ok(r.ok, JSON.stringify(r));
  const a = io.launches[1]!.args;
  assert.equal(a[a.indexOf('--resume') + 1], SID);
  assert.equal(a.indexOf('--session-id'), -1);
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet', 'il modello con cui la conversazione ha risposto');
  assert.match(a[a.indexOf('--name') + 1]!, /^🧪 demo · T9 📐 demo task$/);
  assert.deepEqual(a.slice(-2), ['--', 'D1: A']);
  assert.equal(io.launches[1]!.opts.env.LOOM_TASK, 'T9');
  const st = readState(root, SID)!;
  assert.equal(st.turn, 2);
  assert.equal(st.kind, 'preflight');
  assert.equal(st.prompt, 'D1: A');
});

// T220/P2 — la regia si dichiara a ogni reply: un turno è un processo nuovo, e
// la variabile non si rilegge dal sidecar.
test('reply --regia: LOOM_REGIA in quel turno; senza, il turno dopo non la porta', async () => {
  const root = project();
  const io = fakeIo();
  await openHeadless(req('T9', 'preflight', { regia: 'T10' }), root, io);
  transcript(root, SID);
  const withRegia = await replyHeadless(SID, 'D1: A', root, io, undefined, 'T10');
  assert.ok(withRegia.ok, JSON.stringify(withRegia));
  assert.equal(io.launches[1]!.opts.env.LOOM_REGIA, 'T10');
  assert.equal(readState(root, SID)!.regia, 'T10');
  const without = await replyHeadless(SID, 'continua', root, io);
  assert.ok(without.ok);
  assert.equal(io.launches[2]!.opts.env.LOOM_REGIA, undefined, 'il sidecar dice T10, ma la variabile segue la richiesta');
  assert.equal(readState(root, SID)!.regia, undefined);
  // Il sidecar non riceve un secondo record di regia dalle risposte.
  const regiaRecs = readFileSync(taskIndexPath(root), 'utf8').split('\n').filter((x) => x.includes('"regia"'));
  assert.equal(regiaRecs.length, 1);
});

test('reply --regia: rifiutata su una regia che non è un perimetro e su una conversazione senza task', async () => {
  const root = project();
  const io = fakeIo();
  await openHeadless(req('T9', 'preflight'), root, io);
  transcript(root, SID);
  const bad = await replyHeadless(SID, 'x', root, io, undefined, 'T9');
  assert.deepEqual(bad, { ok: false, reason: "regia T9: non è un'epica né un mandato" });
  const spot = 'deadbeef-0000-0000-0000-000000000000';
  transcript(root, spot);
  const r = await replyHeadless(spot, 'x', root, io, undefined, 'T10');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /non è legata a una task/);
  assert.equal(io.launches.length, 1, 'nessun turno per i due rifiuti');
});

test('reply: --model vince sul transcript', async () => {
  const root = project();
  const io = fakeIo();
  transcript(root, SID);
  const r = await replyHeadless(SID, 'vai', root, io, 'haiku');
  assert.ok(r.ok);
  const a = io.launches[0]!.args;
  assert.equal(a[a.indexOf('--model') + 1], 'haiku');
  assert.equal(io.launches[0]!.opts.env.LOOM_TASK, undefined, 'senza binding nessuna task');
  assert.equal(readState(root, SID)!.kind, 'reply');
});

test('reply: rifiutata con un processo vivo, in una tab o headless, e con un turno in corso', async () => {
  const root = project();
  transcript(root, SID);
  const tab = fakeIo({ processes: () => [{ pid: 9, entrypoint: 'cli', kind: 'interactive', state: 'idle' }] });
  const r1 = await replyHeadless(SID, 'x', root, tab);
  assert.ok(!r1.ok && /pid 9, tab/.test(r1.reason));
  const hl = fakeIo({ processes: () => [{ pid: 8, entrypoint: 'sdk-cli', kind: 'interactive', state: 'busy' }] });
  const r2 = await replyHeadless(SID, 'x', root, hl);
  assert.ok(!r2.ok && /pid 8, turno headless/.test(r2.reason));

  // il turno appena lanciato non è ancora nel registro: decide lo stato
  const running = fakeIo({ running: () => true });
  await openHeadless(req('T9', 'preflight'), root, running);
  const r3 = await replyHeadless(SID, 'x', root, running);
  assert.ok(!r3.ok && /turno headless in corso \(pid 4242\)/.test(r3.reason));
  assert.equal(running.launches.length, 1);
});

test('reply: sessione ignota, prefisso ambiguo, messaggio vuoto', async () => {
  const root = project();
  const io = fakeIo();
  const unknown = await replyHeadless('deadbeef', 'x', root, io);
  assert.ok(!unknown.ok && /nessuna conversazione deadbeef/.test(unknown.reason));
  transcript(root, '0a1b2c3d-aaaa-4222-8333-444455556666');
  transcript(root, '0a1b2c3d-bbbb-4222-8333-444455556666');
  const amb = await replyHeadless('0a1b2c3d', 'x', root, io);
  assert.ok(!amb.ok && /indica 2 conversazioni/.test(amb.reason));
  const empty = await replyHeadless('0a1b2c3d-aaaa', '  ', root, io);
  assert.ok(!empty.ok && /vuoto/.test(empty.reason));
  assert.equal(io.launches.length, 0);
  assert.deepEqual(resolveSession('zz', ['a']), { error: "sessione non valida: 'zz' (sessionId, o prefisso di almeno 8 caratteri esadecimali)" });
});

// ── esito ──────────────────────────────────────────────────────────────────

const RESULT = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fatto', permission_denials: [], duration_ms: 3400, session_id: SID, ...over });

test('parseTurnOutput: oggetto json, righe stream-json, niente', () => {
  assert.equal(parseTurnOutput(''), null);
  assert.equal(parseTurnOutput('{"type":"system"}\n'), null);
  assert.equal(parseTurnOutput('{"type":"result"'), null, 'output troncato');
  assert.equal(parseTurnOutput(RESULT())!.text, 'fatto');
  const stream = ['{"type":"system","subtype":"init"}', RESULT({ result: 'primo' }), RESULT({ result: 'ultimo' })].join('\n');
  assert.equal(parseTurnOutput(stream)!.text, 'ultimo');
  const denied = parseTurnOutput(
    RESULT({
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git push\n origin', description: 'x' } },
        { tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: '/a/b.txt', content: '...' } },
      ],
    }),
  )!;
  assert.deepEqual(denied.denials, [
    { tool: 'Bash', input: 'git push origin' },
    { tool: 'Write', input: '/a/b.txt' },
  ]);
});

function state(over: Partial<HeadlessState> = {}): HeadlessState {
  return {
    sessionId: SID,
    task: 'T9',
    kind: 'preflight',
    model: 'fable',
    title: 'demo · T9',
    permissionMode: 'auto',
    turn: 1,
    startedAt: new Date(NOW - 5000).toISOString(),
    pid: 4242,
    procStart: '777',
    prompt: '/loom-works:preflight-task T9',
    ...over,
  };
}

test('classifyTurn: quattro classi, e il risultato scritto vince sulla liveness', () => {
  const st = state();
  assert.equal(classifyTurn(st, parseTurnOutput(RESULT()), true, '').cls, 'turno chiuso');
  assert.equal(classifyTurn(st, parseTurnOutput(RESULT({ is_error: true, subtype: 'error_during_execution' })), false, '').cls, 'errore');
  const both = parseTurnOutput(RESULT({ is_error: true, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'x' } }] }));
  assert.equal(classifyTurn(st, both, false, '').cls, 'errore', 'is_error vince sui permessi negati');
  const denied = parseTurnOutput(RESULT({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'x' } }] }));
  assert.equal(classifyTurn(st, denied, false, '').cls, 'permesso negato');
  assert.equal(classifyTurn(st, null, true, '').cls, 'in corso');
  const dead = classifyTurn(st, null, false, 'riga 1\nerror: unknown option --permission-prompts\n');
  assert.equal(dead.cls, 'errore');
  assert.match(dead.reason, /senza esito; stderr:\n.*riga 1\nerror: unknown option/s);
  assert.match(classifyTurn(st, null, false, '').reason, /ucciso\?/);
  assert.equal(classifyTurn(state({ launchError: 'ENOENT' }), null, false, '').cls, 'errore');
});

test('turnOutcome: uno stato senza pid è in avvio, poi un lanciatore interrotto', () => {
  const root = project();
  const pending = state({ pid: null, procStart: '', startedAt: new Date(NOW - 1000).toISOString() });
  assert.deepEqual(turnOutcome(root, pending, { running: () => false, now: () => new Date(NOW) }), {
    cls: 'in corso',
    result: null,
    reason: 'in avvio',
  });
  const stale = turnOutcome(root, pending, { running: () => false, now: () => new Date(NOW + PENDING_MAX_MS) });
  assert.equal(stale.cls, 'errore');
});

// ── riga di comando ────────────────────────────────────────────────────────

function clientIo(root: string, headless: HeadlessIo, over: { stdin?: string } = {}) {
  const out = { stdout: '', stderr: '', sleeps: 0 };
  return {
    out,
    io: {
      cwd: root,
      stdout: (s: string) => (out.stdout += s),
      stderr: (s: string) => (out.stderr += s),
      readStdin: async () => over.stdin ?? '',
      sleep: async () => {
        out.sleeps++;
      },
      headless,
    },
  };
}

test('argomenti: sottocomandi, sessione, --wait, -- nel messaggio', () => {
  assert.deepEqual(parseHeadlessArgs([]), { help: true });
  assert.deepEqual(parseHeadlessArgs(['open', 'T9', 'run']), { cmd: 'open', args: ['T9', 'run'] });
  assert.deepEqual(parseHeadlessArgs(['status', '0a1b2c3d', '--wait', '30', '--json']), {
    cmd: 'status',
    session: '0a1b2c3d',
    wait: 30,
    json: true,
    root: null,
  });
  assert.deepEqual(parseHeadlessArgs(['reply', '0a1b2c3d', '--', '--non', 'è', 'un', 'flag']), {
    cmd: 'reply',
    session: '0a1b2c3d',
    words: ['--non', 'è', 'un', 'flag'],
    root: null,
    model: undefined,
  });
  for (const bad of [
    ['boh'],
    ['status'],
    ['status', 'xyz'],
    ['status', '0a1b2c3d', '--wait', '9999'],
    ['status', '0a1b2c3d', 'extra'],
    ['reply', '0a1b2c3d'],
    ['reply', '0a1b2c3d', '--model', 'gpt', 'x'],
    ['reply', '0a1b2c3d', '--boh', 'x'],
    // T220 — la regia è un id di task, e vale solo dove parte un turno.
    ['reply', '0a1b2c3d', 'x', '--regia', 'epica'],
    ['reply', '0a1b2c3d', 'x', '--regia'],
    ['status', '0a1b2c3d', '--regia', 'T10'],
  ]) {
    assert.ok('usage' in parseHeadlessArgs(bad), bad.join(' '));
  }
  assert.deepEqual(parseHeadlessArgs(['reply', '0a1b2c3d', 'D1:', 'A', '--regia', 'T10']), {
    cmd: 'reply',
    session: '0a1b2c3d',
    words: ['D1:', 'A'],
    root: null,
    model: undefined,
    regia: 'T10',
  });
});

test('client: open stampa il sessionId, reply legge lo stdin, status mappa le uscite', async () => {
  const root = project();
  const hio = fakeIo();
  const a = clientIo(root, hio);
  assert.equal(await runHeadlessClient(['open', 'T9', 'preflight'], a.io), 0);
  assert.match(a.out.stdout, new RegExp(`sessionId: ${SID}`));
  assert.match(a.out.stdout, /nessuna tab/);

  // in corso → 3, senza attesa
  const running = { ...hio, running: () => true };
  const b = clientIo(root, running);
  assert.equal(await runHeadlessClient(['status', SID.slice(0, 8)], b.io), 3);
  assert.match(b.out.stdout, /esito: {5}in corso · da 0 s/);

  // --wait: rilegge finché il turno non finisce
  let calls = 0;
  const finishing = { ...hio, running: () => calls++ < 2 };
  const c = clientIo(root, finishing);
  writeFileSync(outPath(root, SID), RESULT({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] }));
  // il risultato è già scritto: vince anche se il processo risulta vivo
  assert.equal(await runHeadlessClient(['status', SID, '--wait', '60'], c.io), 4);
  assert.match(c.out.stdout, /permesso negato · 3 s\npermessi negati \(riprendere in una tab per approvarli\):\n {2}- Bash: git push/);

  writeFileSync(outPath(root, SID), RESULT());
  const d = clientIo(root, hio);
  assert.equal(await runHeadlessClient(['status', SID, '--json'], d.io), 0);
  assert.equal(JSON.parse(d.out.stdout).outcome.cls, 'turno chiuso');

  writeFileSync(outPath(root, SID), '');
  const e = clientIo(root, hio);
  assert.equal(await runHeadlessClient(['status', SID], e.io), 1);
  assert.match(e.out.stdout, /esito: {5}errore\nmotivo: {4}processo finito senza esito/);

  transcript(root, SID);
  const f = clientIo(root, hio, { stdin: 'risposta\nsu due righe' });
  assert.equal(await runHeadlessClient(['reply', SID, '-'], f.io), 0);
  assert.equal(hio.launches.at(-1)!.args.at(-1), 'risposta\nsu due righe');

  const g = clientIo(root, hio);
  assert.equal(await runHeadlessClient(['status', 'ffffffff'], g.io), 2);
  assert.match(g.out.stderr, /nessun turno headless di ffffffff/);
});

test('client: --wait si ferma alla scadenza con uscita 3', async () => {
  const root = project();
  writeState(root, state());
  let t = NOW;
  const hio = fakeIo({ running: () => true, now: () => new Date(t) });
  const c = clientIo(root, hio);
  c.io.sleep = async () => {
    c.out.sleeps++;
    t += 1000;
  };
  assert.equal(await runHeadlessClient(['status', SID, '--wait', '3'], c.io), 3);
  assert.equal(c.out.sleeps, 3);
});

test('client: --help e uso', async () => {
  const root = project();
  const h = clientIo(root, fakeIo());
  assert.equal(await runHeadlessClient(['--help'], h.io), 0);
  assert.equal(h.out.stdout, `${HEADLESS_USAGE}\n`);
  const u = clientIo(root, fakeIo());
  assert.equal(await runHeadlessClient(['open', 'T9'], u.io), 2);
  assert.match(u.out.stderr, /servono <TaskID> e <kind>/);
});

test('statusText: testo finale e righe dell’esito', () => {
  const o = classifyTurn(state(), parseTurnOutput(RESULT({ result: 'D1 — quale strada?' })), false, '');
  assert.equal(
    statusText(state(), o, new Date(NOW)),
    `sessionId: ${SID}\ntask:      T9 · preflight · fable\nturno:     1 · avviato 2026-11-17T09:59:55.000Z · pid 4242\nesito:     turno chiuso · 3 s\ntesto finale:\nD1 — quale strada?\n`,
  );
});

// ── lancio vero ────────────────────────────────────────────────────────────

/** Un `claude` finto: scrive su stdout l'evento `result` col proprio argv, la
 *  propria sessione e dove punta il suo stdin, poi esce. */
function fakeClaude(dir: string): string {
  const path = join(dir, 'fake-claude.mjs');
  writeFileSync(
    path,
    `import { readFileSync, readlinkSync } from 'node:fs';
let session = '', stdin = '';
try { session = readFileSync('/proc/self/stat', 'utf8').split(')').pop().trim().split(/\\s+/)[3]; } catch {}
try { stdin = readlinkSync('/proc/self/fd/0'); } catch {}
console.error('stderr del finto');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, permission_denials: [],
  result: JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, session, stdin, task: process.env.LOOM_TASK ?? null }) }));
`,
  );
  return path;
}

test(
  'launchDetached: sessione propria, stdin chiuso, stdout e stderr sui file, esito leggibile a processo finito',
  { skip: unixOnly('sessione e stdin letti da /proc') },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-hl-launch-'));
    const script = fakeClaude(dir);
    const outFile = join(dir, 'o.json');
    const errFile = join(dir, 'e.txt');
    const r = await launchDetached(process.execPath, [script, '-p', '--', 'ciao'], {
      cwd: dir,
      env: headlessEnv(REGIA_ENV, { task: 'T9' }, 'linux') as NodeJS.ProcessEnv & { PATH: string },
      outFile,
      errFile,
    });
    assert.ok('pid' in r, JSON.stringify(r));
    const start = procStartOf(readFileSync(`/proc/${r.pid}/stat`, 'utf8').toString()) ?? '';
    for (let i = 0; i < 200 && procRunning(r.pid, start); i++) await new Promise((res) => setTimeout(res, 25));
    const out = parseTurnOutput(readFileSync(outFile, 'utf8'))!;
    const seen = JSON.parse(out.text) as { argv: string[]; pid: number; session: string; stdin: string; task: string };
    assert.deepEqual(seen.argv, ['-p', '--', 'ciao']);
    assert.equal(seen.session, String(seen.pid), 'leader di una sessione propria: il SIGHUP di chi lancia non lo raggiunge');
    assert.equal(seen.stdin, '/dev/null');
    assert.equal(seen.task, 'T9');
    assert.match(readFileSync(errFile, 'utf8'), /stderr del finto/);
  },
);

test('launchDetached: un comando che non esiste è un errore, non un pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-hl-launch-'));
  const r = await launchDetached(join(dir, 'non-esiste'), [], {
    cwd: dir,
    env: { PATH: '' },
    outFile: join(dir, 'o.json'),
    errFile: join(dir, 'e.txt'),
  });
  assert.ok('error' in r && /ENOENT/.test(r.error), JSON.stringify(r));
});

test('stato: scrittura atomica e lettura per id', () => {
  const root = project();
  writeState(root, state({ turn: 3 }));
  assert.equal(readState(root, SID)!.turn, 3);
  assert.equal(readState(root, 'altro'), null);
  writeFileSync(statePath(root, SID), '{rotto');
  assert.equal(readState(root, SID), null);
});

test('sessionProcesses: ogni forma di processo vivo della conversazione, parseLiveEntry resta filtrato', () => {
  const reg = mkdtempSync(join(tmpdir(), 'loom-hl-reg-'));
  const entry = (pid: number, sessionId: string, extra: Record<string, unknown>) =>
    writeFileSync(
      join(reg, `${pid}.json`),
      JSON.stringify({ pid, sessionId, procStart: String(pid), cwd: '/p', status: 'idle', ...extra }),
    );
  entry(11, SID, { entrypoint: 'cli', kind: 'interactive' });
  entry(12, SID, { entrypoint: 'sdk-cli', kind: 'interactive', status: 'busy' });
  entry(13, SID, { entrypoint: 'cli', kind: 'bg' });
  entry(14, 'altra', { entrypoint: 'cli', kind: 'interactive' });
  entry(15, SID, { entrypoint: 'sdk-cli', kind: 'interactive' });
  const alive = (pairs: { pid: number }[]) => pairs.map((p) => p.pid !== 15);
  const got = sessionProcesses(SID, reg, alive).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(got, [
    { pid: 11, entrypoint: 'cli', kind: 'interactive', state: 'idle' },
    { pid: 12, entrypoint: 'sdk-cli', kind: 'interactive', state: 'busy' },
    { pid: 13, entrypoint: 'cli', kind: 'bg', state: 'idle' },
  ]);
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({ sessionId: SID, procStart: '1', cwd: '/p', ...extra });
  assert.notEqual(parseLiveEntry(raw({}), 1), null, 'campi assenti: una tab');
  assert.equal(parseLiveEntry(raw({ entrypoint: 'sdk-cli' }), 1), null);
  assert.equal(parseLiveEntry(raw({ kind: 'bg' }), 1), null);
  assert.equal(parseRegistryEntry(raw({ entrypoint: 'sdk-cli' }), 1)!.entrypoint, 'sdk-cli');
});

// ── pulizia dei file di stato (T206) ───────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const FINISHED = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fatto', session_id: 'x' });

/** Un turno su disco: stato, esito (se finito) e stderr, tutti toccati `ageMs`
 *  prima di `NOW`; il transcript a parte. */
function turnOnDisk(root: string, sid: string, o: { ageMs: number; finished?: boolean; pid?: number | null; transcript?: boolean }) {
  const st: HeadlessState = {
    sessionId: sid,
    task: 'T9',
    kind: 'recap',
    model: 'haiku',
    title: 't',
    permissionMode: 'auto',
    turn: 1,
    startedAt: new Date(NOW - o.ageMs).toISOString(),
    pid: o.pid === undefined ? 4242 : o.pid,
    procStart: '777',
    prompt: 'p',
  };
  writeState(root, st);
  writeFileSync(outPath(root, sid), o.finished === false ? '' : FINISHED);
  writeFileSync(errPath(root, sid), '');
  const at = new Date(NOW - o.ageMs);
  for (const f of headlessFiles(root, sid)) utimesSync(f, at, at);
  if (o.transcript) transcript(root, sid);
}

const id = (n: number) => `0a1b2c3d-0000-4000-8000-00000000000${n}`;

test('pulizia: turno finito da più di 7 giorni o senza transcript fuori, il resto resta (T206)', () => {
  const root = project();
  turnOnDisk(root, id(1), { ageMs: HEADLESS_KEEP_MS + DAY, transcript: true });
  turnOnDisk(root, id(2), { ageMs: DAY, transcript: true });
  turnOnDisk(root, id(3), { ageMs: HEADLESS_ORPHAN_GRACE_MS + 60_000 });
  turnOnDisk(root, id(4), { ageMs: 60_000 });
  turnOnDisk(root, id(5), { ageMs: HEADLESS_KEEP_MS + DAY, finished: false, pid: 5555 });
  turnOnDisk(root, id(6), { ageMs: 1_000, finished: false, pid: null });
  const io = { now: () => new Date(NOW), running: (pid: number) => pid === 5555 };
  const transcripts = new Set([id(1), id(2)]);
  assert.deepEqual(staleHeadless(root, io, transcripts), [id(1), id(3)]);
});

test('pulizia: open toglie i file dei turni finiti prima di lanciare il suo (T206)', async () => {
  const root = project();
  turnOnDisk(root, id(1), { ageMs: HEADLESS_KEEP_MS + DAY, transcript: true });
  turnOnDisk(root, id(2), { ageMs: DAY, transcript: true });
  const r = await openHeadless(req('T9', 'recap'), root, fakeIo());
  assert.ok(r.ok, JSON.stringify(r));
  for (const f of headlessFiles(root, id(1))) assert.equal(existsSync(f), false, f);
  for (const f of headlessFiles(root, id(2))) assert.equal(existsSync(f), true, f);
  assert.ok(readState(root, SID), 'il turno appena aperto ha il suo stato');
});

test('pulizia: dropHeadlessState toglie i tre file e dice quanti erano (T206)', () => {
  const root = project();
  turnOnDisk(root, id(1), { ageMs: 0 });
  assert.equal(dropHeadlessState(root, id(1)), 3);
  assert.equal(dropHeadlessState(root, id(1)), 0, 'una seconda volta non trova niente');
  assert.equal(existsSync(statePath(root, id(1))), false);
});
