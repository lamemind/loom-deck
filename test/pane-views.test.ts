// T100 — il catalogo delle viste dei due pane.
//
// Due invarianti che il render non può difendere da solo: il catalogo è FISSO
// (le voci ci sono tutte anche a contatore 0, o navigando si spostano sotto le
// dita) e ogni vista è un sottoinsieme ESATTO — `nascoste` è il complemento dei
// filtri, `+più vecchie` è la coda che il cap tronca, né una riga di più né una
// di meno. Un numero nell'header che non coincide col numero di righe è un
// contatore che mente, e non c'è schermata che lo dica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleSessionView,
  cycleTaskView,
  selectSessionRows,
  selectTasks,
  sessionView,
  taskView,
  SESSION_VIEWS,
  TASK_VIEWS,
  type SessionViewCounts,
  type TaskViewCounts,
} from '../src/pane-views.js';
import { assembleSessionList, firstSelectableId, rowIndexOf } from '../src/session-list.js';
import { DEFAULT_VIEW } from '../src/view.js';
import type { Task } from '../src/tasks.js';
import type { Session } from '../src/sessions.js';

const task = (id: string, pri = '⚡', prog = '🔵'): Task => ({
  id,
  pri,
  prog,
  desc: `task ${id}`,
  rawDesc: `task ${id}`,
});

const sess = (sessionId: string, ts = 0): Session => ({
  sessionId,
  cwd: '/p',
  gitBranch: 'main',
  parentUuid: null,
  title: sessionId,
  ts,
  path: `/p/${sessionId}.jsonl`,
  sizeBytes: 100,
  turns: 1,
  customTitle: '',
  firstPrompt: '',
  lastReply: '',
  model: '',
  bodies: [],
});

const ids = (rows: { kind: string; sessionId?: string }[]) =>
  rows.filter((r) => r.kind !== 'separator').map((r) => r.sessionId);

const TASK_COUNTS: TaskViewCounts = { filtered: 2, total: 5, hidden: 3, archivable: 0 };
const SESSION_COUNTS: SessionViewCounts = { total: 7, live: 0, pinned: 2, older: 4 };

// ── catalogo fisso ─────────────────────────────────────────────────────────

test('il catalogo è fisso: 3 voci task e 4 sessioni, contatori a parte', () => {
  assert.deepEqual(
    TASK_VIEWS.map((v) => v.id),
    ['tasks', 'hidden', 'archivable'],
  );
  assert.deepEqual(
    SESSION_VIEWS.map((v) => v.id),
    ['context', 'live', 'pinned', 'older'],
  );
});

test('una voce a contatore 0 resta presente e resta etichettata', () => {
  // È la ragione per cui il catalogo è dato e non rami del render: a 0 la voce
  // non sparisce, si mostra dim. Sparire la farebbe svanire sotto la selezione.
  const zero: TaskViewCounts = { filtered: 0, total: 0, hidden: 0, archivable: 0 };
  assert.equal(taskView('archivable').label(zero), '0 archiviabili');
  assert.equal(taskView('hidden').label(zero), '0 nascoste');
  assert.equal(taskView('archivable').count(zero), 0);
});

test('la voce 1 del pane task mostra n/N solo con filtri attivi', () => {
  assert.equal(taskView('tasks').label(TASK_COUNTS), 'Tasks (2/5)');
  assert.equal(
    taskView('tasks').label({ filtered: 5, total: 5, hidden: 0, archivable: 0 }),
    'Tasks (5)',
  );
});

test('la voce 1 del pane sessioni porta il parent: è variabile per costruzione', () => {
  // D2 create — i due assi sono ortogonali: il pane task sceglie il parent,
  // l'header quale sottoinsieme di quel parent.
  assert.equal(sessionView('context').label(SESSION_COUNTS, 'tutte'), 'tutte (7)');
  assert.equal(sessionView('context').label(SESSION_COUNTS, 'T100'), 'T100 (7)');
});

