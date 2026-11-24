// T232 — gate di larghezza (vedi `frame-width.test.ts`): l'orchestrator dei perimetri
// — il bottone `direct` nel detail di un'epica e di un mandato, la riga `orchestrator`
// nella pagina delle azioni — sul progetto sintetico di `detail-fixture.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_S, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame, toSpawnRow } from './frame-kit.js';
import { detailProject } from './detail-fixture.js';

const DETAIL_SCENARIOS: Array<[string, string, number[], string]> = [
  // T203 — l'orchestrator in coda alla riga azioni dei perimetri: sei bottoni
  // sull'epica, cinque sul mandato. A 80 colonne la riga non ci sta intera e
  // `cutParts` la taglia attorno alla selezione: il gate misura che il taglio
  // tenga il bordo; a 100 la riga entra tutta, e `direct` è l'ultimo bottone.
  ['detail · epica con l’orchestrator', 'DDDDDDD\r', [80, 100, 176], '[ checkpoint ]  [ direct ]'],
  ['detail · epica, orchestrator selezionata', 'DDDDDDD\rd', [80, 100, 176], '🎬 epica'],
  ['detail · mandato con l’orchestrator', 'DDDDDD\r', [100, 176], '[ checkpoint ]  [ direct ]'],
  // La riga `orchestrator` nella pagina delle azioni di spawn, con la sua area aperta:
  // la funzione nella tabella, il titolo e il prompt nei campi.
  ['pagina azioni · riga orchestrator', `${CTRL_S}${toSpawnRow('orchestrator')}`, [100, 176], 'orchestra un perimetro'],
  ['pagina azioni · orchestrator aperto', `${CTRL_S}${toSpawnRow('orchestrator')}\r`, [80, 100, 176], '🎬 {slug}'],
];

for (const [label, keys, widths, needle] of DETAIL_SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      const { proj, env } = detailProject();
      const raw = capture(cols, 38, keys, env, proj);
      assertFrameFits(raw, cols, `${label}@${cols}`);
      if (cols >= 100) {
        assert.ok(
          lastFrame(raw).join('\n').includes(needle),
          `${label}@${cols}: atteso "${needle}" a schermo — il gate stava misurando un'altra schermata`,
        );
      }
    });
  }
}
