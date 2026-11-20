// T232 — gate di larghezza (vedi `frame-width.test.ts`): il detail del modo doc
// — un file, una cartella, un bersaglio senza flag, un file inbox — sulla cache
// finta di `docCacheRoot()`. Il gate misura la LARGHEZZA: sugli scenari dove una
// riga li distingue si asserisce anche il CONTENUTO.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_B, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, docCacheRoot, lastFrame } from './frame-kit.js';

const DOC_SCENARIOS: Array<[string, string, number[], string?]> = [
  // Il detail di un FILE doc: schermata sostitutiva col testo reso a piena
  // larghezza più la riga dell'azione, che porta il comando col path intero.
  // Le `D` contano le righe dell'ALBERO della fixture, non i file: fra un file e
  // l'altro ci sono le righe cartella. `DDDD` cade su `plugin-dev.md`, il primo
  // file vero dopo `inbox/` e `project/`.
  ['detail doc · file', `${CTRL_B}DDDD\r`, [80, 100, 176], 'rebalance-doc'],
  // Il detail di una CARTELLA (P10): stesso gesto, e al posto del testo l'elenco
  // dei suoi file coi loro flag.
  ['detail doc · cartella', `${CTRL_B}D\r`, [80, 100, 176], 'file ·'],
  // Il bersaglio SENZA flag: la riga azione porta la ragione invece del comando,
  // ed è più lunga di lui — il caso che sfonda se il budget è tarato sul comando.
  // `runtime/tasks.md` è l'ULTIMA riga dell'albero (quindici in tutto) ed è
  // l'unica senza flag: quattordici `D` dalla radice.
  ['detail doc · bersaglio senza flag', `${CTRL_B}${'D'.repeat(14)}\r`, [80, 100], 'non porta flag'],
  // Il detail di un file inbox, raggiunto dal pane destro del modo doc.
  ['detail inbox', `${CTRL_B}RD\r`, [80, 100, 176]],
  // Lo STESSO file raggiunto dall'ALBERO, che lo misura perché sta sotto la
  // docs-root: l'azione proposta deve essere la stessa del pane di destra. `DD`
  // scende su `inbox/` e poi sul suo unico file. Il gate assertava solo la
  // larghezza, e una riga azione con la skill sbagliata ci stava dentro
  // benissimo.
  ['detail doc · file inbox dall’albero', `${CTRL_B}DD\r`, [80, 100, 176], 'drain-notions'],
];

for (const [label, keys, widths, needle] of DOC_SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      const raw = capture(cols, 38, keys, { LOOM_DECK_PLUGIN_CACHE_ROOT: docCacheRoot() });
      assertFrameFits(raw, cols, `${label}@${cols}`);
      // A 80 colonne la riga si tronca e l'ancora può cadere fuori: il controllo
      // di contenuto vale sulle larghezze dove ciò che cerca ci sta.
      if (needle && cols >= 100) {
        assert.ok(
          lastFrame(raw).join('\n').includes(needle),
          `${label}@${cols}: atteso "${needle}" a schermo — il gate stava misurando un'altra schermata`,
        );
      }
    });
  }
}
