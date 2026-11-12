// T196 — l'endpoint sul deck VERO: due deck accesi su due progetti, il client
// compilato contro di loro, un secondo deck sullo stesso progetto, il riavvio
// dopo un'uscita forzata.
//
// Il deck gira sotto `pty-frame.py` col freno degli effetti esterni
// (`LOOM_DECK_NO_SPAWN=1`): lo spawn è inerte, ma tutto quello che lo precede è
// vero — l'endpoint, le verifiche sulla task, la terna del catalogo e il binding
// scritto nel sidecar del progetto. Il driver chiude ogni corsa con un SIGKILL
// al gruppo di processi, cioè con l'uscita che lascia il socket orfano su disco:
// il riavvio si prova sull'uscita peggiore, non su quella pulita.
//
// Linux soltanto: il driver pty non esiste su Windows. Lì il trasporto (la
// named pipe) lo coprono `endpoint-server.test.ts` e `spawn-client.test.ts`,
// che girano su ogni piattaforma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointFor } from '../src/spawn-endpoint.js';
import { unixOnly } from './platform-gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const CLI = join(PKG, 'dist', 'cli.js');
const CLIENT = join(PKG, 'dist', 'loom-deck-spawn.js');

function hasPython(): boolean {
  return spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0;
}
const SKIP =
  unixOnly('pty-frame.py usa pty e termios') ||
  (hasPython() ? false : 'python3 assente') ||
  (existsSync(CLIENT) ? false : 'build assente: npm run build');

// Una cartella runtime per l'intero file: è la `$XDG_RUNTIME_DIR` dei deck e del
// client, come sulla macchina vera, dove tutti i deck dell'utente ne condividono
// una.
const RUN = mkdtempSync(join(tmpdir(), 'loom-epd-run-'));
const ENV = { ...process.env, XDG_RUNTIME_DIR: RUN, LOOM_DECK_NO_SPAWN: '1', LOOM_DECK_DOCS_ROOT: '' };

function project(id: string): string {
  const root = join(mkdtempSync(join(tmpdir(), 'loom-epd-')), id);
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  writeFileSync(join(root, '.claude', 'loom-works.json'), JSON.stringify({ id, emoji: '🧪', owner: 'LOCAL', name: id }));
  writeFileSync(
    join(root, 'docs', 'tasks.md'),
    [
      '# Tasks',
      '',
      '## Tasks Overview',
      '',
      '| ID  | Pri | Prog | Task (max 64) |',
      '| --- | --- | ---- | ------------- |',
      '| T1 | ⚡ | 🟢 | Prima |',
      '',
      '## Execution Plan',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'docs', 'tasks', 'T1-prima.md'),
    '# Task: Prima\n\n- **Size**: M\n\n## Deliverables Checklist\n\n- [x] uno\n- [ ] due\n- [ ] tre\n',
  );
  return root;
}

interface Deck {
  proc: ChildProcess;
  /** Il buffer del pty, quando la corsa è finita. */
  done: Promise<string>;
}

/** Un deck vero in un pty per circa `seconds` secondi, poi SIGKILL. */
function startDeck(root: string, seconds: number): Deck {
  const keys = 'W'.repeat(Math.ceil(seconds / 0.7));
  const proc = spawn('python3', [join(HERE, 'pty-frame.py'), '120', '36', root, process.execPath, CLI, '--keys', keys], {
    env: ENV,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (c: string) => (out += c));
  const done = new Promise<string>((resolve) => proc.on('close', () => resolve(out)));
  return { proc, done };
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('attesa scaduta');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function address(root: string): string {
  return endpointFor(root, process.platform, { XDG_RUNTIME_DIR: RUN }).address;
}

/** Il client compilato, come lo lancia la skill dalla Bash di una conversazione. */
function client(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLIENT, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function bindings(root: string): Array<{ sessionId: string; taskId?: string; note?: string }> {
  const p = join(root, '.claude', 'loom', 'session-tasks.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

const sidOf = (out: string) => /^sessionId: (\S+)$/m.exec(out)?.[1];

/** Il deck ha montato l'endpoint: il socket c'è e risponde. Un socket orfano di
 *  una corsa precedente c'è ma non risponde, quindi l'esistenza non basta. */
async function waitListening(root: string): Promise<void> {
  await waitFor(() => existsSync(address(root)));
  await waitFor(() => client(root, ['T1', 'run', '99']).code === 1);
}

test('due deck su due progetti: ogni richiesta arriva al deck del proprio progetto', { skip: SKIP }, async () => {
  const alfa = project('alfa');
  const beta = project('beta');
  const da = startDeck(alfa, 6);
  const db = startDeck(beta, 6);
  try {
    await Promise.all([waitListening(alfa), waitListening(beta)]);
    const ra = client(join(alfa, 'docs'), ['T1', 'run', '2,3']);
    const rb = client(beta, ['T1', 'preflight', '--model', 'haiku']);
    assert.equal(ra.code, 0, ra.err);
    assert.equal(rb.code, 0, rb.err);
    assert.match(ra.out, /^prompt: +\/loom-works:run-task T1 DLV 2,3$/m);
    assert.match(rb.out, /^task: +T1 · preflight · haiku$/m);

    // Il binding nel sidecar del PROPRIO progetto, col sessionId restituito;
    // nessuno nell'altro.
    const ba = bindings(alfa).filter((b) => b.taskId);
    const bb = bindings(beta).filter((b) => b.taskId);
    assert.deepEqual(ba.map((b) => b.sessionId), [sidOf(ra.out)]);
    assert.deepEqual(bb.map((b) => b.sessionId), [sidOf(rb.out)]);
    // La nota del titolo dell'azione, come col tasto.
    assert.ok(bindings(alfa).some((b) => b.note === '🚀 prima'));
  } finally {
    await Promise.all([da.done, db.done]);
  }
});

test('secondo deck sullo stesso progetto: avvisa e non ruba l’indirizzo', { skip: SKIP }, async () => {
  const root = project('gamma');
  const first = startDeck(root, 8);
  try {
    await waitListening(root);
    const second = startDeck(root, 3);
    const frame = (await second.done).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    assert.match(frame, /endpoint di spawn già in ascolto da un altro deck/);
    // Il secondo è morto di SIGKILL: l'indirizzo resta del primo, che risponde.
    const r = client(root, ['T1', 'preflight']);
    assert.equal(r.code, 0, r.err);
  } finally {
    await first.done;
  }
});

test('riavvio dopo un’uscita forzata: rifiuto pulito nel mezzo, risposta dopo, nulla da pulire a mano', { skip: SKIP }, async () => {
  const root = project('delta');
  const first = startDeck(root, 2);
  await waitListening(root);
  await first.done; // SIGKILL: il socket resta su disco
  assert.ok(existsSync(address(root)), 'dopo un SIGKILL il socket orfano resta come file');

  const during = client(root, ['T1', 'preflight']);
  assert.equal(during.code, 3);
  assert.match(during.err, /nessun deck in ascolto .*ECONNREFUSED/);

  const again = startDeck(root, 4);
  try {
    await waitListening(root);
    const after = client(root, ['T1', 'preflight']);
    assert.equal(after.code, 0, after.err);
  } finally {
    await again.done;
  }
});
