// T131 — la geometria del frame, estratta da `cli.tsx` e finalmente misurabile.
//
// Due invarianti che il render non difende da solo e che finora vivevano in un
// commento: la legenda non deve MENTIRE sul bersaglio di `CANC` (una voce che
// annuncia «tutte» dove il tasto ne pota una sola è peggio di nessuna voce), e
// le righe dichiarate cliccabili devono essere ESATTAMENTE quelle disegnate —
// un hit-test più lungo della lista fa reagire un click sul vuoto, uno più
// corto rende inerte l'ultima riga.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckLegend, frameGeometry, headlineWidth, launchRow, SURFACE_SEGMENTS } from '../src/frame.js';
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
    rightPane: 'sessions',
    inboxFiles: [],
    selInboxPath: null,
    inboxCounts: { total: 0, nozioni: 0, derivazione: 0, sweep: 0 },
    inboxViewId: 'all',
    ...over,
  });

// ── deckLegend: la voce che nomina il bersaglio ───────────────────────────

test('deckLegend: CANC nomina il bersaglio singolo quando il bulk è spento', () => {
  const legend = deckLegend({
    focus: 'tasks',
    hasTask: true,
    hasSession: false,
    hasSessionId: false,
    purgeBulk: false,
    inboxPane: false,
  });
  assert.ok(legend.includes('CANC elimina'), 'la voce deve esserci');
  assert.ok(
    !legend.includes('CANC elimina tutte'),
    `la voce annuncia il bulk dove il tasto pota una sola task: ${legend}`,
  );
});

test('deckLegend: CANC nomina il bulk quando il bulk è acceso', () => {
  const legend = deckLegend({
    focus: 'tasks',
    hasTask: false,
    hasSession: false,
    hasSessionId: false,
    purgeBulk: true,
    inboxPane: false,
  });
  assert.ok(legend.includes('CANC elimina tutte'), `bulk non annunciato: ${legend}`);
});

test('deckLegend: col focus sulle sessioni non c\'è nessuna voce CANC', () => {
  // `CANC` col focus altrove è inerte e lo dice con una nota: annunciarlo in
  // legenda prometterebbe un'azione che non parte.
  const legend = deckLegend({
    focus: 'sessions',
    hasTask: true,
    hasSession: true,
    hasSessionId: true,
    purgeBulk: true,
    inboxPane: false,
  });
  assert.ok(!legend.includes('CANC'), `voce CANC fuori dal suo pane: ${legend}`);
});

test('deckLegend: le voci contestuali seguono il pane a fuoco', () => {
  const suTask = deckLegend({
    focus: 'tasks',
    hasTask: true,
    hasSession: false,
    hasSessionId: false,
    purgeBulk: false,
    inboxPane: false,
  });
  assert.ok(suTask.includes('⏎ detail'), 'sul pane task ⏎ apre il detail');
  assert.ok(!suTask.includes('f fork'), 'il fork non vive sul pane task');

  const suSessioni = deckLegend({
    focus: 'sessions',
    hasTask: false,
    hasSession: true,
    hasSessionId: true,
    purgeBulk: false,
    inboxPane: false,
  });
  assert.ok(suSessioni.includes('⏎ resume'), 'sul pane sessioni ⏎ fa il resume');
  assert.ok(suSessioni.includes('f fork'), 'il fork vive qui');
});

test('deckLegend: su una pinnata stale restano pin/titolo/assegna, non il fork', () => {
  // Il transcript non c'è più (`hasSession` falso) ma la riga è selezionata:
  // spinnarla, annotarla e riassegnarla restano legittimi, forkarla no.
  const legend = deckLegend({
    focus: 'sessions',
    hasTask: false,
    hasSession: false,
    hasSessionId: true,
    purgeBulk: false,
    inboxPane: false,
  });
  assert.ok(legend.includes('p pin'), `il pin deve restare: ${legend}`);
  assert.ok(legend.includes('A assegna'), `l'assegnazione deve restare: ${legend}`);
  assert.ok(!legend.includes('f fork'), `niente da forkare: ${legend}`);
});

// ── launchRow: le colonne cliccabili sono quelle disegnate ────────────────

test('launchRow: senza voci configurate restano le due surface built-in', () => {
  const { segments, regions } = launchRow([], 120);
  assert.equal(segments.length, SURFACE_SEGMENTS.length);
  assert.equal(regions.length, segments.length, 'una regione per segmento disegnato');
});

test('launchRow: ogni voce presa porta il proprio tasto-cifra', () => {
  const entries: LaunchEntry[] = [
    { emoji: '📝', label: 'codium', command: 'codium .' },
    { emoji: '🧩', label: 'idea', command: 'idea .' },
  ];
  const { segments } = launchRow(entries, 200);
  const keys = segments.map((s) => s.key);
  assert.deepEqual(keys, ['t', 'c', '1', '2'], 'le cifre partono da 1 dopo le due surface');
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
