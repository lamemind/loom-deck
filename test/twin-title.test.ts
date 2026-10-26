import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedNameIn } from '../src/live-sessions.js';
import { saneNote } from '../src/sane-note.js';
import { TWIN_MARKS, twinTitle } from '../src/twin-title.js';
import { termWidth } from '../src/width.js';

// T182 — il carattere della conversazione gemella. La lettura del registro vivo
// e il lancio vero stanno in `deck-run.test.ts`; qui la scelta pura e i vincoli
// che ogni carattere dell'insieme deve rispettare.

test('twinTitle: nessuna viva sul nome → base, byte per byte', () => {
  assert.equal(twinTitle('🧵 p · T1', []), '🧵 p · T1');
  assert.equal(twinTitle('🧵 p · T1', ['🧵 p · T1 nota', '🧵 p']), '🧵 p · T1');
});

test('twinTitle: sempre il primo carattere libero, non il successivo al più alto', () => {
  assert.equal(twinTitle('b', ['b']), 'b #');
  assert.equal(twinTitle('b', ['b', 'b #']), 'b +');
  // Il buco si riempie: `#` è tornato libero.
  assert.equal(twinTitle('b', ['b', 'b +']), 'b #');
});

test('twinTitle: solo i gemelli vivi, senza base viva → base', () => {
  assert.equal(twinTitle('b', ['b #']), 'b');
});

test('twinTitle: insieme esaurito → base', () => {
  assert.equal(twinTitle('b', ['b', ...TWIN_MARKS.map((m) => `b ${m}`)]), 'b');
});

test('TWIN_MARKS: dieci caratteri distinti, ASCII a una cella, fuori da ogni classe del titolo', () => {
  assert.equal(TWIN_MARKS.length, 10);
  assert.equal(new Set(TWIN_MARKS).size, 10);
  for (const m of TWIN_MARKS) {
    assert.match(m, /^[\x21-\x7e]$/, `non ASCII stampabile: ${m}`);
    assert.equal(termWidth(m), 1, `larghezza diversa da una cella: ${m}`);
    // Una nota digitata non può produrlo: `saneNote` lo toglie.
    assert.equal(saneNote(`x${m}`), 'x', `ammesso dalla nota: ${m}`);
    // Il lookahead negativo di `titleKeyRe` in compass.
    assert.doesNotMatch(m, /[\w-]/, `carattere di nome: ${m}`);
    assert.doesNotMatch(m, /['"`;&$|<>\\.,:/()[\]{}]/, `apice, metacarattere o punteggiatura: ${m}`);
  }
});

test('requestedNameIn: le quattro forme di --name, null senza', () => {
  assert.equal(requestedNameIn(['claude', '--name', '🧵 p · T1', '--model', 'opus']), '🧵 p · T1');
  assert.equal(requestedNameIn(['claude', '-n', 'a b']), 'a b');
  assert.equal(requestedNameIn(['claude', '--name=a b']), 'a b');
  assert.equal(requestedNameIn(['claude', '-n=a']), 'a');
  assert.equal(requestedNameIn(['claude', '--model', 'opus']), null);
  assert.equal(requestedNameIn(['claude', '--name']), null);
});
