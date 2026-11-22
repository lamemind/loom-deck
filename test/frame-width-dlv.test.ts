// T232 — gate di larghezza (vedi `frame-width.test.ts`): la lista DLV del detail
// nei suoi stati, e il mandato in lista e nel detail, sul progetto sintetico di
// `detail-fixture.ts`. Il contenuto si asserisce insieme alla larghezza: un gate
// di sola larghezza resterebbe verde anche sul modo sbagliato.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_F, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame } from './frame-kit.js';
import { detailProject } from './detail-fixture.js';

const DETAIL_SCENARIOS: Array<[string, string, number[], string]> = [
  // La lista DLV all'apertura: quattordici voci più larghe della riga, glifi
  // larghi nel testo e la spunta (larga 2) dei fatti nella colonna di stato.
  ['detail DLV · apertura', 'DD\r', [80, 100, 176], '⏎ open · opus'],
  // Due voci selezionate: la riga di stato porta il prompt col perimetro, il
  // pezzo che il budget serve per primo.
  ['detail DLV · selezione', 'DD\r D ', [80, 176], 'run-task T1 DLV 2,4'],
  // `↑` dal primo aperto gira sull'ultimo: la finestra scende in fondo alla
  // lista e la riga di stato conta le voci rimaste sopra — a 38 righe la lista
  // ne mostra 13 su 14.
  ['detail DLV · cursore in coda', 'DD\rU', [80, 176], '↑1 ↓0'],
  // Gli stati senza selezione possibile: il motivo sta davanti a `open`, ed è
  // più lungo di lui — il caso che sfonda se il budget è tarato sul prompt.
  ['detail DLV · task chiusa', 'DDD\rT', [80, 176], 'task chiusa · ⏎ open'],
  // L'avviso: motivo in testa E prompt dietro, la riga di stato più lunga.
  ['detail DLV · Size L senza preflight', 'DDDD\r', [80, 176], 'Size L senza preflight'],
  ['detail DLV · nessun deliverable', 'DDDDD\rT', [80, 176], 'nessun deliverable'],
  // La ricerca aperta sopra la lista: due righe fisse in più, pagate dalla
  // lista e dal testo insieme.
  ['detail DLV · ricerca aperta', `DD\r${CTRL_F}glifo`, [100], 'cerca glifo'],
  // T212 — il mandato T5. In lista: la Prog accesa e la coda dei membri in
  // quadra, nella colonna riservata — `[1/3` e non `[1/4`, perché T9 non ha riga.
  ['lista · riga di mandato', 'DDDDDD', [80, 100, 176], '[1/3'],
  // Nel detail la riga azioni senza `run`: `preflight` e `status` adiacenti
  // sono la prova, perché su ogni altra task `run` sta fra i due.
  ['detail · mandato senza run', 'DDDDDD\r', [100, 176], '[ preflight ]  [ status ]'],
  // Il modo DLV spento col motivo, anche con una checklist nel file.
  ['detail DLV · mandato', 'DDDDDD\rT', [80, 176], 'mandato: il lavoro sta nei membri'],
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
