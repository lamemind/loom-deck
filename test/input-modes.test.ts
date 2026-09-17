import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captures,
  CAPTURING_MODES,
  CTRL_DEROGATIONS,
  inertNote,
  scrolls,
  SCROLLING_MODES,
  TASK_MODE_KEYS,
  TASK_MODE_LEGEND,
  taskModeKey,
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
  'doc',
  'wrap',
  'spawn',
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
  assert.deepEqual(
    [...SCROLLING_MODES].sort(),
    ['detail', 'doc', 'inbox', 'reader', 'status', 'wrap'],
  );
});

test('ogni modo scorrevole è anche capturing', () => {
  for (const m of SCROLLING_MODES) assert.equal(captures(m), true);
});

test('la rotella è inerte in normal e nelle liste', () => {
  assert.equal(scrolls('normal'), false);
  assert.equal(scrolls('search'), false);
  assert.equal(scrolls('assign'), false);
});

// ── T160 · i tasti del mondo task ────────────────────────────────────────
//
// L'insieme ha DUE lettori — il dispatch che li rende inerti e la legenda che
// smette di annunciarli — e il punto di tenerlo in un dato solo è che non
// possano divergere. Qui si fissa cosa c'è dentro e cosa deve restarne fuori:
// un tasto che entrasse per sbaglio diventerebbe inerte in modo doc senza che
// niente lo segnali, uno che ne uscisse resterebbe attivo su una selezione che
// non è a schermo.

test('l\'insieme gated è quello di P8, e la riga launch non ci sta dentro', () => {
  assert.deepEqual(
    TASK_MODE_KEYS.map((k) => k.label),
    ['^K', '^P', '^R', 'CANC', 'C', 'E', 'S', 'F', 'w'],
  );
});

test('taskModeKey riconosce le tre forme di chord, e solo quelle', () => {
  assert.equal(taskModeKey('k', true, false), '^K');
  assert.equal(taskModeKey('', false, true), 'CANC');
  assert.equal(taskModeKey('E', false, false), 'E');
  // `w` è gated e `^W` no: sono due tasti diversi, e il secondo apre la lista
  // hard-wrap, che col mondo task non c'entra.
  assert.equal(taskModeKey('w', false, false), 'w');
  assert.equal(taskModeKey('w', true, false), null);
  // `^S` apre la pagina delle azioni: la `S` nuda è il sort, gated.
  assert.equal(taskModeKey('s', true, false), null);
  assert.equal(taskModeKey('S', false, false), 'S');
});

test('restano vivi i tasti che non dipendono dalla selezione task', () => {
  // La riga launch (`t`, `c`, le cifre) apre comandi a project root: vale in
  // entrambi i modi (D2). Gli acceleratori di sensori e pagine misurano il
  // progetto, non una task.
  for (const [input, ctrl] of [
    ['t', false],
    ['c', false],
    ['1', false],
    ['m', false],
    ['f', false],
    ['p', false],
    ['a', false],
    ['b', true],
    ['f', true],
    ['g', true],
    ['o', true],
    ['e', true],
    ['u', true],
  ] as const) {
    assert.equal(
      taskModeKey(input, ctrl, false),
      null,
      `${ctrl ? '^' : ''}${input} non deve essere gated`,
    );
  }
});

test('le voci di legenda escono dallo stesso elenco del dispatch', () => {
  // I quattro a `null` sono quelli la cui voce è già condizionata dal focus:
  // scriverli qui obbligherebbe l'elenco a conoscere focus e bulk.
  assert.deepEqual(TASK_MODE_LEGEND, ['C nuova', 'E edit', 'S sort', 'F filtri', 'w salva']);
  for (const k of TASK_MODE_KEYS) {
    if (k.legend === null) continue;
    assert.ok(
      k.legend.startsWith(k.label),
      `la voce "${k.legend}" non apre col tasto che annuncia (${k.label})`,
    );
  }
});

test('l\'inerzia si dice, e dice anche come tornare dove il tasto funziona', () => {
  const nota = inertNote('^K');
  assert.ok(nota.includes('^K'), 'la nota non nomina il tasto');
  assert.ok(nota.includes('^B'), 'la nota non dice come tornare in modo task');
});
