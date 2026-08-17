// T75 — parser markdown del detail: testo reso + span tipizzati.
// Logica pura: nessun Ink, nessun terminale, nessun filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, sliceSpans, type Span, type SpanKind } from '../src/markdown.js';
import { sanitize, termWidth, wrapWithOffsets } from '../src/width.js';

/** Il testo coperto da uno span, letto dal reso: asserire sugli offset nudi
 *  renderebbe i test illeggibili e fragili a ogni carattere spostato. */
function covered(r: { text: string; spans: Span[] }): Array<[SpanKind, string]> {
  return r.spans.map((s) => [s.kind, r.text.slice(s.start, s.end)]);
}

test('bold: i marker spariscono dal testo, lo span copre il contenuto', () => {
  const r = parseMarkdown('prima **forte** dopo');
  assert.equal(r.text, 'prima forte dopo');
  assert.deepEqual(covered(r), [['bold', 'forte']]);
});

test('code: i backtick spariscono, lo span copre il contenuto', () => {
  const r = parseMarkdown('vedi `src/width.ts` in root');
  assert.equal(r.text, 'vedi src/width.ts in root');
  assert.deepEqual(covered(r), [['code', 'src/width.ts']]);
});

test('code a N backtick: chiude solo su una sequenza della STESSA lunghezza', () => {
  // È la forma con cui la doc di questo progetto cita i backtick; un parser a
  // un backtick solo la ridurrebbe a poltiglia.
  const r = parseMarkdown('la forma `` `code` `` si scrive così');
  assert.equal(r.text, 'la forma `code` si scrive così');
  assert.deepEqual(covered(r), [['code', '`code`']]);
});

test('heading: il marker sparisce e lo span copre la riga intera', () => {
  const r = parseMarkdown('## Acceptance Criteria');
  assert.equal(r.text, 'Acceptance Criteria');
  assert.deepEqual(covered(r), [['heading', 'Acceptance Criteria']]);
});

test('heading: ogni livello ha la stessa resa (D4)', () => {
  for (const marker of ['#', '###', '######']) {
    const r = parseMarkdown(`${marker} Titolo`);
    assert.equal(r.text, 'Titolo');
    assert.deepEqual(covered(r), [['heading', 'Titolo']]);
  }
});

test('heading: senza spazio dopo i cancelletti non è un titolo', () => {
  const r = parseMarkdown('#tag non è un heading');
  assert.equal(r.text, '#tag non è un heading');
  assert.deepEqual(r.spans, []);
});

test('bullet: il marker diventa un glifo, indentazione e spaziatura intatte', () => {
  const r = parseMarkdown('- voce\n  - annidata\n    * terzo livello');
  assert.equal(r.text, '• voce\n  • annidata\n    • terzo livello');
});

test('bullet: la sostituzione conserva la colonna d\'inizio del testo', () => {
  // Il glifo occupa una colonna come il marker; se cambiasse la larghezza del
  // prefisso, un elenco allineato a mano uscirebbe scalinato.
  const raw = '-   testo allineato';
  const r = parseMarkdown(raw);
  assert.equal(r.text, '•   testo allineato');
  assert.equal(termWidth(r.text), termWidth(raw));
});

test('la riga orizzontale non è un bullet', () => {
  const r = parseMarkdown('---');
  assert.equal(r.text, '---');
  assert.deepEqual(r.spans, []);
});

test('bold a inizio riga non è un bullet: manca lo spazio dopo il marker', () => {
  const r = parseMarkdown('**Priority**: Med');
  assert.equal(r.text, 'Priority: Med');
  assert.deepEqual(covered(r), [['bold', 'Priority']]);
});

test('bold dentro un bullet: il glifo resta fuori dallo span', () => {
  const r = parseMarkdown('- **ID**: T75');
  assert.equal(r.text, '• ID: T75');
  assert.deepEqual(covered(r), [['bold', 'ID']]);
  assert.equal(r.spans[0]!.start, 2); // dopo `• `
});

test('fence: i delimitatori spariscono (D2), il contenuto prende un colore uniforme', () => {
  const r = parseMarkdown('prima\n```\ncodice\n```\ndopo');
  assert.equal(r.text, 'prima\ncodice\ndopo');
  assert.deepEqual(covered(r), [['fence', 'codice']]);
});

test('fence: la info-string sparisce col delimitatore che la porta', () => {
  const r = parseMarkdown('```bash\nls -la\n```');
  assert.equal(r.text, 'ls -la');
  assert.deepEqual(covered(r), [['fence', 'ls -la']]);
});

test('fence: dentro il blocco l\'inline è SOSPESO', () => {
  const r = parseMarkdown('```\n**non grassetto** e `non codice`\n```');
  assert.equal(r.text, '**non grassetto** e `non codice`');
  assert.deepEqual(covered(r), [['fence', '**non grassetto** e `non codice`']]);
});

