import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliveIds, liveMarkPlan, restoreSet, type LiveMarkPlan } from '../src/live-marks.js';
import { appendLive, loadSessionIndex, taskIndexPath } from '../src/task-index.js';
import type { Session } from '../src/sessions.js';

const sess = (sessionId: string): Session => ({
  sessionId,
  cwd: '/p',
  gitBranch: 'main',
  parentUuid: null,
  title: '',
  ts: 0,
  path: `/p/${sessionId}.jsonl`,
  sizeBytes: 100,
  turns: 1,
  customTitle: '',
  firstPrompt: '',
  lastReply: '',
  firstPromptTs: 0,
  lastReplyTs: 0,
  model: '',
  bodies: [],
});

/** La marca come la legge l'indice: id → rango, nell'ordine dato. */
const marks = (...ids: string[]) => new Map(ids.map((id, i) => [id, i]));

const plan = (input: {
  alive?: string[];
  marked?: Map<string, number>;
  missingOnce?: string[];
  held?: string[];
}): LiveMarkPlan =>
  liveMarkPlan({
    alive: input.alive ?? [],
    marked: input.marked ?? new Map(),
    missingOnce: new Set(input.missingOnce ?? []),
    held: new Set(input.held ?? []),
  });

/** Applica un piano alla marca in memoria, come farebbe la rilettura del file:
 *  gli ingressi vanno in coda al rango. Serve a far girare più tick di fila. */
function apply(marked: Map<string, number>, p: LiveMarkPlan): Map<string, number> {
  const next = new Map(marked);
  let top = Math.max(-1, ...next.values());
  for (const id of p.enter) next.set(id, ++top);
  for (const id of p.leave) next.delete(id);
  return next;
}

// ── l'insieme vivo della feature: live ∩ sessions ───────────────────────────

test('alive: solo le vive che hanno una Session (P2)', () => {
  const live = new Map([
    ['a', { startedAt: 1 }],
    ['sotto-cartella', { startedAt: 2 }], // viva nel registro, transcript altrove
    ['b', { startedAt: 3 }],
  ]);
  assert.deepEqual(aliveIds(live, [sess('a'), sess('b'), sess('morta')]), ['a', 'b']);
});

test('alive: ordinate per avvio del processo, non per ordine del registro', () => {
  const live = new Map([
    ['c', { startedAt: 30 }],
    ['a', { startedAt: 10 }],
    ['b', { startedAt: 20 }],
  ]);
  assert.deepEqual(aliveIds(live, [sess('a'), sess('b'), sess('c')]), ['a', 'b', 'c']);
});

test('alive: a parità di avvio decide il sessionId (piano deterministico)', () => {
  const live = new Map([
    ['z', { startedAt: 0 }],
    ['m', { startedAt: 0 }],
  ]);
  assert.deepEqual(aliveIds(live, [sess('m'), sess('z')]), ['m', 'z']);
});

// ── il piano: insieme non vuoto ─────────────────────────────────────────────

test('non vuoto: le vive non marcate entrano al primo tick', () => {
  const p = plan({ alive: ['a', 'b'] });
  assert.deepEqual(p.enter, ['a', 'b']);
  assert.deepEqual(p.leave, []);
});

test('CONVERGENZA: marca già allineata all’insieme vivo → piano vuoto', () => {
  const p = plan({ alive: ['a', 'b'], marked: marks('a', 'b') });
  assert.deepEqual(p, { enter: [], leave: [], missing: new Set() });
});

test('isteresi: la prima assenza non scrive, la mette solo fra le mancanti', () => {
  const p = plan({ alive: ['a'], marked: marks('a', 'b') });
  assert.deepEqual(p.leave, []);
  assert.deepEqual([...p.missing], ['b']);
});

test('isteresi: la seconda assenza consecutiva ritira la marca', () => {
  const p = plan({ alive: ['a'], marked: marks('a', 'b'), missingOnce: ['b'] });
  assert.deepEqual(p.leave, ['b']);
  assert.equal(p.missing.size, 0, 'una ritirata non resta fra le mancanti');
});

test('isteresi: una viva che ricompare esce dalle mancanti senza scrivere', () => {
  const p = plan({ alive: ['a', 'b'], marked: marks('a', 'b'), missingOnce: ['b'] });
  assert.deepEqual(p, { enter: [], leave: [], missing: new Set() });
});

