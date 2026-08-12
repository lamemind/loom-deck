// T91 — scan di un documento singolo e taglio della riga da evidenziare.
// Logica pura: nessun Ink, nessun terminale, nessun filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, sliceLine, topForOffset, LITERAL } from '../src/text-search.js';
import { wrapWithOffsets } from '../src/width.js';

test('zero occorrenze: lista vuota, nessun errore', () => {
  const r = scanText('alfa beta gamma', 'delta');
  assert.deepEqual(r.occ, []);
  assert.equal(r.error, '');
});

test('occorrenze multiple in ordine, case-insensitive di default', () => {
  const r = scanText('Foo bar foo BAZ foo', 'foo');
  assert.deepEqual(
    r.occ.map((o) => o.start),
    [0, 8, 16],
  );
  for (const o of r.occ) assert.equal(o.end - o.start, 3);
});

test('query di un carattere: cercabile, a differenza della ricerca conversazioni', () => {
  // MIN_QUERY vale 3 su N conversazioni; su un task file `T` o `⏎` sono query
  // legittime, e la soglia lì impedirebbe soltanto.
  assert.equal(scanText('T72 e T91', 'T').occ.length, 2);
  assert.equal(scanText('a-b-c', '-').occ.length, 2);
});

test('query vuota: nessuna occorrenza, nessun errore', () => {
  const r = scanText('qualunque cosa', '');
  assert.deepEqual(r.occ, []);
  assert.equal(r.error, '');
});

test('la query letterale non è una regex: i metacaratteri si cercano nudi', () => {
  const r = scanText('costo a.b e poi axb', 'a.b');
  assert.equal(r.occ.length, 1);
  assert.equal(r.occ[0]!.start, 6);
});

test('regex che matcha la stringa vuota: il ciclo termina', () => {
  // Senza la guardia `re.lastIndex++` questo test non fallisce — non finisce.
  const r = scanText('aaa bbb', 'a*', { ...LITERAL, regex: true });
  assert.ok(r.occ.length > 0);
  for (const o of r.occ) assert.ok(o.end > o.start, 'nessun match di larghezza zero');
  assert.deepEqual(scanText('bbb', 'a*', { ...LITERAL, regex: true }).occ, []);
  assert.deepEqual(scanText('xyz', '^', { ...LITERAL, regex: true }).occ, []);
});

test('regex invalida: errore riportato, nessun crash', () => {
  const r = scanText('testo', '[a-', { ...LITERAL, regex: true });
  assert.deepEqual(r.occ, []);
  assert.ok(r.error.length > 0);
});

test('sliceLine senza occorrenze: la riga resta un pezzo solo', () => {
  const segs = sliceLine('alfa beta', 0, [], -1);
  assert.deepEqual(segs, [{ text: 'alfa beta', hit: false, current: false }]);
});

test('sliceLine: la corrente si distingue dalle altre', () => {
  const segs = sliceLine('foo bar foo', 0, [{ start: 0, end: 3 }, { start: 8, end: 11 }], 1);
  assert.deepEqual(segs, [
    { text: 'foo', hit: true, current: false },
    { text: ' bar ', hit: false, current: false },
    { text: 'foo', hit: true, current: true },
  ]);
});

test('sliceLine ignora le occorrenze fuori dalla riga', () => {
  // La riga copre il sorgente [100,109): un match a offset 5 non la tocca.
  const segs = sliceLine('alfa beta', 100, [{ start: 5, end: 8 }], 0);
  assert.deepEqual(segs, [{ text: 'alfa beta', hit: false, current: false }]);
});

test("match a cavallo dell'a-capo: colorato su ENTRAMBE le righe", () => {
  // La proprietà per cui gli offset sono del sorgente e non riga/colonna.
  // Il taglio cade dentro il match solo se la parola è più larga della riga:
  // `wrapWithOffsets` rompe sull'ultimo spazio quando può.
  const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const width = 10;
  const lines = wrapWithOffsets(text, width);
  const occ = scanText(text, 'IJKL').occ;
  assert.equal(occ.length, 1);

  const spezzata = lines.filter((l) => {
    const s = sliceLine(l.text, l.start, occ, 0);
    return s.some((x) => x.hit);
  });
  assert.ok(spezzata.length >= 2, 'il match dovrebbe toccare due righe a questa larghezza');

  // I pezzi colorati, rimessi insieme, ricompongono il match — nessun carattere
  // perso né duplicato dal taglio.
  const colorato = lines
    .flatMap((l) => sliceLine(l.text, l.start, occ, 0))
    .filter((s) => s.hit)
    .map((s) => s.text)
    .join('');
  assert.equal(colorato, 'IJKL');
});

test('sliceLine ricompone sempre la riga intera', () => {
  const text = 'foo bar foo baz foo qux foo';
  const occ = scanText(text, 'foo').occ;
  for (const l of wrapWithOffsets(text, 9)) {
    const segs = sliceLine(l.text, l.start, occ, 0);
    assert.equal(
      segs.map((s) => s.text).join(''),
      l.text,
      `riga ricomposta diversa: ${JSON.stringify(l)}`,
    );
  }
});

test('topForOffset centra l occorrenza nella finestra', () => {
  const lines = wrapWithOffsets(Array.from({ length: 100 }, (_, i) => `riga ${i}`).join('\n'), 20);
  const cap = 10;
  // Occorrenza a metà: la finestra la mette al centro, non in cima.
  const mid = lines[50]!.start;
  assert.equal(topForOffset(lines, mid, cap), 45);
  // Ai bordi degrada invece di uscire dal documento.
  assert.equal(topForOffset(lines, 0, cap), 0);
  assert.equal(topForOffset(lines, lines[99]!.start, cap), lines.length - cap);
});

test('topForOffset: documento più corto della finestra resta a zero', () => {
  const lines = wrapWithOffsets('una riga sola', 40);
  assert.equal(topForOffset(lines, 5, 30), 0);
});

test('le occorrenze sopravvivono al re-wrap, la posizione no', () => {
  // È la ragione per cui si tengono offset del sorgente: un resize cambia
  // quante righe ci sono, non dove sta il match.
  const text = Array.from({ length: 40 }, (_, i) => `riga numero ${i} di riempimento`).join('\n');
  const occ = scanText(text, 'numero 30').occ;
  assert.equal(occ.length, 1);

  const stretto = wrapWithOffsets(text, 12);
  const largo = wrapWithOffsets(text, 60);
  assert.notEqual(stretto.length, largo.length);

  // Stesso offset, due topForOffset diversi — e in entrambi i casi la riga che
  // contiene il match cade dentro la finestra.
  for (const lines of [stretto, largo]) {
    const cap = 10;
    const top = topForOffset(lines, occ[0]!.start, cap);
    const hit = lines.findIndex((l) => l.end > occ[0]!.start);
    assert.ok(hit >= top && hit < top + cap, 'il match è fuori dalla finestra calcolata');
  }
});
