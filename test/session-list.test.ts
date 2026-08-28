import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSessionList,
  firstSelectableId,
  moveSelection,
  neighborId,
  rowIndexOf,
  rowLabel,
  sessionTitle,
  stripTaskId,
  selectedSession,
  stripProjectCore,
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
  model: '',
  bodies: [],
});

const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind);
const ids = (rows: { sessionId: string }[]) => rows.map((r) => r.sessionId);
const pinFlags = (rows: any[]) => rows.map((r) => r.pinned);

test('lista unica: le figlie del parent nel loro ordine, tutte dello stesso kind', () => {
  const child = [sess('c1', 3), sess('c2', 2)];
  const a = assembleSessionList(child, child, new Map(), 30);
  assert.deepEqual(kinds(a.rows), ['session', 'session']);
  assert.deepEqual(ids(a.rows), ['c1', 'c2']);
  assert.deepEqual(a.pinnedRows, [], 'nessun pin → nessuna riga nel campo a parte');
});

test('una pinnata figlia del parent sta in lista al posto che l’ordine le dà, non in cima', () => {
  const child = [sess('c1', 3), sess('c2', 2), sess('c3', 1)];
  const a = assembleSessionList(child, child, new Map([['c3', 0]]), 30);
  assert.deepEqual(ids(a.rows), ['c1', 'c2', 'c3'], 'il pin non promuove la riga');
  assert.deepEqual(pinFlags(a.rows), [false, false, true], 'il pin è un attributo della riga');
});

test('una pinnata di un altro parent non entra in lista: vive nel campo a parte', () => {
  const all = [sess('p1', 5), sess('c1', 3)];
  const a = assembleSessionList([sess('c1', 3)], all, new Map([['p1', 0]]), 30);
  assert.deepEqual(ids(a.rows), ['c1'], 'la lista contiene le sole figlie del parent');
  assert.deepEqual(ids(a.pinnedRows), ['p1']);
});

test('pinnedRows: tutte le pinnate del progetto, ordine rango desc (ultima pinnata in cima)', () => {
  const all = [sess('p1'), sess('p2'), sess('c1')];
  const a = assembleSessionList([sess('c1')], all, new Map([['p1', 0], ['p2', 1]]), 30);
  assert.deepEqual(ids(a.pinnedRows), ['p2', 'p1']);
  assert.deepEqual(pinFlags(a.pinnedRows), [true, true]);
});

test('pinnata anche contestuale: una riga in lista e una fra le pinnate, mai due nella stessa', () => {
  const shared = sess('shared', 3);
  const other = sess('c2', 2);
  const a = assembleSessionList([shared, other], [shared, other], new Map([['shared', 0]]), 30);
  assert.deepEqual(ids(a.rows), ['shared', 'c2'], 'niente da deduplicare: i gruppi non sono due');
  assert.deepEqual(ids(a.pinnedRows), ['shared']);
  assert.equal(a.contextTotal, 2);
});

test('pin stale: riga senza transcript, presente SOLO fra le pinnate', () => {
  const a = assembleSessionList([sess('c1')], [sess('c1')], new Map([['gone', 0]]), 30);
  assert.deepEqual(kinds(a.rows), ['session'], 'una stale non è figlia di nessun parent');
  assert.deepEqual(kinds(a.pinnedRows), ['stale']);
  assert.equal(rowIndexOf(a.pinnedRows, 'gone'), 0, 'navigabile dalla vista dedicata');
  assert.equal(selectedSession(a.pinnedRows, 'gone'), null, 'nessuna Session da mostrare');
});

test('cap: conta ogni riga, pinnate comprese — nessuna esenzione', () => {
  const child = [sess('c1', 3), sess('c2', 2), sess('c3', 1)];
  const a = assembleSessionList(child, child, new Map([['c3', 0]]), 2);
  assert.deepEqual(ids(a.rows), ['c1', 'c2']);
  assert.equal(a.contextTotal, 3);
  assert.deepEqual(ids(a.overflowRows), ['c3'], 'una pinnata vecchia cade fra le troncate');
});

test('moveSelection: keyed su id, clamp agli estremi', () => {
  const child = [sess('c1', 3), sess('c2', 2)];
  const rows = assembleSessionList(child, child, new Map(), 30).rows;
  assert.equal(moveSelection(rows, 'c1', 1), 'c2');
  assert.equal(moveSelection(rows, 'c2', -1), 'c1');
  assert.equal(moveSelection(rows, 'c1', -1), 'c1', 'clamp in cima');
  assert.equal(moveSelection(rows, 'c2', 1), 'c2', 'clamp in fondo');
  assert.equal(moveSelection(rows, 'id-perso', 1), 'c1', 'id perso → prima riga');
  assert.equal(moveSelection([], null, 1), null, 'lista vuota → null');
});

test('helper: firstSelectableId, rowIndexOf, selectedSession', () => {
  const child = [sess('c1', 3), sess('c2', 2)];
  const rows = assembleSessionList(child, child, new Map(), 30).rows;
  assert.equal(firstSelectableId(rows), 'c1');
  assert.equal(firstSelectableId([]), null);
  assert.equal(rowIndexOf(rows, 'c2'), 1);
  assert.equal(rowIndexOf(rows, null), -1);
  assert.equal(rowIndexOf(rows, 'ignota'), -1);
  assert.equal(selectedSession(rows, 'c2')?.sessionId, 'c2');
});

