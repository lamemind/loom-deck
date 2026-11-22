// T232 — gate di larghezza (vedi `frame-width.test.ts`): la pagina delle azioni
// di spawn e la pagina delle voci launch.

import { test } from 'node:test';
import { CTRL_L, CTRL_S, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, toSpawnRow } from './frame-kit.js';

/** `[label, tasti, larghezze, env?]` — le due schermate sostitutive (T52) si
 *  provano a una larghezza sola: il costo è un deck vero avviato per ogni
 *  combinazione. */
const SCENARIOS: Array<[string, string, number[], NodeJS.ProcessEnv?]> = [
  // T161 — la pagina delle azioni di spawn. Quattro colonne calcolate per
  // sottrazione, due delle quali elastiche: è la stessa aritmetica che ha fatto
  // uscire dal pane la lista sessioni due volte. A 80 colonne il prompt scende
  // sotto le venti celle, cioè il caso in cui una colonna di troppo mangia il
  // bordo.
  ['pagina azioni di spawn', CTRL_S, [80, 100, 176]],
  // L'area di compilazione aperta: tre righe in più, di cui una col campo di
  // testo più lungo del catalogo (il prompt della regia): la riga `regia`.
  ['pagina azioni · area aperta', `${CTRL_S}${toSpawnRow('regia')}\r`, [80, 100, 176]],
  // La riga `bare`, dove due celle su tre non si modificano: l'area disegna
  // comunque le loro righe, con la ragione al posto del campo.
  ['pagina azioni · celle fisse', `${CTRL_S}${toSpawnRow('bare')}\r`, [80, 100, 176]],
  // T168 — la pagina delle voci launch: due righe per voce, colonna comando
  // elastica per sottrazione — a 80 colonne il comando del pull all del cappello
  // scende sotto le venti celle, cioè il caso in cui una colonna di troppo
  // mangia il bordo.
  ['pagina launch', CTRL_L, [80, 100, 176]],
  ['pagina launch · campo a fuoco', `${CTRL_L}\t`, [80, 100, 176]],
];

for (const [label, keys, widths, extraEnv] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      assertFrameFits(capture(cols, 38, keys, extraEnv), cols, `${label}@${cols}`);
    });
  }
}
