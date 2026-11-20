// Il runner di `npm test` e di `npm run test:full`: elenca i file di test da sé
// e dà alla suite una cartella temporanea propria, cancellata alla fine.
//
// L'elenco. `tsx --test test/*.test.ts` contava sulla shell per espandere il
// glob: sh lo fa, cmd.exe — la shell degli script npm su Windows — no, e il
// pattern arrivava intero al test runner di Node, che lo espande da sé solo da
// Node 21. Con `engines: >=18` la suite su Windows reggeva per caso. Qui i file
// li elenca `readdirSync`, su ogni piattaforma e ogni versione di Node.
//
// La cartella temporanea. Molti test creano cartelle con `mkdtempSync(tmpdir())`
// e non le tolgono: su Linux `/tmp` si svuota al riavvio, su Windows `%TEMP%`
// no, e ne restavano centinaia. Il figlio riceve `TMPDIR`, `TEMP` e `TMP` su una
// cartella di questa corsa — `os.tmpdir()` legge la prima su POSIX, le altre due
// su Windows —, e la cartella sparisce quando la suite finisce, comunque finisca.
// T196 — anche `XDG_RUNTIME_DIR`, la sede dei socket dell'endpoint del deck: i
// test avviano deck veri, e senza un'altra sede uno di loro ascolterebbe
// sull'indirizzo del progetto vero, al posto del deck aperto dall'utente.
//
// Gli argomenti dopo `npm test --` passano al test runner prima dei file
// (`npm test -- --test-name-pattern=docs`).
//
// Le due suite (T232). `npm test` è la suite RAPIDA: il figlio riceve
// `LOOM_DECK_TEST_QUICK=1`, e i gate pty — i test che avviano il deck vero sotto
// `test/pty-frame.py` e lo pilotano tasto per tasto — risultano saltati, ognuno
// col suo motivo. Sono loro a pesare: la suite completa dura più del timeout di
// foreground di chi la lancia. `npm run test:full` passa `--full`, che toglie la
// variabile dall'ambiente del figlio anche quando la shell la porta. Il nome
// della variabile è `QUICK_SUITE_ENV` di `platform-gates.ts`, ripetuto qui
// perché questo file è JavaScript e non importa TypeScript. In coda all'output
// la suite rapida dice di sé che non è completa: è la parte del risultato che
// chi lancia i test legge sempre, anche senza aver letto nessuna doc.
//
// Il build. La suite gira sui sorgenti, ma tre file lanciano il BUILD in un
// sottoprocesso: `deck-run.test.ts` esegue lo shim `scripts/deck-run`, che da
// T176 fa `exec node dist/deck-run.js`, e `live-marks`/`session-meta` importano
// `dist/` per misurare un freno letto all'import. Su un `dist/` vecchio quei
// test misurerebbero il codice di prima e passerebbero: `npm test` e
// `npm run test:full` buildano prima (`pretest`, `pretest:full`), e chi lancia
// questo file a mano builda da sé.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join('test', name));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const QUICK_SUITE_ENV = 'LOOM_DECK_TEST_QUICK';
const full = process.argv.includes('--full');
const runnerArgs = process.argv.slice(2).filter((arg) => arg !== '--full');

const runTmp = mkdtempSync(join(tmpdir(), 'loom-deck-test-'));
const env = { ...process.env, TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp, XDG_RUNTIME_DIR: runTmp };
if (full) delete env[QUICK_SUITE_ENV];
else env[QUICK_SUITE_ENV] = '1';

let code = 1;
try {
  const result = spawnSync(process.execPath, [tsxCli, '--test', ...runnerArgs, ...files], {
    cwd: dirname(testDir),
    stdio: 'inherit',
    env,
  });
  code = result.status ?? 1;
} finally {
  // `maxRetries`: su Windows un file appena chiuso da un figlio può restare
  // bloccato per qualche millisecondo (`EBUSY`). Una cartella che non si
  // cancella non cambia l'esito della suite.
  try {
    rmSync(runTmp, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    console.error(`⚠ cartella temporanea dei test non rimossa: ${runTmp} (${e.message})`);
  }
}
if (!full) {
  console.log(
    '\n⚠ suite rapida: i gate pty (i test che avviano il deck sotto test/pty-frame.py) sono saltati.' +
      '\n  Suite completa: npm run test:full — dura più del timeout di foreground, va lanciata in background.',
  );
}
process.exit(code);