// ── T53 · etichetta di riga (strip del core + nota) ─────────────────────────

const CORE = 'loom-works';
const TITLE = '🧵 loom-works · T52';

test('stripProjectCore: toglie core ed emoji, e la punteggiatura di giunzione', () => {
  assert.equal(stripProjectCore(TITLE, CORE), 'T52');
  assert.equal(stripProjectCore('🧵 loom-works', CORE), '', 'senza suffisso non resta nulla');
  assert.equal(
    stripProjectCore('🧵 LOCAL loom-works · T52', CORE),
    'T52',
    'i titoli storici (formula con owner) restano ripuliti: il core è il nome nudo',
  );
});

test('stripProjectCore: core null o non presente → titolo intatto', () => {
  assert.equal(stripProjectCore(TITLE, null), TITLE, 'senza identità non si indovina');
  assert.equal(stripProjectCore('altro progetto · T1', CORE), 'altro progetto · T1');
});

test('senza nota il testo passa intatto (lo strip ormai avviene a monte)', () => {
  const l = rowLabel('T52', undefined, 44);
  assert.equal(l.note, '');
  assert.equal(l.rest, 'T52');
});

test('senza nota: il testo troppo lungo viene troncato al budget', () => {
  const l = rowLabel('x'.repeat(80), undefined, 20);
  assert.equal(l.note, '');
  assert.equal(l.rest.length, 20);
  assert.ok(l.rest.endsWith('…'), 'troncatura mai silenziosa');
});

test('con nota: nota e resto convivono', () => {
  const l = rowLabel('T52', 'regex + reader', 44);
  assert.equal(l.note, 'regex + reader');
  assert.equal(l.rest, 'T52');
});

test('con nota e nessun resto: la nota prende tutto il budget', () => {
  const l = rowLabel('', 'sessione nuda', 44);
  assert.equal(l.note, 'sessione nuda');
  assert.equal(l.rest, '', 'resto vuoto è un esito legittimo, non un fallback');
});

test('budget stretto: il resto sparisce invece di ridursi a un moncone', () => {
  const l = rowLabel('T52', 'una nota parecchio lunga da mostrare', 22);
  assert.equal(l.rest, '', 'sotto MIN_REST il resto non vale la riga');
  assert.ok(l.note.length <= 20, `nota entro budget-2, invece ${l.note.length}`);
});

test('budget stretto: nota + caporali non superano MAI il budget (riga a capo = altezza sforata)', () => {
  for (const budget of [0, 1, 2, 4, 8, 12, 16, 30, 44]) {
    const l = rowLabel('T52', 'nota molto molto lunga che non entra', budget);
    const used = (l.note ? l.note.length + 2 : 0) + (l.rest ? l.rest.length + 1 : 0);
    assert.ok(used <= budget, `budget ${budget}: usate ${used} colonne`);
  }
});

test('nota lunga con resto: la nota cede spazio ma non scende sotto il minimo', () => {
  const l = rowLabel('T52', 'x'.repeat(60), 44);
  assert.equal(l.rest, 'T52', 'il resto resta visibile');
  assert.ok(l.note.length >= 14, 'la nota conserva il suo minimo');
  assert.ok(l.note.endsWith('…'), 'nota troncata, non silenziosamente tagliata');
});

// ── T60 · pulizia del titolo: via ciò che le colonne accanto dicono già ─────

const sessOf = (customTitle: string, firstPrompt: string) => ({
  title: customTitle || firstPrompt || '(senza titolo)',
  customTitle,
  firstPrompt,
});

test('sessionTitle: titolo custom svuotato dallo strip → cade sul primo prompt', () => {
  const s = sessOf(TITLE, 'implementa la ricerca full-text');
  assert.equal(
    sessionTitle(s, CORE, 'T52'),
    'implementa la ricerca full-text',
    'progetto e task sono già in colonna: senza fallback la cella resterebbe vuota',
  );
});

test('sessionTitle: senza titolo custom il titolo È il primo prompt, intatto', () => {
  const s = sessOf('', 'loom-works:create-task yolo deck');
  assert.equal(
    sessionTitle(s, CORE, 'T52'),
    'loom-works:create-task yolo deck',
    'qui lo strip morderebbe dentro un prompt, non dentro una label di tab',
  );
});

test('sessionTitle: residuo del titolo custom oltre il task id → vince sul primo prompt', () => {
  const s = sessOf('🧵 loom-works · T52 · fork', 'primo prompt');
  assert.equal(sessionTitle(s, CORE, 'T52'), 'fork');
});

test('sessionTitle: senza binding il task id non si toglie (non c’è nulla da dedurre)', () => {
  const s = sessOf(TITLE, 'primo prompt');
  assert.equal(sessionTitle(s, CORE, null), 'T52');
});

