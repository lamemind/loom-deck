// T232 — gate di larghezza (vedi `frame-width.test.ts`): il budget d'ALTEZZA su
// terminali bassi, e il modale delle combo su un terminale stretto o basso.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_F, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame } from './frame-kit.js';
import { detailProject } from './detail-fixture.js';

// T91 — il budget d'ALTEZZA, che gli scenari sopra non provano: girano tutti a
// 38 righe, dove due righe in più non si notano. Il campo di ricerca è la riga
// fissa che, non scalata dalla cornice, fa sfondare `rows` su un terminale basso
// — e Ink che sfonda cade nel ramo `clearTerminal`, che su VTE versa un frame
// nello scrollback a ogni tick del poll.
for (const rows of [16, 20]) {
  test(`altezza · detail con ricerca @ ${rows} righe`, { skip: SKIP }, () => {
    const raw = capture(100, rows, `DD\r${CTRL_F}task`);
    const frame = lastFrame(raw).filter((l) => l !== '');
    assert.ok(
      frame.length <= rows,
      `frame di ${frame.length} righe in un terminale di ${rows}`,
    );
  });

  // T111/T117/T158 — le cinque righe dell'area di compilazione sono FISSE, quindi
  // si pagano anche senza ricerca aperta: è il caso che cade per primo se
  // `DETAIL_FIELD_ROWS` resta al conteggio di prima. Sul progetto sintetico
  // (T189): `T` porta ai campi da una task che si apre sulla lista DLV.
  //
  // T189 — e la lista DLV, più alta dello spazio a entrambe le altezze, con e
  // senza ricerca aperta: è l'area di altezza VARIABILE, quella che sfonda se
  // `dlvListRows` e `detailCapacity` non si dividono lo stesso spazio.
  for (const [what, keys] of [
    ["l'area di compilazione", 'DD\rTDDDX'],
    ['la lista DLV', 'DD\r'],
    ['la lista DLV e la ricerca', `DD\r${CTRL_F}glifo`],
  ] as const) {
    test(`altezza · detail con ${what} @ ${rows} righe`, { skip: SKIP }, () => {
      const { proj, env } = detailProject();
      const raw = capture(100, rows, keys, env, proj);
      const frame = lastFrame(raw).filter((l) => l !== '');
      assert.ok(
        frame.length <= rows,
        `frame di ${frame.length} righe in un terminale di ${rows}`,
      );
    });
  }

  // T169 — il finder riserva righe FISSE alla preview sotto la lista: è la
  // riserva che sfonda `rows` se `finderLayout` e la schermata non contano le
  // stesse righe. A 16 righe la preview non entra e cade per prima; a 20 entra.
  test(`altezza · finder @ ${rows} righe`, { skip: SKIP }, () => {
    const raw = capture(100, rows, '`T');
    const frame = lastFrame(raw).filter((l) => l !== '');
    assert.ok(frame.join('\n').includes('trova task'), 'il gate non sta misurando il finder');
    assert.ok(
      frame.length <= rows,
      `frame di ${frame.length} righe in un terminale di ${rows}`,
    );
  });

  // T194 — il modale delle combo su un terminale più basso dell'elenco: è il caso
  // in cui una riga di cornice non contata sfonda `rows`.
  test(`altezza · modale combo @ ${rows} righe`, { skip: SKIP }, () => {
    const raw = capture(100, rows, 'RH');
    const frame = lastFrame(raw).filter((l) => l !== '');
    assert.ok(frame.join('\n').includes('tutte le azioni'), 'il gate non sta misurando il modale');
    assert.ok(
      frame.length <= rows,
      `frame di ${frame.length} righe in un terminale di ${rows}`,
    );
    assertFrameFits(raw, 100, `modale combo@${rows}`);
  });

  // T112 — la conferma è un modale IN FLUSSO: spinge giù i pane, quindi le sue
  // 7 righe vanno scalate dal budget delle liste. Non scalate, il frame supera
  // `rows` e Ink cade nel ramo `clearTerminal` — su VTE un frame nello
  // scrollback a ogni tick del poll. Terminale stretto E basso insieme, che è
  // proprio la condizione in cui quel ramo scatta.
  test(`altezza · conferma di eliminazione @ ${rows} righe`, { skip: SKIP }, () => {
    const raw = capture(80, rows, 'DDK');
    const frame = lastFrame(raw).filter((l) => l !== '');
    assert.ok(
      frame.length <= rows,
      `frame di ${frame.length} righe in un terminale di ${rows}`,
    );
  });
}

// T194 — a 40 colonne le due liste non stanno affiancate e si impilano. Il frame
// normale che precede il modale è più alto del terminale, e Ink non va a capo dopo
// un frame così: il `╭` del modale resta sulla riga del `╯` di chiusura, e senza
// separarli il gate misurerebbe il frame normale.
test('il modale combo a 40 colonne impila le liste senza uscire dal box', { skip: SKIP }, () => {
  const raw = capture(40, 38, 'H').replace(/╯((?:\x1b\[[0-9;?]*[A-Za-z])*)╭/g, '╯\n$1╭');
  assertFrameFits(raw, 40, 'modale combo@40');
  const text = lastFrame(raw).join('\n');
  assert.match(text, /│ task +│/, `liste non impilate: ${text}`);
  assert.match(text, /│ conversazioni +│/, `liste non impilate: ${text}`);
  assert.match(text, /A +assegna/, `voce persa: ${text}`);
});

// T194 — su un terminale basso l'elenco non entra: ogni voce si raggiunge
// scorrendo, con le tre vie del viewer. A 16 righe la capienza è 8, quindi mezza
// pagina vale 4 e una tacca di rotella 3.
test('il modale combo raggiunge ogni voce scorrendo', { skip: SKIP }, () => {
  const text = (keys: string) => lastFrame(capture(100, 16, keys)).join('\n');
  assert.match(text('RH'), /righe 1-8 di \d+/);
  assert.match(text('RH>'), /righe 5-12 di \d+/);
  assert.match(text('RH_10,10;'), /righe 4-11 di \d+/);
  // `G` porta in fondo: la riga finale è il totale, e l'ultima voce è a schermo.
  const bottom = text('RHG');
  assert.match(bottom, /righe \d+-(\d+) di \1\b/, `non è in fondo: ${bottom}`);
  assert.match(bottom, /w\s+salva/, `ultima voce assente: ${bottom}`);
});
