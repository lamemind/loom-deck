// T232 — gate di larghezza (vedi `frame-width.test.ts`): il modo doc — l'albero,
// il modale delle combo, il pane inbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_B, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, docCacheRoot, lastFrame } from './frame-kit.js';

// T160 — gli scenari del MODO DOC, tutti sulla stessa cache finta, scritta
// per ogni scenario come per hard-wrap e gitlink: la cache va
// scritta prima, e un temporaneo creato al modulo sarebbe condiviso da
// scenari che non la usano.
//
// Il gate misura la LARGHEZZA, quindi da solo resterebbe verde su una schermata
// sbagliata: sugli scenari dove esiste una riga che li distingue si asserisce
// anche il CONTENUTO, per non certificare una nota di attesa al posto
// dell'albero.
const DOC_SCENARIOS: Array<[string, string, number[], string?]> = [
  // Il pane doc montato: colonna dei flag a larghezza fissa più una cella
  // elastica calcolata per sottrazione, con in più il rientro dell'albero — la
  // stessa aritmetica che ha fatto uscire dal pane la lista sessioni due volte.
  // Il path più profondo della fixture sta a quattro livelli, dove il rientro
  // morde davvero.
  ['modo doc · albero', CTRL_B, [80, 100, 176], 'ONL'],
  // `tab` sul catalogo doc, che ha una voce sola: il giro torna su `Tutti` e la
  // schermata resta quella dell'albero.
  ['modo doc · tab sull’unica vista', `${CTRL_B}T`, [80, 100], 'Tutti'],
  // `←→` fra i due pane dello stesso modo: il fuoco si sposta, i bordi no.
  ['modo doc · fuoco a destra e ritorno', `${CTRL_B}RL`, [80, 100]],
  // T194 — il modale delle combo in modo doc: le colonne sono quelle dei due pane.
  ['modo doc · modale combo', `${CTRL_B}H`, [80, 100, 176], 'albero doc'],
  // Il pane inbox, che in modo doc occupa lo slot destro. Due colonne fisse
  // (natura, marker) più una cella elastica: il nome di un file inbox arriva ai
  // 45 caratteri, cioè sfora da solo il pane a 80 colonne.
  ['modo doc · inbox a destra', `${CTRL_B}R`, [80, 100, 176]],
  ['modo doc · vista inbox sweep attiva', `${CTRL_B}RTTT`, [80, 100]],
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
