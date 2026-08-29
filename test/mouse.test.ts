// T21 — unit del MOUSE: parse delle sequenze SGR e hit-test sulle superfici.
//
// Le forme sotto misura non sono inventate: vengono da uno spike sotto pty in
// cui un'app Ink stampava ciò che `useInput` le consegnava. Il gate pty
// (`modes-smoke.test.ts`) verifica che un click faccia l'azione giusta sul deck
// vero; questi unit fissano la grammatica che quel gate non può isolare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_TEXT_COL,
  hitRegion,
  inlineRegions,
  isWheel,
  listHit,
  PANE_BODY_ROW,
  PANE_HEADER_ROW,
  paneSpans,
  rowRegions,
  takeMouse,
  TASK_LIST_ROW,
  WHEEL_LINES,
  wheelDir,
  type ListGeometry,
} from '../src/mouse.js';
import { headerItems, taskHeaderParts } from '../src/pane-header.js';

test('takeMouse: sequenza pura, ESC iniziale strippato da Ink', () => {
  const { text, events } = takeMouse('[<0;5;3M');
  assert.equal(text, '');
  assert.deepEqual(events, [{ button: 0, col: 5, row: 3, press: true }]);
});

test('takeMouse: il rilascio si distingue dalla pressione', () => {
  const { events } = takeMouse('[<0;5;3m');
  assert.equal(events[0].press, false);
});

test('takeMouse: chunk misto tasto+mouse, ESC interno PRESERVATO', () => {
  // Ink strippa l'ESC solo quando la sequenza apre il chunk. Qui la `a` la
  // precede, quindi l'ESC arriva intero — e va consumato col resto, o
  // resterebbe un ESC orfano dentro il testo restituito alla tastiera.
  const { text, events } = takeMouse('a\x1b[<0;7;2M');
  assert.equal(text, 'a');
  assert.deepEqual(events, [{ button: 0, col: 7, row: 2, press: true }]);
});

test('takeMouse: più eventi nello stesso chunk, in ordine di arrivo', () => {
  const { text, events } = takeMouse('[<0;5;3M[<0;5;3m');
  assert.equal(text, '');
  assert.deepEqual(
    events.map((e) => e.press),
    [true, false],
  );
});

test('takeMouse: testo senza sequenze passa invariato', () => {
  const { text, events } = takeMouse('ciao');
  assert.equal(text, 'ciao');
  assert.equal(events.length, 0);
});

test('takeMouse: sequenza MONCA resta testo, non viene bufferizzata', () => {
  // Una sequenza spezzata su due scritture arriva come due chiamate monche.
  // Nessuna delle due è parseabile da sola: il click si perde, e il frammento
  // torna alla tastiera invece di restare in un buffer che nessuno svuota.
  const { text, events } = takeMouse('[<0;5');
  assert.equal(text, '[<0;5');
  assert.equal(events.length, 0);
});

test('isWheel: il bit 6 separa la rotella dai bottoni', () => {
  assert.equal(isWheel(0), false);
  assert.equal(isWheel(2), false);
  assert.equal(isWheel(64), true);
  assert.equal(isWheel(65), true);
});

test('wheelDir: su e giù dal bit 0, modificatori ignorati', () => {
  assert.equal(wheelDir(64), -1);
  assert.equal(wheelDir(65), 1);
  // Shift (bit 2), meta (bit 3), ctrl (bit 4) sopra la rotella: il verso non
  // cambia. Un terminale li manda quando si scorre tenendo premuto il tasto.
  assert.equal(wheelDir(64 + 4), -1);
  assert.equal(wheelDir(65 + 8), 1);
  assert.equal(wheelDir(65 + 16), 1);
});

test('wheelDir: la rotella orizzontale e i bottoni valgono zero', () => {
  // 66/67 = rotella orizzontale: il deck non ha nulla da scorrere in largo, e
  // tradurla in verticale scorrerebbe un testo che nessuno ha chiesto.
  assert.equal(wheelDir(66), 0);
  assert.equal(wheelDir(67), 0);
  assert.equal(wheelDir(0), 0);
  assert.equal(wheelDir(2), 0);
});

test('takeMouse: la rotella arriva come sola pressione', () => {
  // Nessun rilascio dopo una tacca: il chiamante non deve dedoppiare come fa
  // per il click, e un `press` vero è ciò che la fa passare dal filtro.
  const { events } = takeMouse('[<64;10;10M');
  assert.deepEqual(events, [{ button: 64, col: 10, row: 10, press: true }]);
});

test('WHEEL_LINES: più di una riga, meno di una pagina', () => {
  assert.ok(WHEEL_LINES > 1 && WHEEL_LINES < 10);
});