test('ogni vista ha una nota di lista vuota, tranne la voce 1 del pane sessioni', () => {
  for (const v of TASK_VIEWS) assert.ok(v.empty.length > 0, v.id);
  for (const v of SESSION_VIEWS) {
    if (v.id === 'context') assert.equal(v.empty, null, 'la nota la scrive il pane, che sa il parent');
    else assert.ok((v.empty ?? '').length > 0, v.id);
  }
});

// ── navigazione ciclica ────────────────────────────────────────────────────

test('←/→ sono ciclici agli estremi, in entrambi i cataloghi', () => {
  assert.equal(cycleTaskView('archivable', 1), 'tasks', '→ sull ultima torna alla prima');
  assert.equal(cycleTaskView('tasks', -1), 'archivable', '← sulla prima va all ultima');
  assert.equal(cycleSessionView('older', 1), 'context');
  assert.equal(cycleSessionView('context', -1), 'older');
});

test('N passi avanti tornano al punto di partenza (nessuna voce irraggiungibile)', () => {
  let cur: ReturnType<typeof cycleSessionView> = 'context';
  const visited = new Set<string>();
  for (let i = 0; i < SESSION_VIEWS.length; i++) {
    visited.add(cur);
    cur = cycleSessionView(cur, 1);
  }
  assert.equal(cur, 'context');
  assert.equal(visited.size, SESSION_VIEWS.length);
});

// ── viste del pane task ────────────────────────────────────────────────────

const TASKS = [task('T1', '🔥'), task('T2', '⚡'), task('T3', '🔹'), task('T4', '⚡', '✔️')];

test('`nascoste` è il complemento ESATTO dei filtri correnti', () => {
  const view = { ...DEFAULT_VIEW, hiddenPri: ['low' as const] };
  const ctx = { view, archivable: new Set<string>() };
  const shown = selectTasks(TASKS, 'tasks', ctx).map((t) => t.id);
  const hidden = selectTasks(TASKS, 'hidden', ctx).map((t) => t.id);
  assert.deepEqual(hidden, ['T3']);
  assert.equal(shown.length + hidden.length, TASKS.length, 'unione = lista intera');
  assert.equal(shown.filter((id) => hidden.includes(id)).length, 0, 'intersezione vuota');
});

test('senza filtri `nascoste` è vuota, e resta comunque una vista navigabile', () => {
  const ctx = { view: DEFAULT_VIEW, archivable: new Set<string>() };
  assert.deepEqual(selectTasks(TASKS, 'hidden', ctx), []);
  assert.equal(cycleTaskView('tasks', 1), 'hidden', 'a 0 righe la voce si raggiunge lo stesso');
});

test('`archiviabili` è CIECA ai filtri: li ignora, non li applica al contrario', () => {
  // La vista nasce da uno scan d'età, non dalla vista corrente: filtrare via le
  // Done e poi chiedere le Done vecchie darebbe sempre zero.
  const view = { ...DEFAULT_VIEW, hiddenProg: ['done' as const] };
  const ctx = { view, archivable: new Set(['T4']) };
  assert.deepEqual(
    selectTasks(TASKS, 'archivable', ctx).map((t) => t.id),
    ['T4'],
  );
});

test('ogni vista eredita la chain di ordinamento: un solo asse di sort', () => {
  const ctx = {
    view: { ...DEFAULT_VIEW, sort: [{ key: 'id' as const, dir: 'desc' as const }] },
    archivable: new Set(['T1', 'T4']),
  };
  assert.deepEqual(
    selectTasks(TASKS, 'archivable', ctx).map((t) => t.id),
    ['T4', 'T1'],
  );
});

// ── viste del pane sessioni ────────────────────────────────────────────────

