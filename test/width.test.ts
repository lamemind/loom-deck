// Le due invarianti di `width.ts`, più il taglio e l'a-capo che ci si appoggiano.
//
// Il test che conta davvero è il primo: verifica la CONCORDANZA (Ink misura
// come il terminale) su un alfabeto reale, non su una manciata di casi scelti.
// Gli altri difendono i corollari.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import {
  agrees,
  caretWindow,
  cut,
  cutParts,
  pad,
  sanitize,
  termWidth,
  wrapLines,
  wrapWithOffsets,
} from '../src/width.js';

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

// ── T54 · finestra ancorata al caret ────────────────────────────────────────
//
// È la meccanica dove stanno gli off-by-one del campo di testo, ed è pura:
// testo + caret + budget → i tre pezzi da renderizzare. Si prova qui, senza
// pty — il gate sul frame verifica poi che il budget passato sia quello giusto.

/** Larghezza della finestra COME VERRÀ DISEGNATA (cioè dopo `sanitize`). */
function winWidth(w: ReturnType<typeof caretWindow>): number {
  return termWidth(sanitize(w.head) + sanitize(w.at) + sanitize(w.tail));
}

const LUNGO = 'Deck: caret mobile nel campo titolo del modale edit (frecce, ^A/^E)';

test('caretWindow: la finestra non sfora mai il budget, ovunque stia il caret', () => {
  for (const cols of [8, 12, 20, 33, 64, 200]) {
    for (let c = 0; c <= [...LUNGO].length; c++) {
      const w = caretWindow(LUNGO, c, cols);
      assert.ok(winWidth(w) <= cols, `caret ${c} @ ${cols} → ${winWidth(w)} colonne`);
      assert.equal(w.cursorCol, termWidth(sanitize(w.head)), `cursorCol incoerente (caret ${c})`);
      assert.ok(w.cursorCol < cols, `cursore fuori finestra (caret ${c} @ ${cols})`);
    }
  }
});

test('caretWindow: il carattere sotto il cursore è quello al caret', () => {
  const cp = [...LUNGO];
  for (let c = 0; c < cp.length; c++) {
    assert.equal(caretWindow(LUNGO, c, 20).at, cp[c]);
  }
  // A fine campo non c'è un carattere: la cella è lo spazio virtuale su cui
  // parcheggiare il cursore.
  assert.equal(caretWindow(LUNGO, cp.length, 20).at, ' ');
});

test('caretWindow: testo più corto del budget → nessuna ellissi, testo intero', () => {
  const w = caretWindow('breve', 2, 40);
  assert.equal(w.head, 'br');
  assert.equal(w.at, 'e');
  assert.equal(w.tail, 've');
  assert.equal(w.cursorCol, 2);
});

test('caretWindow: ellissi SOLO dal lato tagliato', () => {
  const inizio = caretWindow(LUNGO, 0, 20);
  assert.ok(!inizio.head.startsWith('…'), 'ellissi di testa col caret a 0');
  assert.ok(inizio.tail.endsWith('…'), 'manca l’ellissi di coda');

  const fine = caretWindow(LUNGO, [...LUNGO].length, 20);
  assert.ok(fine.head.startsWith('…'), 'manca l’ellissi di testa');
  assert.ok(!fine.tail.endsWith('…'), 'ellissi di coda col caret in fondo');

  const mezzo = caretWindow(LUNGO, 30, 20);
  assert.ok(mezzo.head.startsWith('…') && mezzo.tail.endsWith('…'), 'tagliato da entrambi i lati');
});

test('caretWindow: la finestra SEGUE il caret (il cursore resta dentro il testo mostrato)', () => {
  // Muovendosi a sinistra un carattere alla volta, ogni posizione deve restare
  // visibile: è la regressione che il taglio dalla coda produceva (si scriveva
  // in un punto fuori dalla finestra).
  for (let c = [...LUNGO].length; c >= 0; c--) {
    const w = caretWindow(LUNGO, c, 24);
    const atteso = c < [...LUNGO].length ? [...LUNGO][c] : ' ';
    assert.equal(w.at, atteso, `il cursore non è sul carattere ${c}`);
  }
});