test('rowRegions: colonne 1-based, separatore contato fra le voci', () => {
  // `ab` (2 celle) a colonna 3 → 3..4; separatore ` · ` (3 celle) → la voce
  // dopo comincia a 8.
  const regions = rowRegions([{ key: 't', text: 'ab' }, { key: 'c', text: 'xyz' }], ' · ', 3);
  assert.deepEqual(regions, [
    { key: 't', start: 3, end: 4 },
    { key: 'c', start: 8, end: 10 },
  ]);
});

test('rowRegions: una emoji occupa DUE colonne', () => {
  // È la ragione per cui la larghezza qui è quella del terminale e non la stima
  // prudente di `cellWidth`: una colonna di troppo sposta il bersaglio.
  const [r] = rowRegions([{ key: 't', text: 't 💻' }], ' · ', 3);
  assert.deepEqual(r, { key: 't', start: 3, end: 6 });
});

test('rowRegions: un segmento vuoto non produce regione ma consuma il separatore', () => {
  const regions = rowRegions([{ key: 'a', text: '' }, { key: 'b', text: 'xy' }], ' · ', 1);
  assert.deepEqual(regions, [{ key: 'b', start: 4, end: 5 }]);
});

test('hitRegion: dentro, sui bordi, e fuori', () => {
  const regions = [
    { key: 't', start: 3, end: 6 },
    { key: 'c', start: 10, end: 13 },
  ];
  assert.equal(hitRegion(regions, 3), 't');
  assert.equal(hitRegion(regions, 6), 't');
  assert.equal(hitRegion(regions, 10), 'c');
  assert.equal(hitRegion(regions, 13), 'c');
  // Lo spazio fra due superfici è terra di nessuno: un click lì non deve
  // attivare la voce vicina.
  assert.equal(hitRegion(regions, 7), null);
  assert.equal(hitRegion(regions, 2), null);
  assert.equal(hitRegion(regions, 99), null);
});

// ── mandata 3: hit-test delle liste ─────────────────────────────────────────

test('paneSpans: i due pane si dividono l\'interno, la colonna di margine non è di nessuno', () => {
  // 120 colonne, misurate sotto pty: pane task 3..60, margine 61, sessioni 62..118.
  const s = paneSpans(120);
  assert.deepEqual(s.tasks, { start: FRAME_TEXT_COL, end: 60 });
  assert.deepEqual(s.sessions, { start: 62, end: 118 });
  // Interno dispari: lo shrink di Yoga toglie mezza colonna a testa e il pane
  // task resta `floor`, come `paneTextWidth`.
  const odd = paneSpans(121);
  assert.equal(odd.tasks.end, 60);
  assert.deepEqual(odd.sessions, { start: 62, end: 119 });
});

test('inlineRegions: il separatore in testa a una parte non fa parte della regione', () => {
  const r = inlineRegions(
    [
      { key: 'a', text: 'Tasks (3)' },
      { key: 'b', text: ' · 2 nascoste' },
      { key: null, text: ' · ↓4' },
    ],
    5,
  );
  assert.deepEqual(r, [
    { key: 'a', start: 5, end: 13 },
    { key: 'b', start: 17, end: 26 },
  ]);
  // Colonne 14..16 sono il ` · `: nessuna vista risponde.
  assert.equal(hitRegion(r, 15), null);
});

test('inlineRegions: una parte caduta al taglio non consuma colonne', () => {
  const r = inlineRegions(
    [
      { key: 'a', text: 'A' },
      { key: 'b', text: '' },
      { key: 'c', text: ' · C' },
    ],
    1,
  );
  assert.deepEqual(r, [
    { key: 'a', start: 1, end: 1 },
    { key: 'c', start: 5, end: 5 },
  ]);
});

test('headerItems + inlineRegions: le regioni seguono il testo TAGLIATO, non quello intero', () => {
  // Budget stretto: `paneTextWidth(40)` = 14 colonne. Resta la voce attiva e
  // ciò che ci sta intero; le parti cadute non hanno regione.
  const h = taskHeaderParts({ filtered: 3, total: 9, hidden: 6, archivable: 2 }, 'tasks', 0, 0, 40);
  const items = headerItems(h);
  assert.equal(items[0]!.text.startsWith('Tasks'), true);
  const r = inlineRegions(items, 5);
  assert.equal(r[0]!.key, 'tasks');
  assert.equal(r.some((x) => x.key === 'archivable'), false, 'una parte caduta ha una regione');
});

