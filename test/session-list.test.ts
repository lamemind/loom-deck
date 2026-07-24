import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSessionList,
  firstSelectableId,
  moveSelection,
  rowIndexOf,
  selectedSession,
} from '../src/session-list.js';
import type { Session } from '../src/sessions.js';

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
});

const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind);
const ids = (rows: any[]) => rows.filter((r) => r.kind !== 'separator').map((r) => r.sessionId);

test('nessun pin: solo contestuali, nessun separatore', () => {
  const child = [sess('c1', 3), sess('c2', 2)];
  const a = assembleSessionList(child, child, new Map(), 30);
  assert.equal(a.pinnedCount, 0);
  assert.deepEqual(kinds(a.rows), ['context', 'context']);
  assert.equal(a.rows.some((r) => r.kind === 'separator'), false);
});

test('pinnate sopra le contestuali, con separatore in mezzo', () => {
  const all = [sess('p1'), sess('p2'), sess('c1')];
  const a = assembleSessionList([sess('c1')], all, new Map([['p1', 0], ['p2', 1]]), 30);
  assert.deepEqual(kinds(a.rows), ['pinned', 'pinned', 'separator', 'context']);
  assert.equal(a.pinnedCount, 2);
});

test('ordine pinnate = rango di pin desc (ultima pinnata in cima)', () => {
  const all = [sess('p1'), sess('p2')];
  // p2 ha rango più alto → pinnata più di recente → in cima
  const a = assembleSessionList([], all, new Map([['p1', 0], ['p2', 1]]), 30);
  assert.deepEqual(ids(a.rows), ['p2', 'p1']);
});

test('dedup: una sessione pinnata + contestuale compare solo fra le pinnate', () => {
  const shared = sess('shared');
  const other = sess('c2');
  const a = assembleSessionList([shared, other], [shared, other], new Map([['shared', 0]]), 30);
  assert.deepEqual(kinds(a.rows), ['pinned', 'separator', 'context']);
  assert.deepEqual(ids(a.rows), ['shared', 'c2']);
  assert.equal(a.contextTotal, 1, 'la contestuale duplicata non conta due volte');
});

test('pin stale: id senza transcript → riga stale (session null), selezionabile', () => {
  const a = assembleSessionList([sess('c1')], [sess('c1')], new Map([['gone', 0]]), 30);
  const stale = a.rows.find((r) => r.kind === 'pinned');
  assert.ok(stale && stale.kind === 'pinned');
  assert.equal(stale.stale, true);
  assert.equal(stale.session, null);
  // resta navigabile
  assert.equal(rowIndexOf(a.rows, 'gone') >= 0, true);
});

test('cap: limita SOLO le contestuali; le pinnate sono esenti', () => {
  const child = [sess('c1'), sess('c2'), sess('c3')];
  const pins = [sess('p1'), sess('p2'), sess('p3')];
  const a = assembleSessionList(
    child,
    [...pins, ...child],
    new Map([['p1', 0], ['p2', 1], ['p3', 2]]),
    2, // cap contestuali a 2
  );
  assert.equal(a.pinnedCount, 3, 'tutte le pinnate mostrate malgrado il cap');
  assert.equal(a.contextTotal, 3);
  assert.equal(a.contextHidden, 1, 'contatore non-silenzioso delle troncate');
  assert.equal(a.rows.filter((r) => r.kind === 'context').length, 2);
});

test('un solo gruppo non vuoto → nessun separatore', () => {
  const onlyPinned = assembleSessionList([], [sess('p1')], new Map([['p1', 0]]), 30);
  assert.deepEqual(kinds(onlyPinned.rows), ['pinned']);
  const onlyContext = assembleSessionList([sess('c1')], [sess('c1')], new Map(), 30);
  assert.deepEqual(kinds(onlyContext.rows), ['context']);
});

test('moveSelection attraversa il separatore, keyed su id, clamp agli estremi', () => {
  const rows = assembleSessionList([sess('c1')], [sess('p1'), sess('c1')], new Map([['p1', 0]]), 30)
    .rows;
  // rows = [pinned p1, separator, context c1]
  assert.equal(moveSelection(rows, 'p1', 1), 'c1', 'giù salta il separatore');
  assert.equal(moveSelection(rows, 'c1', -1), 'p1', 'su salta il separatore');
  assert.equal(moveSelection(rows, 'p1', -1), 'p1', 'clamp in cima');
  assert.equal(moveSelection(rows, 'c1', 1), 'c1', 'clamp in fondo');
  assert.equal(moveSelection(rows, 'id-perso', 1), 'p1', 'id perso → prima riga');
  assert.equal(moveSelection([], null, 1), null, 'lista vuota → null');
});

test('helper: firstSelectableId, rowIndexOf, selectedSession', () => {
  const rows = assembleSessionList([sess('c1')], [sess('p1'), sess('c1')], new Map([['p1', 0]]), 30)
    .rows;
  assert.equal(firstSelectableId(rows), 'p1');
  assert.equal(rowIndexOf(rows, 'c1'), 2, 'indice nell’array completo, separatore incluso');
  assert.equal(rowIndexOf(rows, null), -1);
  assert.equal(selectedSession(rows, 'c1')?.sessionId, 'c1');
  // stale → selectedSession null
  const staleRows = assembleSessionList([], [], new Map([['gone', 0]]), 30).rows;
  assert.equal(selectedSession(staleRows, 'gone'), null);
});
