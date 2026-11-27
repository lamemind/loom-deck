// T179 — QUALE comando di una voce launch vale su questa piattaforma, e COME si
// lancia.
//
// Una voce porta il comando di Linux in `command` e quello di Windows in
// `windows`, almeno uno dei due (D1 preflight): il file di progetto è
// committato e viaggia su entrambe le macchine, e un campo solo non può servire
// due sistemi operativi. Il deck tiene i due campi separati nella voce e sceglie
// solo qui, al momento dello spawn: così la pagina `^L` riconosce la voce sul
// file anche quando sulla piattaforma corrente la voce non ha un comando.
//
// Due piattaforme diverse, come in `platform.ts` e in `git-bash.ts`:
// - la SCELTA del comando legge la piattaforma delle funzioni (`platform()`),
//   così un test su Linux con `LOOM_DECK_PLATFORM=win32` vede le voci `n/d`;
// - il MODO di lanciarlo legge la piattaforma vera (`process.platform`): il
//   comando deve partire sul sistema che c'è.
//
// Modulo PURO: l'env, il bash e il path di node arrivano come valori.
import type { LaunchEntry } from './config.js';
import { OFF_MARK, platform, platformName } from './platform.js';
import { gitBash } from './git-bash.js';

/** Il campo della voce che porta il comando di questa piattaforma. */
export type LaunchCommandField = 'command' | 'windows';

export function launchField(p: NodeJS.Platform = platform()): LaunchCommandField {
  return p === 'win32' ? 'windows' : 'command';
}

/** Il comando della voce per questa piattaforma, o `null`: la voce qui è `n/d`. */
export function launchCommand(e: LaunchEntry, p: NodeJS.Platform = platform()): string | null {
  return launchField(p) === 'windows' ? e.windows ?? null : e.command;
}

/** Perché una voce senza il comando di questa piattaforma non si lancia, senza
 *  il nome della voce: `n/d su Windows: manca il campo windows`. */
export function launchOffReason(p: NodeJS.Platform = platform()): string {
  return `${OFF_MARK} su ${platformName(p)}: manca il campo ${launchField(p)}`;
}

/** La stessa frase col nome della voce: `codium n/d su Windows: manca il campo
 *  windows`. È ciò che scrive la cifra di una voce `n/d` (P4 preflight). */
export function launchOffText(e: LaunchEntry, p: NodeJS.Platform = platform()): string {
  return `${e.label} ${launchOffReason(p)}`;
}

/**
 * Il wrapper di Linux: il comando dentro `bash -lic`, la stessa shell di ogni
 * voce (così un alias risolve uguale con o senza esito), poi l'exit nel file.
 * `"$1"` e `"$2"` arrivano come argomenti di `bash -c`, mai interpolati nella
 * stringa: un comando con apici o `$` resta la stringa del file.
 */
export const LAUNCH_WRAPPER = 'bash -lic "$1"; printf \'%s\\n\' "$?" > "$2"';

/** Le variabili con cui argv e file di esito arrivano al tramite di Windows. Il
 *  tramite le toglie prima di lanciare il bash, come `LOOM_DECK_NOTIFY_ARGV`. */
export const LAUNCH_ARGV_ENV = 'LOOM_DECK_LAUNCH_ARGV';
export const LAUNCH_EXIT_ENV = 'LOOM_DECK_LAUNCH_EXIT';