const GEOMETRY: ListGeometry = {
  columns: 120,
  taskHeader: [{ key: 'tasks', start: 5, end: 17 }, { key: 'hidden', start: 21, end: 31 }],
  sessionHeader: [{ key: 'context', start: 75, end: 85 }],
  inboxHeader: [{ key: 'all', start: 75, end: 84 }],
  taskRows: 2 + 5, // due meta + cinque task
  sessionRows: 4,
  inboxRows: 3,
  rightPane: 'sessions',
};

test('listHit: header → vista, col separatore e il nome del pane inerti', () => {
  assert.deepEqual(listHit({ col: 25, row: PANE_HEADER_ROW }, GEOMETRY), {
    pane: 'tasks',
    target: 'view',
    key: 'hidden',
  });
  assert.deepEqual(listHit({ col: 80, row: PANE_HEADER_ROW }, GEOMETRY), {
    pane: 'sessions',
    target: 'view',
    key: 'context',
  });
  assert.equal(listHit({ col: 19, row: PANE_HEADER_ROW }, GEOMETRY), null);
  assert.equal(listHit({ col: 65, row: PANE_HEADER_ROW }, GEOMETRY), null);
});

test('listHit: pane task — riga sort inerte, meta e task per indice di finestra', () => {
  assert.equal(listHit({ col: 10, row: PANE_BODY_ROW }, GEOMETRY), null, 'la riga sort ha risposto');
  assert.deepEqual(listHit({ col: 10, row: TASK_LIST_ROW }, GEOMETRY), {
    pane: 'tasks',
    target: 'row',
    index: 0,
  });
  assert.deepEqual(listHit({ col: 10, row: TASK_LIST_ROW + 1 }, GEOMETRY), {
    pane: 'tasks',
    target: 'row',
    index: 1,
  });
  assert.deepEqual(listHit({ col: 60, row: TASK_LIST_ROW + 6 }, GEOMETRY), {
    pane: 'tasks',
    target: 'row',
    index: 6,
  });
  // Sotto l'ultima task c'è spazio vuoto: nessuna riga.
  assert.equal(listHit({ col: 10, row: TASK_LIST_ROW + 7 }, GEOMETRY), null);
});

test('listHit: pane sessioni — prima riga subito sotto l\'header, oltre la finestra niente', () => {
  assert.deepEqual(listHit({ col: 70, row: PANE_BODY_ROW }, GEOMETRY), {
    pane: 'sessions',
    target: 'row',
    index: 0,
  });
  assert.deepEqual(listHit({ col: 118, row: PANE_BODY_ROW + 3 }, GEOMETRY), {
    pane: 'sessions',
    target: 'row',
    index: 3,
  });
  assert.equal(listHit({ col: 70, row: PANE_BODY_ROW + 4 }, GEOMETRY), null);
});

// T134 — lo slot destro ospita uno dei due pane, e `rightPane` decide QUALE
// catalogo il click interroga. Senza, un click sull'header del pane inbox
// tornerebbe una chiave del catalogo delle sessioni: una vista che esiste, con
// un id che il pane montato non conosce, e nessun errore.
test('listHit: col pane inbox montato il click destro parla di inbox', () => {
  const g: ListGeometry = { ...GEOMETRY, rightPane: 'inbox' };
  assert.deepEqual(listHit({ col: 80, row: PANE_HEADER_ROW }, g), {
    pane: 'inbox',
    target: 'view',
    key: 'all',
  });
  assert.deepEqual(listHit({ col: 70, row: PANE_BODY_ROW + 2 }, g), {
    pane: 'inbox',
    target: 'row',
    index: 2,
  });
  // Le righe del pane inbox sono le sue, non quelle delle sessioni: oltre la
  // terza non c'è niente da colpire anche se le sessioni ne avrebbero quattro.
  assert.equal(listHit({ col: 70, row: PANE_BODY_ROW + 3 }, g), null);
  // Il pane task non cambia: lo slot destro non lo tocca.
  assert.deepEqual(listHit({ col: 10, row: TASK_LIST_ROW }, g), {
    pane: 'tasks',
    target: 'row',
    index: 0,
  });
});

test('listHit: margine fra i pane, bordo esterno e righe sopra i pane sono inerti', () => {
  assert.equal(listHit({ col: 61, row: TASK_LIST_ROW }, GEOMETRY), null, 'il margine ha risposto');
  assert.equal(listHit({ col: 1, row: TASK_LIST_ROW }, GEOMETRY), null);
  assert.equal(listHit({ col: 120, row: TASK_LIST_ROW }, GEOMETRY), null);
  assert.equal(listHit({ col: 10, row: PANE_HEADER_ROW - 1 }, GEOMETRY), null, 'il bordo del pane ha risposto');
});