test('entrate e uscite nello stesso giro: chiusa una tab, aperta un’altra', () => {
  let marked = marks('a', 'b');
  let missing = new Set<string>();
  // tick 1: b chiusa, c aperta
  let p = liveMarkPlan({ alive: ['a', 'c'], marked, missingOnce: missing, held: new Set() });
  assert.deepEqual(p.enter, ['c']);
  assert.deepEqual(p.leave, []);
  marked = apply(marked, p);
  missing = p.missing;
  // tick 2: b ancora assente → esce
  p = liveMarkPlan({ alive: ['a', 'c'], marked, missingOnce: missing, held: new Set() });
  assert.deepEqual(p.enter, []);
  assert.deepEqual(p.leave, ['b']);
  marked = apply(marked, p);
  assert.deepEqual([...marked.keys()].sort(), ['a', 'c']);
});

// ── il piano: insieme vuoto ─────────────────────────────────────────────────

test('VUOTO: nessun append, l’ultimo insieme resta marcato', () => {
  const p = plan({ alive: [], marked: marks('a', 'b', 'c'), missingOnce: ['b'] });
  assert.deepEqual(p.enter, []);
  assert.deepEqual(p.leave, [], 'neanche la mancante una volta esce: con zero vive non si scrive');
});

test('VUOTO: l’isteresi riparte da capo (ritiro più lento, mai più svelto)', () => {
  const p = plan({ alive: [], marked: marks('a', 'b'), missingOnce: ['a', 'b'] });
  assert.equal(p.missing.size, 0);
});

test('chiusura della finestra: N processi escono con tempi propri, l’insieme sopravvive', () => {
  // Tre tab vive; la finestra si chiude e i tick cadono a metà dell'uscita.
  let marked = marks('a', 'b', 'c');
  let missing = new Set<string>();
  for (const alive of [['a'], []]) {
    const p = liveMarkPlan({ alive, marked, missingOnce: missing, held: new Set() });
    assert.deepEqual(p.leave, [], `nessun ritiro col tick su [${alive}]`);
    marked = apply(marked, p);
    missing = p.missing;
  }
  assert.deepEqual([...marked.keys()], ['a', 'b', 'c']);
});

test('chiusura una alla volta a deck aperto: l’insieme si restringe all’ultima', () => {
  let marked = marks('a', 'b', 'c');
  let missing = new Set<string>();
  // Ogni chiusura resta ferma per due tick, quanto basta all'isteresi.
  for (const alive of [['b', 'c'], ['b', 'c'], ['c'], ['c'], [], []]) {
    const p = liveMarkPlan({ alive, marked, missingOnce: missing, held: new Set() });
    marked = apply(marked, p);
    missing = p.missing;
  }
  assert.deepEqual([...marked.keys()], ['c']);
});

// ── /clear ──────────────────────────────────────────────────────────────────

test('/clear: il vecchio id esce, il nuovo entra al primo prompt', () => {
  // Una sola conversazione viva, `x`. Dopo `/clear` il processo scrive su `y`,
  // che non ha ancora una Session: l'insieme vivo è vuoto per qualche tick.
  let marked = marks('x');
  let missing = new Set<string>();
  const ticks: string[][] = [[], [], ['y'], ['y']];
  for (const alive of ticks) {
    const p = liveMarkPlan({ alive, marked, missingOnce: missing, held: new Set() });
    marked = apply(marked, p);
    missing = p.missing;
  }
  assert.deepEqual([...marked.keys()], ['y']);
});

test('/clear con altre vive: il nuovo id va in coda al rango', () => {
  let marked = marks('x', 'b');
  let missing = new Set<string>();
  for (const alive of [['b', 'y'], ['b', 'y']]) {
    const p = liveMarkPlan({ alive, marked, missingOnce: missing, held: new Set() });
    marked = apply(marked, p);
    missing = p.missing;
  }
  const ordine = [...marked.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id);
  assert.deepEqual(ordine, ['b', 'y']);
});

// ── la tenuta del restore ───────────────────────────────────────────────────

test('tenuta: la rampa del restore non ritira le tab che stanno ancora partendo', () => {
  let marked = marks('a', 'b', 'c');
  let missing = new Set<string>();
  const held = new Set(['a', 'b', 'c']);
  for (const alive of [['a'], ['a', 'b'], ['a', 'b'], ['a', 'b', 'c']]) {
    const p = liveMarkPlan({ alive, marked, missingOnce: missing, held });
    assert.deepEqual(p.leave, [], `ritiro durante la rampa su [${alive}]`);
    marked = apply(marked, p);
    missing = p.missing;
  }
  const ordine = [...marked.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id);
  assert.deepEqual(ordine, ['a', 'b', 'c'], 'il rango resta quello di prima della chiusura');
});

