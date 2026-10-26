// T176 — il punto d'ingresso di `deck-run`: `scripts/deck-run` (lo shim bash
// che compass e i test lanciano) e il deck su Windows eseguono questo file col
// proprio node. La logica sta in `tab-launch.ts`, che si testa senza aprire tab.
import { realIo, runDeckRun } from './tab-launch.js';

runDeckRun(process.argv.slice(2), realIo()).then((code) => {
  process.exitCode = code;
});
