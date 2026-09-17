// T161 — il gemello TypeScript di `_sane_note` e l'interpolazione dei buchi.
//
// Qui si misura il COMPORTAMENTO; che i due lati diano la stessa risposta lo
// misura `deck-run.test.ts`, che ha lo shim `ptyxis` e può far girare lo script
// bash vero. Le due cose sono distinte apposta: questo file resta verde anche su
// una macchina senza bash, e quello là fallisce se una delle due sedi cambia
// senza l'altra.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANE_CAP, interpolate, saneNote, saneTemplate } from '../src/sane-note.js';

test('l’alfabeto ammesso passa intatto', () => {
  assert.equal(saneNote('abc ABC 123 _ - àèéìòù ÀÈÉÌÒÙ'), 'abc ABC 123 _ - àèéìòù ÀÈÉÌÒÙ');
});

test('apici e metacaratteri di shell spariscono senza sostituto', () => {
  // Il titolo finisce dentro apici singoli in `bash -lc`: un apice che
  // sopravvivesse chiuderebbe la stringa e consegnerebbe alla shell tutto ciò
  // che segue come comando.
  assert.equal(saneNote(`l'ho fatto; $(rm -rf /) \`x\` "y" [z]`), 'lho fatto rm -rf x y z');
});

test('le sette emoji dei titoli sopravvivono, le altre no', () => {
  // T160 — 🧭 è la settima, e nasce col titolo della riga `rebalance`. La
  // whitelist ha tre sedi (questo lato, `deck-run`, i template del catalogo) e
  // un'emoji aggiunta a una sola sparisce fra la tabella e la tab, senza errore.
  for (const e of ['📐', '🚀', '📊', '🏁', '🧹', '📏', '🧭']) {
    assert.equal(saneNote(`${e} prova`), `${e} prova`, `${e} non sopravvive`);
  }
  // 🗺️ è astrale come le sette ammesse: passerebbe solo se la whitelist si
  // allargasse per intervallo di code point, che è proprio ciò che non fa.
  assert.equal(saneNote('🔥 fuoco'), 'fuoco');
  assert.equal(saneNote('🗺️ mappa'), 'mappa');
});

test('spazi collassati e estremi potati', () => {
  assert.equal(saneNote('  troppi    spazi   '), 'troppi spazi');
});

test('cap in CARATTERI, non in byte: nessun multibyte tagliato a metà', () => {
  const out = saneNote('à'.repeat(80));
  assert.equal([...out].length, SANE_CAP);
  assert.equal(out, 'à'.repeat(SANE_CAP));
});

test('una nota tutta fuori alfabeto si riduce a vuoto', () => {
  // `deck-run` in questo caso non appende nessun suffisso: il titolo resta la
  // sola label del progetto, invece di guadagnare uno spazio a vuoto.
  assert.equal(saneNote('🔥🔥 !!! 🔥'), '');
});

// ── i buchi ────────────────────────────────────────────────────────────────

test('saneTemplate preserva i buchi, che l’alfabeto non ammetterebbe', () => {
  // Le graffe non sono nell'alfabeto: passare un template da `saneNote` lo
  // ridurrebbe a `📐 slug`, cioè a un titolo che nomina la parola «slug».
  assert.equal(saneTemplate('📐 {slug}'), '📐 {slug}');
  assert.equal(saneNote('📐 {slug}'), '📐 slug');
});

test('saneTemplate riduce tutto ciò che sta FUORI dai buchi', () => {
  assert.equal(saneTemplate("🔥 il {slug} di {TASK}!"), 'il {slug} di {TASK}');
});

test('saneTemplate senza buchi è saneNote', () => {
  for (const s of ['prova', "l'apice", '🚀 ok', '  spazi  ', 'à'.repeat(80)]) {
    assert.equal(saneTemplate(s), saneNote(s), `divergono su: ${s}`);
  }
});

test('una graffa che non è un buco viene ridotta come il resto', () => {
  // Il buco è `{lettere}`: uno spazio o una cifra dentro non lo rendono tale, e
  // il testo cade nell'alfabeto normale.
  assert.equal(saneTemplate('{sl ug}'), 'sl ug');
  assert.equal(saneTemplate('{}'), '');
});

test('interpolate riempie ogni occorrenza, non solo la prima', () => {
  assert.equal(interpolate('{TASK} poi {TASK}', { TASK: 'T9' }), 'T9 poi T9');
});

test('interpolate lascia LETTERALE un buco che non conosce', () => {
  // Non è un valore mancante: è testo che qualcuno ha scritto, e il giro di
  // riduzione dopo l'interpolazione toglierà le graffe.
  assert.equal(interpolate('📐 {slag}', { slug: 'x' }), '📐 {slag}');
});

test('un buco NOTO ma senza valore spegne l’intero titolo', () => {
  // `📐` da solo sarebbe uguale per ogni task: peggio di nessun titolo.
  assert.equal(interpolate('📐 {slug}', { slug: '' }), null);
});

test('il giro completo: template → buchi → riduzione', () => {
  const filled = interpolate('🧹 {file}', { file: 'T158-nozioni.md' })!;
  assert.equal(saneNote(filled), '🧹 T158-nozionimd');
});