test('tenuta: una tenuta non conta come mancante, alla scadenza riparte l’isteresi', () => {
  const p = plan({ alive: ['a'], marked: marks('a', 'b'), held: ['b'] });
  assert.equal(p.missing.has('b'), false);
});

// ── il bottone: cosa riapre ─────────────────────────────────────────────────

test('restore: le marcate con una Session, dalla più vecchia', () => {
  const r = restoreSet({
    marked: new Map([
      ['c', 5],
      ['a', 1],
      ['b', 3],
    ]),
    sessions: [sess('a'), sess('b'), sess('c')],
    alive: [],
    restoring: false,
  });
  assert.deepEqual(
    r.map((s) => s.sessionId),
    ['a', 'b', 'c'],
  );
});

test('restore: una marcata senza transcript non si conta', () => {
  const r = restoreSet({ marked: marks('a', 'sparita'), sessions: [sess('a')], alive: [], restoring: false });
  assert.deepEqual(
    r.map((s) => s.sessionId),
    ['a'],
  );
});

test('restore: con una viva il bottone non c’è', () => {
  const r = restoreSet({ marked: marks('a'), sessions: [sess('a'), sess('b')], alive: ['b'], restoring: false });
  assert.deepEqual(r, []);
});

test('restore: durante un restore in corso il bottone non c’è (niente doppio ^T)', () => {
  const r = restoreSet({ marked: marks('a'), sessions: [sess('a')], alive: [], restoring: true });
  assert.deepEqual(r, []);
});

// ── la scrittura, nei due regimi del freno ──────────────────────────────────

// Sottoprocesso sul BUILD per la stessa ragione di `session-meta.test.ts`:
// `NO_SPAWN` è letto all'import, quindi i due regimi del freno non si misurano
// nella stessa istanza della suite.
function writeInSubprocess(root: string, brake: boolean, p: { enter: string[]; leave: string[] }) {
  // T175 — un URL `file://` e non un path: su Windows `import('C:\…')` fallisce
  // (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), perché il loader legge `C:` come uno schema.
  const script = `
    const {writeLiveMarks} = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'live-marks.js')).href)});
    const n = writeLiveMarks(${JSON.stringify(root)}, {
      enter: ${JSON.stringify(p.enter)}, leave: ${JSON.stringify(p.leave)}, missing: new Set(),
    });
    process.stdout.write(String(n));
  `;
  const env = { ...process.env } as Record<string, string | undefined>;
  if (brake) env.LOOM_DECK_NO_SPAWN = '1';
  else delete env.LOOM_DECK_NO_SPAWN;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

test('scrittura: il piano finisce su disco, e il giro dopo non trova niente', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-live-'));
  appendLive(root, 'vecchia', true);
  const r = writeInSubprocess(root, false, { enter: ['a', 'b'], leave: ['vecchia'] });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, '3');
  const idx = loadSessionIndex(root);
  assert.deepEqual([...idx.liveMarks.keys()].sort(), ['a', 'b']);
  // CONVERGENZA su disco: rilette le marche, lo stesso insieme vivo non chiede
  // più niente.
  assert.deepEqual(
    liveMarkPlan({ alive: ['a', 'b'], marked: idx.liveMarks, missingOnce: new Set(), held: new Set() }),
    { enter: [], leave: [], missing: new Set() },
  );
});

test('scrittura: gli ingressi precedono le uscite nel file', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-live-'));
  const r = writeInSubprocess(root, false, { enter: ['nuova'], leave: ['vecchia'] });
  assert.equal(r.status, 0, r.err);
  const righe = readFileSync(taskIndexPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    righe.map((d) => [d.sessionId, d.live]),
    [
      ['nuova', true],
      ['vecchia', false],
    ],
  );
});

test('FRENO: con LOOM_DECK_NO_SPAWN il sidecar non viene toccato', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-live-brake-'));
  const r = writeInSubprocess(root, true, { enter: ['a'], leave: [] });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, '0');
  assert.throws(() => readFileSync(taskIndexPath(root), 'utf8'), 'nessun file creato');
});
