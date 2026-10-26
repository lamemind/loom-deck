// T176 — il programma che gira DENTRO una tab di Windows Terminal aperta dal
// deck: legge l'argv di `claude` dalla variabile della tab e lo lancia.
//
// Esiste perché il prompt non deve passare da nessun parser: `wt.exe` legge `;`
// come separatore di sottocomandi, cmd e PowerShell interpretano `' " & % ^ |`
// (P3 preflight). L'argv arriva come JSON nell'env, che la tab eredita da chi
// lancia `wt.exe`, e da qui va a `claude` come array, senza shell.
//
// La variabile si toglie dall'env PRIMA del lancio: è un canale verso questo
// programma, e `claude` la passerebbe a ogni hook e a ogni comando della
// sessione.
//
// `claude` è quello di `claudeLauncher` (T175): l'eseguibile nativo, lo shim npm
// letto, o `LOOM_DECK_CLAUDE_CMD`.
//
// Ctrl+C appartiene a `claude`. In una console Windows il tasto arriva a ogni
// processo attaccato, quindi anche qui: senza un handler questo processo
// uscirebbe, e la tab si chiuderebbe sotto una sessione viva. Si esce solo
// quando esce `claude`, col suo codice — e la tab si chiude o resta aperta
// secondo il `closeOnExit` del profilo (D3 preflight).
import { spawn } from 'node:child_process';
import { claudeLauncher } from './claude-cmd.js';
import { parseTabArgv, TAB_ARGV_ENV } from './windows-terminal.js';

const raw = process.env[TAB_ARGV_ENV];
delete process.env[TAB_ARGV_ENV];
const args = parseTabArgv(raw);

if (!args) {
  process.stderr.write(
    `loom-deck: ${TAB_ARGV_ENV} assente o malformata — questa tab non sa quale conversazione aprire\n`,
  );
  process.exitCode = 2;
} else {
  process.on('SIGINT', () => {});
  const claude = claudeLauncher();
  // `windowsHide: false`: il figlio condivide la console della tab, che è
  // proprio la finestra in cui deve comparire.
  const child = spawn(claude.cmd, [...claude.prefix, ...args], { stdio: 'inherit', windowsHide: false });
  child.on('error', (e) => {
    process.stderr.write(`loom-deck: '${claude.cmd}' non lanciabile (${(e as NodeJS.ErrnoException).code ?? e.message})\n`);
    process.exitCode = 127;
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}
