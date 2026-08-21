// T117 — la grammatica dell'area di compilazione, condivisa fra il modale edit e
// il detail. Sono unit e non un gate pty: qui si fissa cosa fa un tasto su una
// riga, che è logica pura; il gate dei modi verifica poi che quelle regole
// arrivino davvero a schermo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Key } from 'ink';
import { caretAtEnd, fieldsKey, isTextField, type FieldSpec, type FieldsCursor } from '../src/fields.js';

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

const key = (over: Partial<Key> = {}): Key => ({ ...NO_KEY, ...over });

/** Area di prova con la stessa forma del detail: una scelta con lettere, un
 *  testo, una scelta nuda, un testo. */
const SPECS: readonly FieldSpec[] = [
  { kind: 'choice', count: 3, hotkeys: { a: 0, b: 1, c: 2 } },
  { kind: 'text' },
  { kind: 'choice', count: 4 },
  { kind: 'text' },
];

/** Banco: valori mutabili + cursore, con l'IO che ci legge e ci scrive sopra. */
function bench(cursor: FieldsCursor = { row: 0, caret: 0 }) {
  const state = { texts: { 1: '', 3: '' } as Record<number, string>, choices: { 0: 0, 2: 0 } as Record<number, number> };
  let cur = cursor;
  const io = {
    text: (r: number) => state.texts[r] ?? '',
    setText: (r: number, v: string) => {
      state.texts[r] = v;
    },
    choice: (r: number) => state.choices[r] ?? 0,
    setChoice: (r: number, i: number) => {
      state.choices[r] = i;
    },
  };
  return {
    state,
    io,
    get cursor() {
      return cur;
    },
    press(input: string, k: Partial<Key> = {}) {
      return fieldsKey(input, key(k), SPECS, cur, (next) => (cur = next), io);
    },
  };
}

test('↑↓ spostano il fuoco fra le righe, ciclando', () => {
  const b = bench();
  b.press('', { downArrow: true });
  assert.equal(b.cursor.row, 1);
  b.press('', { upArrow: true });
  assert.equal(b.cursor.row, 0);
  // Dalla prima riga `↑` porta all'ULTIMA: quattro righe, arrivare in cima e
  // ripartire dal fondo costa meno che invertire direzione.
  b.press('', { upArrow: true });
  assert.equal(b.cursor.row, 3);
});

test('il caret atterra in coda al campo entrando in una riga di testo', () => {
  const b = bench();
  b.state.texts[1] = 'ciao';
  b.press('', { downArrow: true });
  assert.equal(b.cursor.caret, 4);
  assert.equal(caretAtEnd(SPECS, 1, b.io), 4);
  // Su una riga a scelta il caret non ha significato e vale 0.
  assert.equal(caretAtEnd(SPECS, 0, b.io), 0);
});

test('←→ ciclano il valore di una riga a scelta', () => {
  const b = bench();
  b.press('', { rightArrow: true });
  assert.equal(b.state.choices[0], 1);
  b.press('', { leftArrow: true });
  assert.equal(b.state.choices[0], 0);
  // Ciclico: da 0 all'indietro si finisce sull'ultima delle tre.
  b.press('', { leftArrow: true });
  assert.equal(b.state.choices[0], 2);
});

test('le lettere selezionano direttamente sulla riga a scelta che le dichiara', () => {
  const b = bench();
  assert.equal(b.press('c'), true);
  assert.equal(b.state.choices[0], 2);
});

test('una lettera senza binding su una riga a scelta è INERTE, non testo', () => {
  const b = bench();
  // È il focus-gating: senza, il carattere ricadrebbe nell'ultimo campo di testo
  // toccato — cioè il catch-all che l'area a righe esiste per togliere.
  assert.equal(b.press('z'), false);
  assert.equal(b.state.texts[1], '');
  assert.equal(b.state.texts[3], '');
  assert.equal(b.state.choices[0], 0);
});