test('fence: nemmeno bullet e heading girano dentro', () => {
  const r = parseMarkdown('```\n- non bullet\n# non heading\n```');
  assert.equal(r.text, '- non bullet\n# non heading');
});

test('fence non chiuso: colora fino a fine documento, non perde testo', () => {
  const r = parseMarkdown('prima\n```\ndentro\nancora dentro');
  assert.equal(r.text, 'prima\ndentro\nancora dentro');
  assert.deepEqual(covered(r), [
    ['fence', 'dentro'],
    ['fence', 'ancora dentro'],
  ]);
});

test('bold non chiuso: resta letterale, non mangia il resto del documento', () => {
  const r = parseMarkdown('un **spaiato qui\nriga dopo intatta');
  assert.equal(r.text, 'un **spaiato qui\nriga dopo intatta');
  assert.deepEqual(r.spans, []);
});

test('backtick non chiuso: resta letterale', () => {
  const r = parseMarkdown('un `spaiato qui\nriga dopo `davvero` chiusa');
  assert.equal(r.text, 'un `spaiato qui\nriga dopo davvero chiusa');
  assert.deepEqual(covered(r), [['code', 'davvero']]);
});

test('il marker non si chiude MAI a cavallo di due righe', () => {
  // È il perimetro che rende innocuo lo spaiato: la ricerca del chiudente non
  // esce dalla riga, quindi non c'è modo di inghiottire il documento sotto.
  const r = parseMarkdown('apre **qui\nchiude** là');
  assert.equal(r.text, 'apre **qui\nchiude** là');
  assert.deepEqual(r.spans, []);
});

test('codice dentro grassetto: vince il codice, che è più specifico', () => {
  const r = parseMarkdown('**il file `width.ts` conta**');
  assert.equal(r.text, 'il file width.ts conta');
  assert.deepEqual(covered(r), [
    ['bold', 'il file '],
    ['code', 'width.ts'],
    ['bold', ' conta'],
  ]);
});

test('grassetto dentro un heading: assorbito, il titolo non si spezza in due rese', () => {
  const r = parseMarkdown('## Titolo **con enfasi** dentro');
  assert.equal(r.text, 'Titolo con enfasi dentro');
  assert.deepEqual(covered(r), [['heading', 'Titolo con enfasi dentro']]);
});

test('codice dentro un heading: vince il codice, il resto resta titolo', () => {
  const r = parseMarkdown('## Il modulo `markdown.ts`');
  assert.deepEqual(covered(r), [
    ['heading', 'Il modulo '],
    ['code', 'markdown.ts'],
  ]);
});

test('asterischi dentro un code span sono contenuto, non marcatura', () => {
  const r = parseMarkdown('scrivi `**così**` per il grassetto');
  assert.equal(r.text, 'scrivi **così** per il grassetto');
  assert.deepEqual(covered(r), [['code', '**così**']]);
});

test('le tabelle restano testo, ma l\'inline ci gira sopra (D3)', () => {
  const r = parseMarkdown('| `code` | **bold** |');
  assert.equal(r.text, '| code | bold |');
  assert.deepEqual(covered(r), [
    ['code', 'code'],
    ['bold', 'bold'],
  ]);
});

test('le checkbox restano ASCII (D4)', () => {
  const r = parseMarkdown('- [ ] da fare\n- [x] fatto');
  assert.equal(r.text, '• [ ] da fare\n• [x] fatto');
});

test('testo senza marcatura: reso identico al sorgente, nessuno span', () => {
  const src = 'righe normali\n\ncon una vuota in mezzo';
  const r = parseMarkdown(src);
  assert.equal(r.text, src);
  assert.deepEqual(r.spans, []);
});

test('gli span sono ordinati, disgiunti e dentro il reso', () => {
  const r = parseMarkdown(
    '# Titolo\n\n- **uno** e `due`\n\n```\nfence\n```\n\ntesto **tre** finale',
  );
  let prev = 0;
  for (const s of r.spans) {
    assert.ok(s.start >= prev, `span sovrapposto o fuori ordine a ${s.start}`);
    assert.ok(s.end > s.start, 'span vuoto');
    assert.ok(s.end <= r.text.length, 'span oltre la fine del reso');
    prev = s.end;
  }
});

test('il reso non è mai più largo del sorgente: i marker si tolgono, non si aggiungono', () => {
  const cases = [
    '**a** `b` ## c',
    '- **voce** con `codice`',
    '#### Titolo `con codice` e **enfasi**',
    '```\nletterale **e** `intatto`\n```',
  ];
  for (const src of cases) {
    const r = parseMarkdown(src);
    assert.ok(
      termWidth(r.text) <= termWidth(src),
      `il reso di ${JSON.stringify(src)} è più largo del sorgente`,
    );
  }
});

