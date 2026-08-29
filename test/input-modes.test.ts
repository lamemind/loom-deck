import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captures,
  CAPTURING_MODES,
  CTRL_DEROGATIONS,
  scrolls,
  SCROLLING_MODES,
} from '../src/input-modes.js';
import type { Mode } from '../src/model.js';

// Ogni valore che `Mode` può assumere. Elencato a mano APPOSTA: se il tipo
// guadagna un modo e nessuno lo aggiunge qui, il test sotto lo scopre.
const ALL_MODES: Mode[] = [
  'normal',
  'create',
  'sort',
  'filter',
  'edit',
  'search',
  'reader',
  'note',
  'assign',
  'detail',
  'purge',
  'status',
  'inbox',
  'wrap',
];

test('normal è l\'unico modo non capturing', () => {
  const nonCapturing = ALL_MODES.filter((m) => !captures(m));
  assert.deepEqual(nonCapturing, ['normal']);
});

test('il catalogo copre ogni modo diverso da normal', () => {
  const expected = ALL_MODES.filter((m) => m !== 'normal').sort();
  assert.deepEqual([...CAPTURING_MODES].sort(), expected);
});

// Questa è l'informazione che prima viveva solo nell'ordine testuale delle `if`:
// dentro il detail gli acceleratori `^K`/`^P`/`^R` NON spawnano. Se qualcuno
// declassasse `detail` a non-capturing, il ramo `key.ctrl` del modo normale
// tornerebbe raggiungibile e la regressione sarebbe silenziosa a schermo.
test('detail cattura, quindi gli acceleratori globali sono inerti', () => {
  assert.equal(captures('detail'), true);
});

// L'unica deroga: `^F` dentro il detail apre la ricerca nel testo, non quella
// sulle conversazioni. Il modo se la gestisce da sé — il catalogo la dichiara
// perché un'eccezione che vive solo in un `if` annidato è come non averla.
test('la sola deroga ctrl dichiarata è ^F dentro detail', () => {
  assert.deepEqual(Object.keys(CTRL_DEROGATIONS), ['detail']);
  assert.deepEqual(CTRL_DEROGATIONS.detail, ['f']);
});

// T112 — `purge` è il primo modo capturing SENZA campo di testo. Cattura come
// gli altri (dentro una conferma nessun acceleratore globale deve restare vivo)
// e non deroga a niente: una domanda binaria non ha acceleratori da salvare.
test('purge cattura e non ha deroghe ctrl', () => {
  assert.equal(captures('purge'), true);
  assert.equal(CTRL_DEROGATIONS.purge, undefined);
});

test('un modo fuori catalogo non risulta capturing', () => {
  assert.equal(captures('normal'), false);
});

// T21 (mandata 2) — la rotella scorre il TESTO, mai una selezione (D5). I tre
// modi scorrevoli sono quelli con un documento e nessuna lista a fuoco:
// `search` ha un'anteprima ma il fuoco è sui risultati, che sono una scelta.
test('i modi scorrevoli sono i viewer di testo', () => {
  assert.deepEqual([...SCROLLING_MODES].sort(), ['detail', 'inbox', 'reader', 'status', 'wrap']);
});

test('ogni modo scorrevole è anche capturing', () => {
  for (const m of SCROLLING_MODES) assert.equal(captures(m), true);
});

test('la rotella è inerte in normal e nelle liste', () => {
  assert.equal(scrolls('normal'), false);
  assert.equal(scrolls('search'), false);
  assert.equal(scrolls('assign'), false);
});