/**
 * Il tramite di Windows, come script di `node -e` (CommonJS). Lancia il bash di
 * Git non `detached` e con `windowsHide`, aspetta che esca e, quando il deck gli
 * passa un file di esito, ci scrive l'exit code: è il ruolo che su Linux ha
 * `printf "$?"` nel wrapper.
 *
 * Perché un tramite, e non il bash lanciato dal deck (P3 preflight, misure di
 * `windows-notify.ts` e dell'inbox T173):
 * - un bash `detached` nasce senza console, e ogni programma console che lancia
 *   (`git`) riceve una console nuova, cioè una finestra di Windows Terminal;
 * - un bash non `detached` sta nel job object del deck, e muore col deck.
 * Il tramite è un `node` `detached`: sopravvive al deck e gira senza console.
 * Il bash che lancia ha una console sua, nascosta, che i programmi console
 * ereditano. Il tramite resta vivo finché il bash non esce, perché è lui a
 * tenere aperto il job object in cui il bash gira; è anche il pid che la
 * guardia di concorrenza di `launch-run.ts` controlla.
 *
 * Lo stdout e lo stderr del tramite (il log di una voce con `capture`, o
 * niente) passano al bash così come sono. Un bash che non parte vale exit 127,
 * come «comando non trovato» in una shell; uno terminato senza codice vale 1,
 * come `settleLaunchRecord` legge un `.exit` illeggibile.
 *
 * Nessuna virgoletta doppia: lo script attraversa intero la riga di comando di
 * Windows come un argomento solo (`RELAY_SCRIPT` in `windows-notify.ts`).
 */
export const LAUNCH_RELAY_SCRIPT = [
  `const argv = JSON.parse(process.env.${LAUNCH_ARGV_ENV});`,
  `const exitFile = process.env.${LAUNCH_EXIT_ENV} || '';`,
  `delete process.env.${LAUNCH_ARGV_ENV};`,
  `delete process.env.${LAUNCH_EXIT_ENV};`,
  'const done = (code) => {',
  "  if (exitFile) { try { require('fs').writeFileSync(exitFile, code + '\\n'); } catch (e) {} }",
  '  process.exit(0);',
  '};',
  "require('child_process')",
  "  .spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })",
  "  .on('error', () => done(127))",
  "  .on('exit', (code) => done(code === null ? 1 : code));",
].join('\n');

/** Come si lancia il comando di una voce: eseguibile, argv, ed env quando
 *  l'argv viaggia lì. */
export interface LaunchSpawn {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Il processo da lanciare per il comando di una voce, o `null` se qui non si
 * può: su Windows senza bash di Git. `exitFile` è il file in cui finisce l'exit
 * code, per le voci con esito o con scadenza; `null` per un launcher nudo.
 *
 * - Linux (e ogni piattaforma non Windows): `bash -lic <comando>`, e per le voci
 *   con esito il wrapper `LAUNCH_WRAPPER` — la forma di sempre.
 * - Windows: il tramite `node -e LAUNCH_RELAY_SCRIPT`, con l'argv
 *   `[<bash di Git>, -lc, <comando>]` e il file di esito nell'env (D2
 *   preflight). `-lc` e non `-lic`: senza terminale un bash interattivo non
 *   serve, e la sintassi del comando resta quella di Linux. Il bash di Git si
 *   prende da `gitBash()`, mai dal `PATH`, dove su Windows non c'è o è il
 *   lanciatore di WSL.
 */
export function launchSpawn(
  command: string,
  exitFile: string | null,
  p: NodeJS.Platform = process.platform,
  bash: () => string | null = gitBash,
  nodePath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): LaunchSpawn | null {
  if (p !== 'win32') {
    return exitFile === null
      ? { cmd: 'bash', args: ['-lic', command] }
      : { cmd: 'bash', args: ['-c', LAUNCH_WRAPPER, 'loom-launch', command, exitFile] };
  }
  const found = bash();
  if (!found) return null;
  const relayEnv: NodeJS.ProcessEnv = { ...env, [LAUNCH_ARGV_ENV]: JSON.stringify([found, '-lc', command]) };
  if (exitFile === null) delete relayEnv[LAUNCH_EXIT_ENV];
  else relayEnv[LAUNCH_EXIT_ENV] = exitFile;
  return { cmd: nodePath, args: ['-e', LAUNCH_RELAY_SCRIPT], env: relayEnv };
}