test('idempotenza dell\'ordine con sanitize: i marker attraversano intatti (D1)', () => {
  // `sanitize` sta PRIMA del parse perché non conserva la lunghezza. La
  // condizione che lo rende sicuro è questa: i marker sono ASCII e cadono fuori
  // dal suo insieme di rischio, quindi il parser li ritrova tutti.
  const src = '- **⚡ priorità** con `⚠ nota`';
  const r = parseMarkdown(sanitize(src));
  assert.deepEqual(
    r.spans.map((s) => s.kind),
    ['bold', 'code'],
  );
});

// --- sliceSpans: intersezione riga ↔ span ------------------------------------

/** Il documento reso, wrappato, con le sue righe pronte da intersecare. */
function wrapped(src: string, width: number) {
  const doc = parseMarkdown(src);
  return { doc, lines: wrapWithOffsets(doc.text, width) };
}

test('sliceSpans: copre la riga per intero, buchi inclusi', () => {
  const { doc, lines } = wrapped('prima **forte** dopo', 80);
  const segs = sliceSpans(lines[0]!, doc.spans);
  assert.deepEqual(segs, [
    { text: 'prima ', kind: null },
    { text: 'forte', kind: 'bold' },
    { text: ' dopo', kind: null },
  ]);
  assert.equal(segs.map((s) => s.text).join(''), lines[0]!.text);
});

test('sliceSpans: uno span a cavallo dell\'a-capo si colora su ENTRAMBE le righe', () => {
  const { doc, lines } = wrapped('**alfa beta gamma delta**', 12);
  assert.ok(lines.length > 1, 'il caso richiede almeno due righe');
  for (const l of lines) {
    const segs = sliceSpans(l, doc.spans);
    assert.deepEqual(
      segs.map((s) => s.kind),
      ['bold'],
      `riga ${JSON.stringify(l.text)} non interamente in grassetto`,
    );
  }
});

test('sliceSpans: riga vuota → nessun segmento (il render mette lo spazio)', () => {
  const { doc, lines } = wrapped('uno\n\ndue', 80);
  assert.deepEqual(sliceSpans(lines[1]!, doc.spans), []);
});

test('sliceSpans: gli span delle altre righe non sporcano questa', () => {
  const { doc, lines } = wrapped('# Titolo\ntesto\n`codice`', 80);
  assert.deepEqual(sliceSpans(lines[1]!, doc.spans), [{ text: 'testo', kind: null }]);
});

// --- integrazione parse → wrap ----------------------------------------------

test('parse→wrap: nessuna riga supera il budget in COLONNE', () => {
  // È la condizione che tiene in piedi il bordo del pane: una riga più larga
  // del riservato lo mangia (invariante ③ di width.ts).
  const src = [
    '# Task: rendering **markdown** nel detail',
    '',
    '- **ID**: T75 con `src/markdown.ts` e una coda lunga che deve andare a capo per forza',
    '  - annidata con `un identificatore parecchio lungo` in mezzo',
    '',
    '```',
    'una riga letterale con **asterischi** che non devono sparire e che è lunga',
    '```',
  ].join('\n');
  for (const width of [20, 40, 72]) {
    for (const l of wrapWithOffsets(parseMarkdown(src).text, width)) {
      assert.ok(
        termWidth(l.text) <= width,
        `riga di ${termWidth(l.text)} colonne con budget ${width}: ${JSON.stringify(l.text)}`,
      );
    }
  }
});

test('parse→wrap: l\'a-capo cade sul reso, non sul sorgente', () => {
  // Wrappando il grezzo i 4 caratteri di `**` conterebbero, e la riga uscirebbe
  // corta di 4 colonne — un a-capo sbagliato, non un difetto estetico.
  const src = '**dodici**cinque';
  const reso = parseMarkdown(src).text;
  assert.equal(reso, 'dodicicinque');
  assert.equal(wrapWithOffsets(reso, 12).length, 1);
  assert.equal(wrapWithOffsets(src, 12).length, 2);
});

test('parse→wrap: ogni riga è una fetta contigua del reso', () => {
  // È l'invariante su cui poggiano sia l'evidenziazione della ricerca sia
  // `sliceSpans`: senza, intersecare gli intervalli non basterebbe più.
  const doc = parseMarkdown('# Titolo\n\n- **voce** una\n- `altra` voce piuttosto lunga');
  for (const l of wrapWithOffsets(doc.text, 16)) {
    assert.equal(doc.text.slice(l.start, l.end), l.text);
  }
});
