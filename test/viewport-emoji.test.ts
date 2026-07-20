import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { normalizeEmoji } from '../src/viewport.js';

const VS16 = '️';

/** Glifi BMP larghi 2 senza VS16: la classe che Ink misura una cella in meno. */
const OFFENDERS = ['☕', '✔', '⚡', '✅', '▶', '⚠', '⏳'];
/** Larghi 1 nello stesso blocco U+2190–U+2BFF: NON vanno timbrati. */
const NARROW = ['↓', '↑', '−', '○', '▸', '⏎', '↳'];
/** Astrali: Ink li conta già bene, restano intatti. */
const ASTRAL = ['📝', '🔥', '🟡', '🔵', '🔒', '🧵', '🔗', '📈', '🎴', '🔹'];

test('normalizeEmoji: timbra il VS16 sui BMP larghi 2', () => {
  for (const g of OFFENDERS) {
    assert.equal(normalizeEmoji(g), g + VS16, `${g} non timbrato`);
  }
});

test('normalizeEmoji: non tocca i BMP larghi 1', () => {
  for (const g of NARROW) assert.equal(normalizeEmoji(g), g, `${g} timbrato a torto`);
});

test('normalizeEmoji: non tocca gli astrali', () => {
  for (const g of ASTRAL) assert.equal(normalizeEmoji(g), g, `${g} timbrato a torto`);
});

test('normalizeEmoji: idempotente', () => {
  for (const g of [...OFFENDERS, ...NARROW, ...ASTRAL]) {
    const once = normalizeEmoji(g);
    assert.equal(normalizeEmoji(once), once, `${g} ri-timbrato`);
  }
});

test('normalizeEmoji: ASCII e vuoto invariati', () => {
  assert.equal(normalizeEmoji('nessun emoji, solo ascii'), 'nessun emoji, solo ascii');
  assert.equal(normalizeEmoji(''), '');
});

test('normalizeEmoji: la larghezza non cambia (cambia solo chi la conta)', () => {
  // Il VS16 è largo 0: string-width prima e dopo deve coincidere. Se cambiasse,
  // il timbro starebbe spostando il layout invece di allineare le contabilità.
  for (const s of ['launch 1 📝 codium · 2 ☕ idea', '▶ T72  ⚡  🟡  Arbiter', 'filtri: −✔']) {
    assert.equal(stringWidth(normalizeEmoji(s)), stringWidth(s), s);
  }
});

test('normalizeEmoji: stringhe miste, ogni offender timbrato una volta sola', () => {
  const mixed = '✅ ▶ ☕ ⚡ ✔ ✔️ ⚡️ ↓ ↑ − · ○ ⏎ 🔥 🧵';
  const out = normalizeEmoji(mixed);
  // 5 nudi + 2 già timbrati = 7 occorrenze di VS16, nessuna doppia
  assert.equal((out.match(/️/g) || []).length, 7);
  assert.ok(!out.includes(VS16 + VS16), 'VS16 doppio');
});
