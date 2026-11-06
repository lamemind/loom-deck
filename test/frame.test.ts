// T131 — la geometria del frame, estratta da `cli.tsx` e finalmente misurabile.
//
// Un'invariante che il render non difende da solo e che finora viveva in un
// commento: le righe dichiarate cliccabili devono essere ESATTAMENTE quelle
// disegnate — un hit-test più lungo della lista fa reagire un click sul vuoto,
// uno più corto rende inerte l'ultima riga.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BARE_LABEL,
  frameGeometry,
  HEADER_BUTTON_SEP,
  headlineWidth,
  launchRow,
  restoreButton,
  restoreButtonForms,
  RESTORE_KEY,
  SURFACE_SEGMENTS,
} from '../src/frame.js';
import { FRAME_TEXT_COL, hitRegion } from '../src/mouse.js';
import { META_ROWS } from '../src/model.js';
import { termWidth } from '../src/width.js';
import type { LaunchEntry } from '../src/config.js';
import type { Task } from '../src/tasks.js';
import type { SessionRow } from '../src/session-list.js';
import type { Session } from '../src/sessions.js';

const task = (id: string): Task => ({
  id,
  pri: '⚡',
  prog: '🔵',
  desc: `task ${id}`,
  rawDesc: `task ${id}`,
});

const session = (sessionId: string): Session => ({
  sessionId,
  cwd: '/p',
  gitBranch: 'main',
  parentUuid: null,
  title: sessionId,
  ts: 1_000,
  path: `/t/${sessionId}.jsonl`,
  sizeBytes: 10,
  turns: 1,
  customTitle: '',
  firstPrompt: '',
  lastReply: '',
  firstPromptTs: 0,
  lastReplyTs: 0,
  model: '',
});

const row = (sessionId: string): SessionRow => ({
  kind: 'session',
  sessionId,
  session: session(sessionId),
});

const frameInput = (over: Partial<Parameters<typeof frameGeometry>[0]> = {}) =>
  frameGeometry({
    rows: 40,
    columns: 120,
    mode: 'normal',
    hasNote: false,
    previewKind: 'none',
    detailMetaLines: 0,
    sessionHasFirstPreview: false,
    sessionHasLastPreview: false,
    paneTasks: [task('T1'), task('T2'), task('T3')],
    selIndex: META_ROWS,
    sessionRows: [row('a'), row('b')],
    selSessionId: 'a',
    taskCounts: { filtered: 3, total: 3, hidden: 0, archivable: 0 },
    taskViewId: 'tasks',
    sessionCounts: { total: 2, live: 0, pinned: 0, older: 0 },
    sessionViewId: 'context',
    parentLabel: 'tutte',
    hasLoadError: false,
    deckMode: 'task',
    inboxFiles: [],
    selInboxPath: null,
    inboxCounts: { total: 0, nozioni: 0, derivazione: 0, sweep: 0 },
    inboxViewId: 'all',
    docRows: [],
    selDocPath: null,
    docCounts: { total: 0, split: 0, merge: 0, tldr: 0, regroup: 0 },
    docViewId: 'all',
    docHasDirs: false,
    restoreCount: 0,
    ...over,
  });

// ── launchRow: le colonne cliccabili sono quelle disegnate ────────────────

test('launchRow: senza voci configurate resta la sola surface `t`', () => {
  // T154/P9 — `c` non è più fra i segmenti di sinistra: è l'etichetta del
  // blocco a destra, che porta la propria region ma non un proprio segmento.
  const { segments, regions } = launchRow([], 120);
  assert.equal(segments.length, SURFACE_SEGMENTS.length);
  assert.equal(
    regions.length,
    segments.length + 1,
    'le regioni sono i segmenti di sinistra più la label del blocco a destra',
  );
  assert.ok(regions.some((r) => r.key === BARE_LABEL.key), 'la label `c 🤖` deve essere cliccabile');
});

test('launchRow: ogni voce presa porta il proprio tasto-cifra', () => {
  const entries: LaunchEntry[] = [
    { emoji: '📝', label: 'codium', command: 'codium .' },
    { emoji: '🧩', label: 'idea', command: 'idea .' },
  ];
  const { segments } = launchRow(entries, 200);
  const keys = segments.map((s) => s.key);
  assert.deepEqual(keys, ['t', '1', '2'], 'le cifre partono da 1 dopo la surface `t`');
});