test('una riga a scelta senza hotkeys ignora ogni lettera', () => {
  const b = bench({ row: 2, caret: 0 });
  assert.equal(b.press('a'), false);
  assert.equal(b.state.choices[2], 0);
});

test('i caratteri entrano solo nel campo in fuoco', () => {
  const b = bench({ row: 1, caret: 0 });
  b.press('ab');
  assert.equal(b.state.texts[1], 'ab');
  assert.equal(b.state.texts[3], '');
  assert.equal(b.cursor.caret, 2);
});

test('il caret avanza della lunghezza del chunk incollato', () => {
  const b = bench({ row: 1, caret: 0 });
  // `useInput` consegna il CHUNK di stdin: un incollaggio entra tutto insieme,
  // quindi il caret non può avanzare di uno.
  b.press('dodici car');
  assert.equal(b.cursor.caret, 10);
});

test('sanitizeTyped ripulisce il chunk: gli a-capo diventano spazi', () => {
  const b = bench({ row: 1, caret: 0 });
  b.press('a\nb');
  assert.equal(b.state.texts[1], 'a b');
});

test('←→ su un campo di testo muovono il caret e CLAMPANO agli estremi', () => {
  const b = bench({ row: 1, caret: 0 });
  b.state.texts[1] = 'abc';
  b.press('', { rightArrow: true });
  assert.equal(b.cursor.caret, 1);
  b.press('', { leftArrow: true });
  assert.equal(b.cursor.caret, 0);
  // A inizio campo `←` non salta in fondo: un testo non cicla, il salto sarebbe
  // indistinguibile da uno sfarfallio.
  b.press('', { leftArrow: true });
  assert.equal(b.cursor.caret, 0);
});

test('^A e ^E portano il caret agli estremi (Home/End non sono esposte da Ink)', () => {
  const b = bench({ row: 1, caret: 1 });
  b.state.texts[1] = 'abcde';
  b.press('e', { ctrl: true });
  assert.equal(b.cursor.caret, 5);
  b.press('a', { ctrl: true });
  assert.equal(b.cursor.caret, 0);
});

test('il ramo CTRL precede quello su carattere: ^A non finisce nel testo', () => {
  const b = bench({ row: 1, caret: 0 });
  b.press('a', { ctrl: true });
  assert.equal(b.state.texts[1], '');
});

test('^D cancella in avanti, backspace indietro', () => {
  const b = bench({ row: 1, caret: 2 });
  b.state.texts[1] = 'abcd';
  b.press('d', { ctrl: true });
  assert.equal(b.state.texts[1], 'abd');
  b.press('', { delete: true });
  assert.equal(b.state.texts[1], 'ad');
  assert.equal(b.cursor.caret, 1);
});

test('^U svuota il campo in fuoco e riporta il caret a zero', () => {
  const b = bench({ row: 3, caret: 3 });
  b.state.texts[3] = 'xyz';
  b.press('u', { ctrl: true });
  assert.equal(b.state.texts[3], '');
  assert.equal(b.cursor.caret, 0);
});

test('un CTRL senza significato resta inerte e non consuma', () => {
  const b = bench({ row: 1, caret: 0 });
  // Dentro un modo capturing gli acceleratori globali devono restare spenti: il
  // modulo dice «non è mio» e il chiamante lo lascia cadere.
  assert.equal(b.press('k', { ctrl: true }), false);
  assert.equal(b.state.texts[1], '');
});

test('isTextField distingue le due nature di riga', () => {
  assert.equal(isTextField(SPECS, 0), false);
  assert.equal(isTextField(SPECS, 1), true);
  assert.equal(isTextField(SPECS, 2), false);
  assert.equal(isTextField(SPECS, 3), true);
});

test('una riga fuori range non consuma nulla invece di rompere', () => {
  const b = bench({ row: 9, caret: 0 });
  assert.equal(b.press('x'), false);
});
