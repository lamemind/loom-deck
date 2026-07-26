// Le due invarianti di `width.ts`, più il taglio e l'a-capo che ci si appoggiano.
//
// Il test che conta davvero è il primo: verifica la CONCORDANZA (Ink misura
// come il terminale) su un alfabeto reale, non su una manciata di casi scelti.
// Gli altri difendono i corollari.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import { agrees, cut, sanitize, termWidth, wrapLines, wrapWithOffsets } from '../src/width.js';

const VS16 = '️';

/** Glifi che il deck scrive nei suoi literal o legge da tasks.md. */
const DECK_GLYPHS = [
  '🔥', '⚡', '🔹', '🟡', '🔵', '🔒', '✅', '📌', '🔗', '🧵', '📝', '📈', '🎴', '⑂',
  '○', '·', '─', '▸', '⏎', '↳', '↑', '↓', '−', '—', '«', '»', '…',
];
/** Discordi noti: string-width li dà 2, il terminale ne disegna 1. */
const DISCORDANT = ['▶', '✔', '⚠', '❤', '✂', '➡', '☀', '™', '‼'];

test('invariante ①: dopo sanitize ogni carattere è concorde', () => {
  const corpus = [
    ...DECK_GLYPHS,
    ...DISCORDANT,
    'T30  🔹  🟡  loom-deck: create-task inline (tasto c → box)',
    '▶ T35  🔥  🟡  caveman ✔️ done ⚠ attenzione ❤',
    'sort: pri↓ stato↓ id↓ · filtri: −✔️',
    '一二三 CJK misto ASCII',
    '',
  ];
  for (const s of corpus) {
    for (const ch of sanitize(s)) {
      assert.ok(agrees(ch), `${JSON.stringify(ch)} discorde dopo sanitize (da ${JSON.stringify(s)})`);
    }
    assert.equal(
      stringWidth(sanitize(s)),
      termWidth(sanitize(s)),
      `larghezza discorde su ${JSON.stringify(s)}`,
    );
  }
});

test('invariante ①: i discordi vengono sostituiti, non timbrati', () => {
  assert.equal(sanitize('▶'), '▸'); // caret: sostituito con un gemello largo 1
  assert.equal(sanitize('✔'), '✅' + VS16); // Done: gemello BMP largo 2 → timbrato
  assert.equal(sanitize('✔️'), '✅' + VS16); // idem partendo dalla forma già timbrata
  assert.equal(sanitize('❤'), '·'); // nessuna traduzione sensata → segnaposto
});

test('invariante ②: il VS16 va sui BMP larghi 2 e SOLO su quelli', () => {
  for (const g of DECK_GLYPHS) {
    const out = sanitize(g);
    const bmpWide = g.codePointAt(0)! < 0x10000 && termWidth(g) === 2;
    if (bmpWide) assert.equal(out, g + VS16, `${g} (BMP largo 2) non timbrato`);
    else assert.equal(out, g, `${g} timbrato a torto`);
  }
});

test('invariante ②: un astrale timbrato prenderebbe 3 celle nella griglia di Ink', () => {
  // La griglia assegna 2 celle se `isFullwidthCodePoint || value.length > 1`,
  // con un token per code point: l'astrale ne ha gia' 2, il VS16 ne aggiungerebbe
  // una terza a costo zero colonne — e la riga uscirebbe piu' corta del padding.
  for (const g of ['🔥', '🟡', '🔵', '📝']) {
    assert.ok(!sanitize(g).includes(VS16), `${g} timbrato: la riga perderebbe una colonna`);
  }
});

test('invariante ③: il taglio lo fa cut(), non cli-truncate', () => {
  // Perché non basta il timbro: `slice-ansi` indicizza per code point, quindi su
  // un astrale (1 code point, 2 colonne) sfora comunque — e timbrarlo romperebbe
  // la griglia di Ink (invariante ②). L'unica uscita è tagliare prima noi.
  const row = sanitize('  T30  🔹  🟡  loom-deck: create-task inline (tasto c → box → headless)');
  let inkOverflow = 0;
  for (const w of [20, 33, 40, 55, 84]) {
    if (stringWidth(cliTruncate(row, w, { position: 'end' })) > w) inkOverflow++;
    const ours = cut(row, w);
    assert.ok(stringWidth(ours) <= w, `cut ink: ${stringWidth(ours)} > ${w}`);
    assert.ok(termWidth(ours) <= w, `cut terminale: ${termWidth(ours)} > ${w}`);
  }
  assert.ok(inkOverflow > 0, 'cli-truncate non sfora più: il taglio nostro non servirebbe');
});

test('sanitize: idempotente', () => {
  for (const s of [...DECK_GLYPHS, ...DISCORDANT, '✔️ ⚡️ 🔥 misto']) {
    const once = sanitize(s);
    assert.equal(sanitize(once), once, `ri-sanificato: ${JSON.stringify(s)}`);
  }
});

test('sanitize: ASCII invariato (fast-path) e newline preservate', () => {
  assert.equal(sanitize('nessun emoji, solo ascii'), 'nessun emoji, solo ascii');
  assert.equal(sanitize(''), '');
  assert.equal(sanitize('riga uno\nriga due\tcol'), 'riga uno\nriga due\tcol');
});

test('sanitize: i byte di controllo diventano spazi', () => {
  // Un ESC arrivato da un tool_result muoverebbe il cursore in mezzo al frame.
  const esc = String.fromCharCode(27);
  assert.equal(sanitize(`a${esc}[31mb`), 'a [31mb');
  assert.equal(termWidth(sanitize(`a${esc}b`)), 3);
});

test('cut: taglia a COLONNE, ellissi inclusa nel budget', () => {
  for (const s of ['🔥🔥🔥🔥🔥🔥', 'T30 🔹 🟡 descrizione lunga che non ci sta', 'ascii semplice']) {
    for (const w of [1, 2, 5, 8, 13, 20]) {
      const out = cut(sanitize(s), w);
      assert.ok(termWidth(out) <= w, `${JSON.stringify(s)}@${w} → ${termWidth(out)} colonne`);
      assert.ok(stringWidth(out) <= w, `${JSON.stringify(s)}@${w} → ink ${stringWidth(out)}`);
    }
  }
});

test('cut: sotto il budget la stringa resta intatta (niente ellissi gratis)', () => {
  assert.equal(cut('T30 breve', 40), 'T30 breve');
  assert.equal(cut(sanitize('🔥🔥'), 4), sanitize('🔥🔥'));
});

test('wrapLines: nessuna riga supera la larghezza, in colonne', () => {
  const text = sanitize('🔥 fuoco 🟡 giallo 🔵 blu ' + 'parolalunghissimasenzaspazi'.repeat(2));
  for (const w of [10, 24, 40]) {
    for (const line of wrapLines(text, w, 4)) {
      assert.ok(termWidth(line) <= w, `"${line}" = ${termWidth(line)} > ${w}`);
    }
  }
});

test('wrapWithOffsets: righe entro la larghezza e fette contigue del sorgente', () => {
  const text = sanitize('prima riga con 🔥 emoji\nseconda riga più lunga con 🟡 e 🔵 dentro');
  for (const w of [12, 20, 30]) {
    for (const l of wrapWithOffsets(text, w)) {
      assert.ok(termWidth(l.text) <= w, `"${l.text}" = ${termWidth(l.text)} > ${w}`);
      assert.equal(
        text.slice(l.start, l.end).replace(/[\t\r]/g, ' '),
        l.text,
        'offset non allineati al sorgente',
      );
    }
  }
});