// ── T154 · il blocco selettore della nuda, ancorato a destra ─────────────

test('launchRow: il blocco a destra non sfonda il bordo, con qualunque riempimento', () => {
  for (const columns of [60, 80, 100, 120, 176]) {
    const { segments, filler, regions } = launchRow([], columns);
    const leftWidth = termWidth(segments.map((s) => s.text).join(' · '));
    const bare = regions.find((r) => r.key === BARE_LABEL.key)!;
    assert.ok(bare, `nessuna region per la label a ${columns} colonne`);
    // La label comincia esattamente dove finiscono sinistra + riempimento: un
    // conto sbagliato sposterebbe il bersaglio del click senza spostare il
    // disegno, o viceversa.
    assert.equal(bare.start, 3 + leftWidth + termWidth(filler));
    assert.ok(termWidth(filler) >= 1, `nessun riempimento a ${columns} colonne`);
  }
});

test('launchRow: il riempimento non è mai negativo su un terminale strettissimo', () => {
  // `repeat` lancia su un numero negativo: il pavimento a 1 (P5) deve tenere
  // anche quando sinistra + blocco eccedono la larghezza disponibile.
  assert.doesNotThrow(() => launchRow([], 20));
});

test('launchRow: la riga non sfonda la larghezza del terminale', () => {
  // Le celle delle surface sono già spese: se non fossero riservate, le voci
  // launch le sfonderebbero di quel tanto.
  const entries: LaunchEntry[] = Array.from({ length: 9 }, (_, i) => ({
    emoji: '📝',
    label: `voce-lunga-numero-${i}`,
    command: 'x',
  }));
  const columns = 60;
  const { segments } = launchRow(entries, columns);
  const disegnata = segments.map((s) => s.text).join(' · ');
  assert.ok(
    termWidth(disegnata) <= columns,
    `riga larga ${termWidth(disegnata)} su ${columns} colonne: ${disegnata}`,
  );
});

test('launchRow: le voci oltre la nona sono dichiarate irraggiungibili', () => {
  const entries: LaunchEntry[] = Array.from({ length: 11 }, (_, i) => ({
    emoji: '📝',
    label: `v${i}`,
    command: 'x',
  }));
  const { unreachable } = launchRow(entries, 400);
  assert.equal(unreachable, 2, 'due voci non hanno un tasto-cifra che le raggiunga');
});

// ── frameGeometry: hit-test == disegno ────────────────────────────────────

test('frameGeometry: le righe task cliccabili sono le meta più quelle in finestra', () => {
  const f = frameInput();
  assert.ok(f.listGeometry, 'con un terminale alto la geometria esiste');
  assert.equal(
    f.listGeometry!.taskRows,
    META_ROWS + f.windowTasks.length,
    'un hit-test più lungo della finestra fa reagire un click sul vuoto',
  );
  assert.equal(f.listGeometry!.sessionRows, f.windowRows.length);
});

test('frameGeometry: con tasks.md illeggibile restano cliccabili le sole righe meta', () => {
  // Al posto delle task c'è la riga rossa: nessuna riga task è colpibile.
  const f = frameInput({ hasLoadError: true });
  assert.equal(f.listGeometry!.taskRows, META_ROWS);
});

test('frameGeometry: in compatto non esiste geometria da colpire', () => {
  const f = frameInput({ rows: 6 });
  assert.equal(f.budget.compact, true, 'sei righe sono sotto la soglia del layout a box');
  assert.equal(f.listGeometry, null, 'senza pane non c\'è nulla da colpire');
});

test('frameGeometry: la finestra non eccede mai la lista che taglia', () => {
  const molte = Array.from({ length: 200 }, (_, i) => task(`T${i}`));
  const f = frameInput({ paneTasks: molte, selIndex: META_ROWS + 100 });
  assert.ok(f.windowTasks.length <= molte.length);
  assert.equal(f.windowTasks.length, f.taskWin.end - f.taskWin.start);
  assert.ok(f.taskWin.end <= molte.length, 'la finestra non sborda la lista');
});

