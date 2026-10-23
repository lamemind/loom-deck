// T175 — il bash di Git for Windows: dove sta, e come lo riceve un `claude`
// lanciato dal deck.
//
// Serve già qui e non solo a T178 (gli script `.sh` del plugin), per il verdetto
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
