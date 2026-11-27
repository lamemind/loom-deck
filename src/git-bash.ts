// T175 — il bash di Git for Windows: dove sta, e come lo riceve un `claude`
// lanciato dal deck.
//
// T178 — lo stesso bash esegue gli script `.sh` del plugin (`scriptCommand`).
//
// Serve già qui e non solo agli script `.sh` del plugin, per il verdetto
// 9 di T174: un `claude` che eredita il `PATH` di Git Bash esegue gli hook del
// plugin in PowerShell — `cat` diventa `Get-Content`, lo script `.sh` una
// stringa stampata — e la task non arriva in contesto. Con
// `CLAUDE_CODE_GIT_BASH_PATH` nell'env, la variabile con cui Claude Code sceglie
// il proprio bash, gli hook tornano in bash. Un deck avviato da Git Bash non la
// porta: la risolve lui.
//
// Modulo PURO nel cuore (`resolveGitBash` riceve il filesystem come funzione),
// con un involucro che legge quello vero. Su Linux non fa niente.
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export const GIT_BASH_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';

/**
 * Quanti livelli sopra la cartella di `git.exe` si cerca `bin\bash.exe`. Tre
 * coprono le tre posizioni di `git.exe` in Git for Windows: `Git\cmd\` (quella
 * del `PATH` di Windows), `Git\bin\` e `Git\mingw64\bin\` (la prima del `PATH`
 * di Git Bash, dove accanto non c'è nessun bash).
 */
const MAX_UP = 3;

/**
 * Il bash di Git, o `null`.
 *
 * Cascata (P6 preflight): la variabile, se impostata — è la scelta esplicita di
 * chi ha configurato Claude Code; poi ogni `git.exe` del `PATH`, nell'ordine,
 * risalendo da lì fino a trovare `bin\bash.exe`. Mai `bash` dal `PATH`: Git
 * aggiunge solo `Git\cmd`, e `C:\Windows\System32\bash.exe` è il lanciatore di
 * WSL. Mai un path cablato: Git può stare fuori da `C:\Program Files\Git`
 * (sulla macchina di T174 sta in `C:\Dev\Tools\Git`).
 */
export function resolveGitBash(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): string | null {
  const explicit = env[GIT_BASH_ENV];
  if (explicit) return explicit;
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(win32.delimiter)) {
    if (!dir) continue;
    const git = win32.join(dir, 'git.exe');
    if (!exists(git)) continue;
    let at = win32.dirname(git);
    for (let i = 0; i < MAX_UP; i++) {
      const bash = win32.join(at, 'bin', 'bash.exe');
      if (exists(bash)) return bash;
      const up = win32.dirname(at);
      if (up === at) break;
      at = up;
    }
  }
  return null;
}

let cached: string | null | undefined;

/** Il bash di Git di questa macchina, risolto una volta per vita del deck:
 *  un'installazione di Git non si sposta mentre il deck è aperto. */
export function gitBash(): string | null {
  if (cached === undefined) cached = resolveGitBash(process.env, existsSync);
  return cached;
}

/** Come si lancia un processo: l'eseguibile e i suoi argomenti. */
export interface ScriptCommand {
  cmd: string;
  args: string[];
}

/**
 * T178 — come si esegue uno script `.sh` del plugin, o `null` se qui non si può.
 *
 * Su Linux lo script si lancia da sé: lo shebang `#!/bin/bash` e l'exec bit
 * scelgono l'interprete, come prima di T178 (P2 preflight). Su win32 nessuno dei
 * due vale, e l'interprete è il bash di Git (`gitBash`), con lo script come primo
 * argomento; senza bash di Git lo script non si può eseguire, e il chiamante lo
 * tratta come la funzione spenta.
 *
 * Il path dello script viaggia con le barre `/`: gli script del plugin trovano
 * `lib.sh` con `dirname "${BASH_SOURCE[0]}"`, e la barra è il separatore che ogni
 * strumento di Git Bash riconosce. Le barre `\` di un path di Windows dipendono
 * da come ogni strumento le legge.
 *
 * La piattaforma è quella VERA e non quella delle funzioni (`platform.ts`): il
 * comando deve partire sul sistema che c'è, anche quando un test simula l'altro.
 */
export function scriptCommand(
  script: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  bash: () => string | null = gitBash,
): ScriptCommand | null {
  if (platform !== 'win32') return { cmd: script, args: [...args] };
  const found = bash();
  if (!found) return null;
  return { cmd: found, args: [script.replace(/\\/g, '/'), ...args] };
}

/**
 * L'env di un `claude` lanciato dal deck.
 *
 * Su win32, quello del deck più `CLAUDE_CODE_GIT_BASH_PATH` quando non c'è già e
 * il bash si trova; senza bash il figlio parte con l'env del deck, come prima.
 * Altrove `undefined`, cioè l'env ereditato di `spawn`: nessun cambio su Linux.
 */
export function claudeEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  bash: () => string | null = gitBash,
): NodeJS.ProcessEnv | undefined {
  if (platform !== 'win32' || env[GIT_BASH_ENV]) return undefined;
  const found = bash();
  return found ? { ...env, [GIT_BASH_ENV]: found } : undefined;
}