test('`+N più vecchie` sono ESATTAMENTE le troncate dal cap, nello stesso ordine', () => {
  // D4 preflight — la coda, non la lista intera senza cap: il numero
  // dell'header e il numero di righe devono coincidere, o la voce `+2` mostra 5
  // righe di cui 3 doppioni della vista 1.
  const child = [sess('c1', 5), sess('c2', 4), sess('c3', 3), sess('c4', 2)];
  const assembled = assembleSessionList(child, child, new Map(), 2);
  const ctx = { assembled, isLive: () => false };
  assert.equal(assembled.contextHidden, 2);
  assert.deepEqual(ids(selectSessionRows('older', ctx)), ['c3', 'c4']);
  assert.equal(
    selectSessionRows('older', ctx).length,
    sessionView('older').count({ total: 4, live: 0, pinned: 0, older: assembled.contextHidden }),
    'contatore e righe sono lo stesso insieme',
  );
});

test('le pinnate non entrano in `+N più vecchie`: sono esenti dal cap', () => {
  const child = [sess('c1', 5), sess('c2', 4), sess('c3', 3)];
  const all = [...child, sess('p1', 9)];
  const assembled = assembleSessionList(child, all, new Map([['p1', 1]]), 1);
  const ctx = { assembled, isLive: () => false };
  assert.deepEqual(ids(selectSessionRows('older', ctx)), ['c2', 'c3']);
  assert.deepEqual(ids(selectSessionRows('pinned', ctx)), ['p1']);
});

test('`vive` filtra le righe mostrate e non porta con sé il separatore', () => {
  const child = [sess('c1', 5), sess('c2', 4)];
  const all = [...child, sess('p1', 9)];
  const assembled = assembleSessionList(child, all, new Map([['p1', 1]]), 30);
  assert.ok(
    assembled.rows.some((r) => r.kind === 'separator'),
    'la vista di default ha due gruppi, quindi il separatore',
  );
  const live = new Set(['p1', 'c2']);
  const rows = selectSessionRows('live', { assembled, isLive: (id) => live.has(id) });
  assert.deepEqual(rows.map((r) => r.kind), ['pinned', 'context']);
  assert.deepEqual(ids(rows), ['p1', 'c2']);
});

test('la vista di default resta la lista assemblata, separatore compreso', () => {
  const child = [sess('c1', 5)];
  const all = [...child, sess('p1', 9)];
  const assembled = assembleSessionList(child, all, new Map([['p1', 1]]), 30);
  assert.deepEqual(
    selectSessionRows('context', { assembled, isLive: () => false }),
    assembled.rows,
  );
});

// ── reset della selezione ──────────────────────────────────────────────────

test('cambiando vista la selezione precedente non è più una riga: cade in cima', () => {
  // D4 create — nessuna regola di mantenimento. Il meccanismo è quello già in
  // esercizio (selezione keyed su id + fallback alla prima riga): qui si verifica
  // che il cambio vista lo faccia scattare invece di lasciare un caret fantasma.
  const child = [sess('c1', 5), sess('c2', 4)];
  const all = [...child, sess('p1', 9)];
  const assembled = assembleSessionList(child, all, new Map([['p1', 1]]), 30);
  const before = selectSessionRows('context', { assembled, isLive: () => false });
  const after = selectSessionRows('pinned', { assembled, isLive: () => false });

  assert.ok(rowIndexOf(before, 'c2') >= 0, 'c2 era selezionabile nella vista di partenza');
  assert.equal(rowIndexOf(after, 'c2'), -1, 'nella vista nuova non esiste più');
  assert.equal(firstSelectableId(after), 'p1', 'il fallback è la prima riga, non una posizione');
});

test('una vista vuota non ha prima riga: la selezione resta null, non un id morto', () => {
  const child = [sess('c1', 5)];
  const assembled = assembleSessionList(child, child, new Map(), 30);
  const rows = selectSessionRows('pinned', { assembled, isLive: () => false });
  assert.deepEqual(rows, []);
  assert.equal(firstSelectableId(rows), null);
});
