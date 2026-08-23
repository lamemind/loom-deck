// T21 — unit del MOUSE: parse delle sequenze SGR e hit-test sulle superfici.
//
// Le forme sotto misura non sono inventate: vengono da uno spike sotto pty in
// cui un'app Ink stampava ciò che `useInput` le consegnava. Il gate pty
// (`modes-smoke.test.ts`) verifica che un click faccia l'azione giusta sul deck
// vero; questi unit fissano la grammatica che quel gate non può isolare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitRegion, isWheel, rowRegions, takeMouse } from '../src/mouse.js';

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