test('frameGeometry: la riga launch esiste solo in modalità normale', () => {
  assert.equal(frameInput({ mode: 'normal' }).launchLine, true);
  assert.equal(frameInput({ mode: 'search' }).launchLine, false);
});

test('frameGeometry: la testata porta risoluzione e versione', () => {
  const f = frameInput({ columns: 100, rows: 30 });
  assert.match(f.headerRight, /^100×30 · v\d+\.\d+\.\d+$/, `testata inattesa: ${f.headerRight}`);
});

test('headlineWidth: il budget sinistro lascia posto al segmento destro', () => {
  const columns = 100;
  const right = '100×30 · v0.55.0';
  const left = headlineWidth(columns, right);
  assert.ok(left + termWidth(right) < columns, 'i due segmenti devono stare nella riga');
  assert.ok(left >= 4, 'il budget non scende sotto il minimo nemmeno su un terminale stretto');
  assert.equal(headlineWidth(10, right), 4, 'su terminale strettissimo resta il pavimento');
});

// ── T181: il bottone di restore in testata ──────────────────────────────────

test('restoreButton: niente da riaprire → niente bottone', () => {
  assert.equal(restoreButton(0, 120, '120×40 · v1.0.0'), null);
});

test('restoreButton: la forma lunga quando c’è spazio, al singolare con una sola', () => {
  assert.equal(restoreButton(3, 120, '120×40 · v1.0.0'), '[ restore 3 sessions ]');
  assert.equal(restoreButton(1, 120, '120×40 · v1.0.0'), '[ restore 1 session ]');
});

test('restoreButton: su un terminale stretto cede alla forma corta, poi sparisce', () => {
  const right = '40×24 · v1.0.0';
  const forms = restoreButtonForms(12);
  // La prima forma che lascia almeno 4 colonne al project status.
  const fits = (form: string, cols: number) =>
    cols - 4 - termWidth(form) - termWidth(HEADER_BUTTON_SEP) - termWidth(right) - 1 >= 4;
  for (let cols = 10; cols <= 80; cols++) {
    const got = restoreButton(12, cols, right);
    const expected = forms.find((f) => fits(f, cols)) ?? null;
    assert.equal(got, expected, `a ${cols} colonne`);
  }
  assert.equal(restoreButton(12, 10, right), null, 'nessuna forma entra in 10 colonne');
});

test('frameGeometry: senza restore la testata è quella di sempre, nessuna regione', () => {
  const f = frameInput();
  assert.equal(f.headerButton, null);
  assert.equal(f.headerBlock, f.headerRight);
  assert.deepEqual(f.headerRegions, []);
});

test('frameGeometry: il bottone sta a sinistra di risoluzione e versione, ancorato al bordo', () => {
  for (const columns of [80, 100, 176]) {
    const f = frameInput({ columns, restoreCount: 3 });
    assert.equal(f.headerButton, '[ restore 3 sessions ]');
    assert.equal(f.headerBlock, `${f.headerButton}${HEADER_BUTTON_SEP}${f.headerRight}`);
    // Il blocco finisce sull'ultima colonna di testo del box esterno.
    const lastTextCol = FRAME_TEXT_COL + columns - 4 - 1;
    const [r] = f.headerRegions;
    assert.ok(r, `nessuna regione a ${columns} colonne`);
    assert.equal(r.key, RESTORE_KEY);
    assert.equal(r.end - r.start + 1, termWidth(f.headerButton!));
    assert.equal(r.start + termWidth(f.headerBlock) - 1, lastTextCol, `bordo a ${columns} colonne`);
    // La sinistra riceve esattamente il resto: nessuna colonna in più, nessuna in meno.
    assert.equal(headlineWidth(columns, f.headerBlock) + 1 + termWidth(f.headerBlock), columns - 4);
    // Click sul bottone sì, sul separatore e sulla risoluzione no.
    assert.equal(hitRegion(f.headerRegions, r.start), RESTORE_KEY);
    assert.equal(hitRegion(f.headerRegions, r.end), RESTORE_KEY);
    assert.equal(hitRegion(f.headerRegions, r.end + 1), null);
    assert.equal(hitRegion(f.headerRegions, lastTextCol), null);
  }
});
