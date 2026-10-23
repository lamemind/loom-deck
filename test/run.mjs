// Il runner di `npm test`: elenca i file di test da sé e dà alla suite una
// cartella temporanea propria, cancellata alla fine.
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
//
// Gli argomenti dopo `npm test --` passano al test runner prima dei file
// (`npm test -- --test-name-pattern=docs`).
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

const runTmp = mkdtempSync(join(tmpdir(), 'loom-deck-test-'));
let code = 1;
try {
  const result = spawnSync(process.execPath, [tsxCli, '--test', ...process.argv.slice(2), ...files], {
    cwd: dirname(testDir),
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp },
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
process.exit(code);
