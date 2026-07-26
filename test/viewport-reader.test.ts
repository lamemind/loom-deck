// T52 — a-capo con offset tracciati (reader) e capienze delle due schermate
// sostitutive. Logica pura di layout: nessun terminale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCompact,
  readerCapacity,
  searchListCapacity,
  wrapWithOffsets,
  SLACK,
} from '../src/viewport.js';

/** Invariante portante: ogni riga prodotta è una FETTA CONTIGUA del sorgente.
 *  È ciò che rende corretta l'evidenziazione del match. */
function assertSlices(text: string, width: number) {
  for (const l of wrapWithOffsets(text, width)) {
    assert.equal(
      text.slice(l.start, l.end).replace(/[\t\r]/g, ' '),
      l.text,
      `riga non allineata al sorgente: ${JSON.stringify(l)}`,
    );
    assert.ok(l.text.length <= width, `riga più larga di ${width}: ${l.text.length}`);
  }
}

test('testo corto: una riga sola, offset 0..len', () => {
  const lines = wrapWithOffsets('ciao mondo', 40);
  assert.deepEqual(lines, [{ text: 'ciao mondo', start: 0, end: 10 }]);
});

test('le newline del sorgente sono righe distinte (la struttura si preserva)', () => {
  const lines = wrapWithOffsets('uno\ndue\ntre', 40);
  assert.deepEqual(lines.map((l) => l.text), ['uno', 'due', 'tre']);
  assertSlices('uno\ndue\ntre', 40);
});

test('riga vuota resta una riga (un blocco di codice non si compatta)', () => {
  const lines = wrapWithOffsets('uno\n\ndue', 40);
  assert.deepEqual(lines.map((l) => l.text), ['uno', '', 'due']);
});

test('a-capo sulle parole, non a metà, quando c\'è uno spazio', () => {
  const lines = wrapWithOffsets('alfa beta gamma delta', 10);
  assert.deepEqual(lines.map((l) => l.text), ['alfa beta', 'gamma', 'delta']);
});

test('parola più lunga della riga: spezzata a forza, mai lasciata sfondare', () => {
  const text = 'x'.repeat(25);
  const lines = wrapWithOffsets(text, 10);
  assert.deepEqual(lines.map((l) => l.text.length), [10, 10, 5]);
  assertSlices(text, 10);
});

test('offset contigui e crescenti su testo misto', () => {
  const text = 'prima riga lunga da spezzare\n\nseconda\tcon tab\nterza';
  assertSlices(text, 12);
  const lines = wrapWithOffsets(text, 12);
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].start >= lines[i - 1].end, `offset non monotono a ${i}`);
  }
});

test('tab e CR diventano UN carattere: gli offset restano quelli del sorgente', () => {
  const text = 'a\tb\rc';
  const lines = wrapWithOffsets(text, 40);
  assert.equal(lines[0].text, 'a b c');
  assert.equal(lines[0].end, text.length, 'la lunghezza non deve cambiare');
});

test('il match a cavallo di due righe si ritrova su entrambe', () => {
  const text = 'parola CHIAVEMOLTOLUNGA fine';
  const width = 12;
  const from = text.indexOf('CHIAVEMOLTOLUNGA');
  const to = from + 'CHIAVEMOLTOLUNGA'.length;
  const lines = wrapWithOffsets(text, width);
  const touched = lines.filter((l) => l.end > from && l.start < to);
  assert.ok(touched.length >= 2, 'il match doveva coprire più di una riga');
  // Ricomposto, il pezzo evidenziato copre esattamente il match.
  const painted = touched
    .map((l) => {
      const a = Math.max(0, Math.min(l.text.length, from - l.start));
      const b = Math.max(0, Math.min(l.text.length, to - l.start));
      return l.text.slice(a, b);
    })
    .join('');
  assert.equal(painted, 'CHIAVEMOLTOLUNGA');
});

test('larghezza non positiva: nessuna riga, nessun loop', () => {
  assert.deepEqual(wrapWithOffsets('testo', 0), []);
  assert.deepEqual(wrapWithOffsets('testo', -5), []);
});

test('testo vuoto: una riga vuota', () => {
  assert.deepEqual(wrapWithOffsets('', 20), [{ text: '', start: 0, end: 0 }]);
});

test('messaggio della coda lunga: wrappa senza esplodere', () => {
  const text = ('lorem ipsum dolor sit amet '.repeat(6000)).trim(); // ~160k char
  const lines = wrapWithOffsets(text, 100);
  assert.ok(lines.length > 1500);
  assert.ok(lines.every((l) => l.text.length <= 100));
});

// ── capienze ────────────────────────────────────────────────────────────────

test('le capienze scalano con le righe del terminale e lasciano lo SLACK', () => {
  assert.ok(searchListCapacity(40, false) > searchListCapacity(30, false));
  assert.equal(searchListCapacity(40, true), searchListCapacity(40, false) - 1);
  assert.ok(readerCapacity(40) > readerCapacity(30));
});

test('terminale bassissimo: capienza zero e passaggio alla riga compatta', () => {
  for (const rows of [1, 5, 8, 14]) {
    assert.ok(searchListCapacity(rows, true) >= 0, `search a ${rows} righe`);
    assert.ok(readerCapacity(rows) >= 0, `reader a ${rows} righe`);
  }
  // Sotto la cornice la schermata a box non entra: deve scattare il compatto,
  // o il frame supera `rows` e Ink passa al clearTerminal che sporca lo scrollback.
  assert.equal(isCompact(searchListCapacity(14, false)), true);
  assert.equal(isCompact(readerCapacity(8)), true);
  assert.equal(isCompact(searchListCapacity(40, false)), false);
  assert.equal(isCompact(readerCapacity(40)), false);
});

test('il compatto scatta ESATTAMENTE quando il box sforerebbe', () => {
  for (const rows of [8, 10, 12, 14, 15, 16, 20, 24, 40]) {
    const cap = searchListCapacity(rows, false);
    if (!isCompact(cap)) {
      assert.ok(cap + 14 + SLACK <= rows, `box a ${rows} righe sfora pur non essendo compatto`);
    }
    const rcap = readerCapacity(rows);
    if (!isCompact(rcap)) {
      assert.ok(rcap + 8 + SLACK <= rows, `reader a ${rows} righe sfora pur non essendo compatto`);
    }
  }
});

test('rows falsy (non-TTY / spawn prima del SIGWINCH) cade sul default 24', () => {
  assert.equal(searchListCapacity(0, false), searchListCapacity(24, false));
  assert.equal(readerCapacity(0), readerCapacity(24));
});

test('il frame di ricerca non supera mai le righe del terminale', () => {
  // capienza + cornice + slack deve stare dentro `rows`: è l'invariante che
  // tiene Ink fuori dal ramo clearTerminal (scrollback sporcato a ogni poll).
  for (const rows of [20, 24, 30, 40, 60]) {
    for (const note of [false, true]) {
      const cap = searchListCapacity(rows, note);
      assert.ok(cap + 14 + (note ? 1 : 0) + SLACK <= rows, `sforo a ${rows} righe, note=${note}`);
    }
  }
});

test('il frame del reader non supera mai le righe del terminale', () => {
  for (const rows of [20, 24, 30, 40, 60]) {
    assert.ok(readerCapacity(rows) + 8 + SLACK <= rows, `sforo a ${rows} righe`);
  }
});