test('stripTaskId: match per TOKEN intero, mai per substring', () => {
  assert.equal(stripTaskId('T5 · nota', 'T5'), 'nota');
  assert.equal(stripTaskId('T59 · nota', 'T5'), 'T59 · nota', 'T5 non morde dentro T59');
  assert.equal(stripTaskId('T59', 'T59'), '');
  assert.equal(stripTaskId('qualcosa', null), 'qualcosa');
});

// ── T57 · dove atterra la selezione quando una sessione cambia parent ───────

test('vicino: la riga SUCCESSIVA, non la prima della lista', () => {
  const child = [sess('c1', 3), sess('c2', 2), sess('c3', 1)];
  const a = assembleSessionList(child, child, new Map(), 30);
  assert.equal(neighborId(a.rows, 'c2'), 'c3');
  assert.equal(neighborId(a.rows, 'c1'), 'c2');
});

test('vicino: sull’ultima riga si ripiega sulla precedente', () => {
  const child = [sess('c1', 3), sess('c2', 2)];
  const a = assembleSessionList(child, child, new Map(), 30);
  assert.equal(neighborId(a.rows, 'c2'), 'c1');
});

test('vicino: unica riga → null (nessun posto dove atterrare)', () => {
  const child = [sess('c1')];
  const a = assembleSessionList(child, child, new Map(), 30);
  assert.equal(neighborId(a.rows, 'c1'), null);
  assert.equal(neighborId([], 'c1'), null);
  assert.equal(neighborId(a.rows, 'ignota'), null);
});

test('unpin dalla vista dedicata: si atterra sulla pinnata vicina della stessa vista', () => {
  const all = [sess('p1'), sess('p2'), sess('p3'), sess('c1')];
  // Rango desc → l'ultima pinnata sta in cima: p3, p2, p1.
  const pins = new Map([['p1', 0], ['p2', 1], ['p3', 2]]);
  const a = assembleSessionList([sess('c1')], all, pins, 30);
  assert.deepEqual(ids(a.pinnedRows), ['p3', 'p2', 'p1']);
  assert.equal(neighborId(a.pinnedRows, 'p3'), 'p2');
  assert.equal(
    neighborId(a.pinnedRows, 'p1'),
    'p2',
    'sull’ultima si risale: la lista è quella delle pinnate, non c’è nessun gruppo da scavalcare',
  );
});

test('unpin: unica pinnata → null (nessun posto dove atterrare)', () => {
  const only = assembleSessionList([], [sess('p1')], new Map([['p1', 0]]), 30);
  assert.equal(neighborId(only.pinnedRows, 'p1'), null);
});

test('cambio di parent: la sessione riassegnata esce dalla lista', () => {
  const all = [sess('s1', 3), sess('s2', 2)];
  // Prima: entrambe spot (nessun binding) → entrambe figlie della riga spot.
  const prima = assembleSessionList(all, all, new Map(), 30);
  assert.deepEqual(ids(prima.rows), ['s1', 's2']);
  // Dopo: s1 assegnata a T42 → il contesto spot la perde, e chi guarda T42 la trova.
  const spotDopo = assembleSessionList([sess('s2', 2)], all, new Map(), 30);
  assert.deepEqual(ids(spotDopo.rows), ['s2']);
  const taskDopo = assembleSessionList([sess('s1', 3)], all, new Map(), 30);
  assert.deepEqual(ids(taskDopo.rows), ['s1']);
});

test('cambio di parent su una PINNATA: esce dalla lista come ogni altra riga', () => {
  const all = [sess('s1', 3), sess('s2', 2)];
  const pin = new Map([['s1', 0]]);
  // s1 pinnata e assegnata altrove: sparisce dalla lista di spot, e resta
  // raggiungibile dalla sola vista dedicata.
  const a = assembleSessionList([sess('s2', 2)], all, pin, 30);
  assert.deepEqual(ids(a.rows), ['s2']);
  assert.deepEqual(ids(a.pinnedRows), ['s1']);
});

test('vista "tutte": contesto === universo → una riga per sessione, la pinnata al suo posto', () => {
  // La riga meta `≡ tutte` passa `sessions` come PRIMO argomento, cioè lo stesso
  // array che fa da universo: ogni pinnata è anche figlia, e col vecchio blocco
  // in cima sarebbe comparsa due volte.
  const all = [sess('s1', 3), sess('s2', 2), sess('s3', 1)];
  const a = assembleSessionList(all, all, new Map([['s2', 0]]), 100);
  assert.deepEqual(ids(a.rows), ['s1', 's2', 's3']);
  assert.deepEqual(pinFlags(a.rows), [false, true, false]);
  assert.equal(a.contextTotal, 3);
  assert.deepEqual(a.overflowRows, []);
});

test('vista "tutte": il cap dedicato tronca, e le troncate restano righe', () => {
  const all = Array.from({ length: 120 }, (_, i) => sess(`s${i}`, 120 - i));
  const a = assembleSessionList(all, all, new Map(), 100);
  assert.equal(a.contextTotal, 120);
  assert.equal(a.rows.length, 100);
  assert.equal(a.overflowRows.length, 20, 'le troncate restano raggiungibili, mai silenziose');
});