test('caretWindow: emoji nel testo — nessun glifo spezzato, budget in colonne', () => {
  const conEmoji = '🔥 titolo 🟡 con 🔵 emoji dentro e coda lunga da tagliare';
  for (const cols of [10, 17, 30]) {
    for (let c = 0; c <= [...conEmoji].length; c++) {
      const w = caretWindow(conEmoji, c, cols);
      const visibile = w.head + w.at + w.tail;
      assert.ok(winWidth(w) <= cols, `caret ${c} @ ${cols} → ${winWidth(w)} colonne`);
      // Nessun surrogato orfano: la finestra taglia per code point.
      assert.ok(!/[\uD800-\uDFFF]/.test(visibile.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
    }
  }
});

test('caretWindow: budget degenere → niente da disegnare, mai una finestra sfondata', () => {
  assert.deepEqual(caretWindow('abc', 1, 0), { head: '', at: '', tail: '', cursorCol: 0 });
  // Cursore su un glifo largo 2 con una sola colonna: non ci sta, e mezzo glifo
  // non è un'opzione.
  assert.deepEqual(caretWindow('🔥x', 0, 1), { head: '', at: '', tail: '', cursorCol: 0 });
});


// ── T60 · celle a larghezza esatta (l'invariante che regge l'incolonnamento) ──

test('pad: la cella misura ESATTAMENTE le colonne chieste, glifo largo o stretto', () => {
  // È il caso che rendeva ragged la lista: `○` largo 1 e `🔗` largo 2 devono
  // uscire entrambi larghi 2, o tutto ciò che segue slitta di una colonna.
  for (const g of ['○', '🔗', '📌', '·', '']) {
    assert.equal(termWidth(pad(g, 2)), 2, `${g} → cella larga 2`);
  }
  for (const s of ['T5', 'T59', 'T101', '']) {
    assert.equal(termWidth(pad(s, 4)), 4, `${s} → cella larga 4`);
  }
});

test('pad: `String.padEnd` NON basta — è la trappola che questa funzione esiste per chiudere', () => {
  // `padEnd` conta code unit. Su un glifo BMP largo 2 (`✅` — 1 code unit, 2
  // colonne) crede di avere una colonna da riempire e ne aggiunge una terza.
  assert.equal('✅'.length, 1, 'una code unit…');
  assert.equal(termWidth('✅'), 2, '…due colonne');
  assert.equal(termWidth('✅'.padEnd(2)), 3, 'padEnd sfora: 3 colonne per una cella da 2');
  assert.equal(termWidth(pad('✅', 2)), 2, 'pad misura in colonne e non tocca nulla');
});

test('pad: eccedenza tagliata al budget, mai sbordata', () => {
  assert.equal(termWidth(pad('titolo lunghissimo', 6)), 6);
  assert.ok(pad('titolo lunghissimo', 6).endsWith('…'), 'taglio non silenzioso');
  assert.equal(termWidth(pad('🔥🔥🔥🔥', 5)), 5, 'nessun mezzo glifo, nessuna colonna in più');
});

test('pad: allineamento a destra mette il riempimento davanti', () => {
  assert.equal(pad('3d', 4, 'right'), '  3d');
  assert.equal(pad('159d', 4, 'right'), '159d');
  assert.equal(termWidth(pad('47m', 4, 'right')), 4);
});

test('pad: budget degenere → cella vuota, mai una stringa a sorpresa', () => {
  assert.equal(pad('qualsiasi', 0), '');
  assert.equal(pad('qualsiasi', -3), '');
});

// ── riga composita: budget della RIGA, resa del PEZZO ────────────────────────

/** Larghezza del testo in un pane al 50% su un terminale da 100 colonne: è il
 *  budget su cui il difetto si è manifestato. */
const PANE_44 = 44;

/** L'header del pane sessioni com'era quando il gate ha aperto il difetto. */
const HEADER_SESSIONI = ['Sessions · spot (83)', ' · 📌3', ' · +50 più vecchie', ' · ↓12'];

test('cutParts: è il caso che apriva il bordo — cli-truncate sfora, cutParts no', () => {
  // Il controllo vero non è "cutParts sta nel budget", è che l'alternativa NON
  // ci sta: senza questa riga il test non distingue il fix dal caso fortunato.
  const joined = HEADER_SESSIONI.join('');
  assert.equal(
    termWidth(cliTruncate(joined, PANE_44, { position: 'end' })),
    PANE_44 + 1,
    'cli-truncate restituisce una colonna in più: è quella che mangiava il bordo',
  );
  assert.ok(
    termWidth(cutParts(HEADER_SESSIONI, PANE_44).join('')) <= PANE_44,
    'cutParts resta dentro il budget',
  );
});

test('cutParts: mai oltre il budget, a qualunque larghezza e con glifi larghi ovunque', () => {
  const parts = ['Tasks (19/54)', ' · 📌3', ' · 🔥⚡ filtri', ' · +50 più vecchie'];
  for (let cols = 0; cols <= 60; cols++) {
    const w = termWidth(cutParts(parts, cols).join(''));
    assert.ok(w <= cols, `budget ${cols}: uscita larga ${w}`);
  }
});

test('cutParts: sotto il budget nessun pezzo è toccato (niente ellissi gratis)', () => {
  const parts = ['Sessions · spot (3)', ' · 📌1'];
  assert.deepEqual(cutParts(parts, 40), parts);
});

test('cutParts: array della stessa lunghezza — i pezzi caduti sono stringhe vuote', () => {
  const out = cutParts(HEADER_SESSIONI, 22);
  assert.equal(out.length, HEADER_SESSIONI.length, 'stessa lunghezza: il render mappa 1:1');
  assert.ok(
    out.slice(2).every((p) => p === ''),
    'i segmenti oltre il taglio spariscono, non si accorciano a caso',
  );
});

test('cutParts: lo spazio fra i segmenti sopravvive (è il separatore, non whitespace)', () => {
  // `cut` collassa e trimma: applicato pezzo per pezzo mangerebbe lo spazio
  // iniziale di ` · 📌3` e la riga slitterebbe di una colonna per giunzione.
  const out = cutParts(HEADER_SESSIONI, PANE_44);
  assert.ok(out[1]!.startsWith(' · '), `separatore perso: ${JSON.stringify(out[1])}`);
});

test('cutParts: ellissi UNA sola, sull\'ultimo pezzo che ha testo', () => {
  const out = cutParts(HEADER_SESSIONI, 30);
  const joined = out.join('');
  assert.equal([...joined].filter((c) => c === '…').length, 1, 'una sola ellissi in tutta la riga');
  const lastWithText = [...out].reverse().find((p) => p !== '')!;
  assert.ok(lastWithText.endsWith('…'), 'l\'ellissi sta al punto di taglio, non staccata');
});

test('cutParts: nessun glifo largo spezzato a metà dal taglio', () => {
  for (let cols = 1; cols <= 30; cols++) {
    const joined = cutParts(['abc', '📌📌📌📌', 'def'], cols).join('');
    assert.equal(stringWidth(joined), termWidth(joined), `budget ${cols}: glifo spezzato`);
  }
});

test('cutParts: budget degenere → tutti i pezzi vuoti, mai una stringa a sorpresa', () => {
  assert.deepEqual(cutParts(['a', 'b'], 0), ['', '']);
  assert.deepEqual(cutParts(['a', 'b'], -5), ['', '']);
});
