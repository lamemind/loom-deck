import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSessionList,
  firstSelectableId,
  moveSelection,
  neighborId,
  unpinLandingId,
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
  bodies: [],
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

test('vicino: attraversa il separatore senza fermarcisi', () => {
  const all = [sess('p1'), sess('c1')];
  const a = assembleSessionList([sess('c1')], all, new Map([['p1', 0]]), 30);
  assert.deepEqual(kinds(a.rows), ['pinned', 'separator', 'context']);
  assert.equal(neighborId(a.rows, 'p1'), 'c1', 'il separatore non è una destinazione');
});

test('unpin: si atterra sulla pinnata successiva', () => {
  const all = [sess('p1'), sess('p2'), sess('p3'), sess('c1')];
  // Rango desc → l'ultima pinnata sta in cima: p3, p2, p1.
  const pins = new Map([['p1', 0], ['p2', 1], ['p3', 2]]);
  const a = assembleSessionList([sess('c1')], all, pins, 30);
  assert.deepEqual(ids(a.rows), ['p3', 'p2', 'p1', 'c1']);
  assert.equal(unpinLandingId(a.rows, 'p3'), 'p2');
  assert.equal(unpinLandingId(a.rows, 'p2'), 'p1');
});

test('unpin: sull’ultima pinnata si risale, non si scavalca il gruppo', () => {
  const all = [sess('p1'), sess('p2'), sess('c1')];
  const a = assembleSessionList([sess('c1')], all, new Map([['p1', 0], ['p2', 1]]), 30);
  assert.equal(unpinLandingId(a.rows, 'p1'), 'p2');
  assert.equal(neighborId(a.rows, 'p1'), 'c1', 'il vicino generico esce dal gruppo');
});

test('unpin: gruppo che si svuota → prima contestuale', () => {
  const all = [sess('p1'), sess('c1', 3), sess('c2', 2)];
  const a = assembleSessionList([sess('c1', 3), sess('c2', 2)], all, new Map([['p1', 0]]), 30);
  assert.equal(unpinLandingId(a.rows, 'p1'), 'c1');
});

test('unpin: unica pinnata senza contestuali, o riga non pinnata → null', () => {
  const only = assembleSessionList([], [sess('p1')], new Map([['p1', 0]]), 30);
  assert.equal(unpinLandingId(only.rows, 'p1'), null);
  const ctx = [sess('c1'), sess('c2')];
  const a = assembleSessionList(ctx, ctx, new Map(), 30);
  assert.equal(unpinLandingId(a.rows, 'c1'), null, 'una contestuale non si spinna');
  assert.equal(unpinLandingId([], 'p1'), null);
});

test('cambio di parent: la sessione riassegnata esce dal gruppo contestuale', () => {
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

test('cambio di parent su una PINNATA: resta in lista (esente dal contesto), senza duplicarsi', () => {
  const all = [sess('s1', 3), sess('s2', 2)];
  const pin = new Map([['s1', 0]]);
  // s1 pinnata e assegnata altrove: sparisce dalle contestuali di spot ma
  // resta nel blocco pinnate — una sola riga, non due.
  const a = assembleSessionList([sess('s2', 2)], all, pin, 30);
  assert.deepEqual(kinds(a.rows), ['pinned', 'separator', 'context']);
  assert.deepEqual(ids(a.rows), ['s1', 's2']);
  // E quando è ANCHE contestuale, il dedup la tiene solo fra le pinnate.
  const b = assembleSessionList([sess('s1', 3), sess('s2', 2)], all, pin, 30);
  assert.deepEqual(ids(b.rows), ['s1', 's2']);
});

test('vista "tutte" (T59): contesto === universo → nessun doppione delle pinnate', () => {
  // La riga meta `≡ tutte` passa `sessions` come PRIMO argomento, cioè lo stesso
  // array che fa da universo. È il caso limite del dedup: ogni pinnata è anche
  // contestuale, e senza il filtro comparirebbe due volte.
  const all = [sess('s1', 3), sess('s2', 2), sess('s3', 1)];
  const a = assembleSessionList(all, all, new Map([['s2', 0]]), 100);
  assert.deepEqual(kinds(a.rows), ['pinned', 'separator', 'context', 'context']);
  assert.deepEqual(ids(a.rows), ['s2', 's1', 's3']);
  assert.equal(a.contextTotal, 2, 'la pinnata non si conta due volte');
  assert.equal(a.contextHidden, 0);
});

test('vista "tutte" (T59): il cap dedicato tronca, e lo dichiara', () => {
  const all = Array.from({ length: 120 }, (_, i) => sess(`s${i}`, 120 - i));
  const a = assembleSessionList(all, all, new Map(), 100);
  assert.equal(a.contextTotal, 120);
  assert.equal(a.contextHidden, 20, 'le troncate restano contate, mai silenziose');
  assert.equal(a.rows.length, 100);
});
