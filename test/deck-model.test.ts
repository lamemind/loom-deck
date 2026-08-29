// T131 — le funzioni pure che l'estrazione del modello ha liberato.
//
// Erano codice inline nel corpo del componente, quindi irraggiungibili da
// qualunque test: `rollupChildren` portava scritto in un commento un invariante
// che nessuno verificava, ed è esattamente il tipo di cosa che smette di valere
// in silenzio. Qui l'invariante diventa un'asserzione.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childSessionsOf, rollupChildren, sessionColumns } from '../src/deck-model.js';
import { TASK_EMPTY } from '../src/glyphs.js';
import { termWidth } from '../src/width.js';
import type { Session } from '../src/sessions.js';
import type { SessionRow } from '../src/session-list.js';

const session = (sessionId: string, ts = 1_000): Session => ({
  sessionId,
  cwd: '/p',
  gitBranch: 'main',
  parentUuid: null,
  title: sessionId,
  ts,
  path: `/t/${sessionId}.jsonl`,
  sizeBytes: 10,
  turns: 1,
  customTitle: '',
  firstPrompt: '',
  lastReply: '',
  model: '',
});

const row = (sessionId: string, ts = 1_000): SessionRow => ({
  kind: 'session',
  sessionId,
  session: session(sessionId, ts),
});

// ── rollupChildren ────────────────────────────────────────────────────────

test('rollupChildren: conta i figli per task e le conversazioni senza binding', () => {
  const sessions = [session('a'), session('b'), session('c')];
  const bindings = new Map([
    ['a', 'T1'],
    ['b', 'T1'],
  ]);
  const { childCount, spotCount } = rollupChildren(sessions, bindings, new Map());
  assert.equal(childCount.get('T1'), 2);
  assert.equal(spotCount, 1, 'la conversazione senza binding è una spot');
});

test('rollupChildren: vive ≤ totali, anche per una viva che non ha ancora scritto', () => {
  // Il caso che ha motivato la derivazione in un ciclo solo: il registry dei
  // processi conosce `b` (è appena partita) ma il transcript non esiste ancora,
  // quindi `sessions` non la contiene. Due passaggi indipendenti produrrebbero
  // `1/0` — una viva senza totale.
  const sessions = [session('a')];
  const bindings = new Map([
    ['a', 'T1'],
    ['b', 'T1'],
  ]);
  const live = new Map<string, { status: 'idle' | 'busy' }>([
    ['a', { status: 'idle' }],
    ['b', { status: 'busy' }],
  ]);
  const { childCount, taskLive } = rollupChildren(sessions, bindings, live);
  const totali = childCount.get('T1') ?? 0;
  const vive = taskLive.get('T1')?.count ?? 0;
  assert.ok(vive <= totali, `vive (${vive}) devono restare ≤ totali (${totali})`);
  assert.equal(vive, 1, 'la conversazione senza transcript non conta come viva');
});

test('rollupChildren: fra N vive a stato misto vince busy', () => {
  const sessions = [session('a'), session('b')];
  const bindings = new Map([
    ['a', 'T1'],
    ['b', 'T1'],
  ]);
  const live = new Map<string, { status: 'idle' | 'busy' }>([
    ['a', { status: 'idle' }],
    ['b', { status: 'busy' }],
  ]);
  const { taskLive } = rollupChildren(sessions, bindings, live);
  assert.equal(taskLive.get('T1')?.status, 'busy');
  assert.equal(taskLive.get('T1')?.count, 2);
});

test('rollupChildren: una task senza conversazioni vive non compare in taskLive', () => {
  const { taskLive } = rollupChildren([session('a')], new Map([['a', 'T1']]), new Map());
  assert.equal(taskLive.has('T1'), false, 'nessuna viva ≠ zero vive: la riga non porta il glifo');
});

// ── sessionColumns ────────────────────────────────────────────────────────

test('sessionColumns: la colonna task è spenta fuori dalla vista tutte', () => {
  const rows = [row('a'), row('b')];
  const bindings = new Map([['a', 'T131']]);
  assert.equal(sessionColumns(rows, bindings, false).task, 0);
});

test('sessionColumns: la cella vuota entra nella colonna task', () => {
  // Un binding più stretto del segnaposto non deve stringere la colonna sotto
  // di esso, o le righe spot perdono l'allineamento.
  const rows = [row('a'), row('b')];
  const bindings = new Map([['a', 'T1']]);
  const { task } = sessionColumns(rows, bindings, true);
  assert.ok(
    task >= termWidth(TASK_EMPTY),
    `la colonna (${task}) deve contenere il segnaposto (${termWidth(TASK_EMPTY)})`,
  );
});

test('sessionColumns: la colonna task si misura sul binding più largo', () => {
  const rows = [row('a'), row('b')];
  const bindings = new Map([
    ['a', 'T1'],
    ['b', 'T1310'],
  ]);
  assert.equal(sessionColumns(rows, bindings, true).task, termWidth('T1310'));
});

test('sessionColumns: la colonna età non scende mai sotto due celle', () => {
  assert.equal(sessionColumns([], new Map(), false).age, 2);
});

// ── childSessionsOf ───────────────────────────────────────────────────────

test('childSessionsOf: la vista tutte restituisce la lista intera, ordine incluso', () => {
  const sessions = [session('a', 3), session('b', 2), session('c', 1)];
  const out = childSessionsOf(sessions, new Map(), null, true);
  assert.deepEqual(out.map((s) => s.sessionId), ['a', 'b', 'c']);
});

test('childSessionsOf: con una task selezionata restano le sue figlie', () => {
  const sessions = [session('a'), session('b'), session('c')];
  const bindings = new Map([
    ['a', 'T1'],
    ['b', 'T2'],
  ]);
  const out = childSessionsOf(sessions, bindings, 'T1', false);
  assert.deepEqual(out.map((s) => s.sessionId), ['a']);
});

test('childSessionsOf: senza task selezionata restano le spot, non tutte', () => {
  const sessions = [session('a'), session('b')];
  const bindings = new Map([['a', 'T1']]);
  const out = childSessionsOf(sessions, bindings, null, false);
  assert.deepEqual(out.map((s) => s.sessionId), ['b']);
});
