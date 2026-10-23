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

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Il gate dei test che avviano il deck vero sotto `test/pty-frame.py`: la
 * piattaforma prima di tutto (su Windows `python3` non si interroga nemmeno — è
 * spesso l'alias dello Store), poi l'interprete, poi il progetto loom su cui il
 * deck gira.
 */
export function ptyGate(tasksPath: string): string | false {
  return (
    unixOnly('pty-frame.py usa pty, termios e TIOCSWINSZ') ||
    (hasPython() ? false : 'python3 assente') ||
    (existsSync(tasksPath) ? false : `progetto loom assente (${tasksPath})`)
  );
}
