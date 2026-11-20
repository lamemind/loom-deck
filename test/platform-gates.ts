// T175 — i gate dei test che non possono girare su ogni piattaforma, col
// MOTIVO del salto.
//
// Un gate senza motivo si legge nel report come un test saltato per caso, e un
// gate che decide solo su un sintomo (`python3` assente) salta sulla macchina
// sbagliata per la ragione sbagliata: su un Windows con Python installato i gate
// pty partivano e fallivano, perché `pty` e `termios` non esistono lì. Qui il
// motivo nomina la dipendenza vera.
//
// Non è un file di test (`*.test.ts`): il runner non lo esegue, lo importano.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Il motivo per cui un test che dipende da `why` non gira qui, o `false`. */
export function unixOnly(why: string): string | false {
  return process.platform === 'win32' ? `solo Unix: ${why}` : false;
}

/** Il gemello di `unixOnly`: il test interroga uno strumento che c'è solo su
 *  Windows. */
export function windowsOnly(why: string): string | false {
  return process.platform === 'win32' ? false : `solo Windows: ${why}`;
}

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * T232 — la variabile con cui `test/run.mjs` chiede la suite RAPIDA, quella di
 * `npm test`: i gate pty — i test che avviano il deck vero sotto
 * `test/pty-frame.py` — non partono, e la suite sta nel timeout di foreground di
 * chi la lancia. La suite completa è `npm run test:full`.
 *
 * La imposta solo il runner, in modalità di default, e `--full` la toglie
 * dall'ambiente del figlio anche quando la shell di chi lancia la porta: un
 * file pty lanciato a mano con `tsx --test` non la vede, e gira per intero.
 */
export const QUICK_SUITE_ENV = 'LOOM_DECK_TEST_QUICK';

/** Il motivo per cui un gate pty non gira nella suite rapida, o `false`. */
export function quickSuite(): string | false {
  return process.env[QUICK_SUITE_ENV] === '1'
    ? 'suite rapida: i gate pty girano con npm run test:full'
    : false;
}

/**
 * Il gate del driver `test/pty-frame.py`, comune a ogni test che lo usa: la
 * suite rapida prima di tutto, poi la piattaforma (su Windows `python3` non si
 * interroga nemmeno — è spesso l'alias dello Store), poi l'interprete.
 */
export function ptyDriverGate(): string | false {
  return (
    quickSuite() ||
    unixOnly('pty-frame.py usa pty, termios e TIOCSWINSZ') ||
    (hasPython() ? false : 'python3 assente')
  );
}

/**
 * Il gate dei test che avviano il deck vero sotto `test/pty-frame.py` sul
 * progetto loom che contiene il deck: il driver, poi il progetto.
 */
export function ptyGate(tasksPath: string): string | false {
  return ptyDriverGate() || (existsSync(tasksPath) ? false : `progetto loom assente (${tasksPath})`);
}
