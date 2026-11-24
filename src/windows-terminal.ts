// T176 — le tab di WINDOWS TERMINAL: argv di `wt.exe`, env della tab, il canale
// che porta l'argv di `claude` al wrapper.
//
// Su Windows una conversazione si apre con
//
//     wt.exe -w 0 new-tab -p loom-deck -d <root> --title <titolo>
//            --suppressApplicationTitle -- <node> <tab-wrapper.js>
//
// e l'argv di `claude` (nome, flag, prompt) NON sta su quella riga: viaggia come
// JSON nella variabile `LOOM_DECK_TAB_ARGV`, perché la tab eredita l'env del
// processo che lancia `wt.exe` (T174 verdetto 5, rimisurato con `-p`). Il
// wrapper la legge, la toglie e lancia `claude` senza shell (P3 preflight).
// Così il prompt non passa né dal parser di `wt` né da una shell: `wt` legge `;`
// come separatore di sottocomandi in QUALUNQUE argomento, anche dopo `--` e
// anche escapato `\;` (misurato su Windows Terminal 1.24: la coda dopo il `;`
// diventa una tab a sé, col proprio errore), e cmd o PowerShell
// interpreterebbero `' " & % ^ |`.
//
// Modulo PURO: l'env arriva come valore, il bash di Git come stringa già
// risolta.

import { bindSession, dropEnv, INHERITED_SESSION_ENV, type SessionBinding } from './session-env.js';

/** Il lanciatore di Windows Terminal: l'alias d'esecuzione in `WindowsApps`,
 *  che `spawn` trova nel `PATH` e lancia senza shell (misurato). */
export const WT_CMD = 'wt.exe';

/** Il profilo delle tab del deck (P9 preflight): uno solo per tutti i
 *  progetti, nascosto dal menu, creato a mano dall'utente nel `settings.json` di
 *  Windows Terminal. Porta ciò che i flag non dicono — font, `closeOnExit`, la
 *  shell del tasto `t`; titolo, cartella e comando li passa il deck. */
export const WT_PROFILE_DEFAULT = 'loom-deck';

/** La variabile con cui l'argv di `claude` arriva al wrapper della tab. */
export const TAB_ARGV_ENV = 'LOOM_DECK_TAB_ARGV';

const GIT_BASH_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';

/** Il profilo da passare a `-p`: `LOOM_DECK_WT_PROFILE` se impostata (vuota =
 *  nessun `-p`, il profilo di default di Windows Terminal), altrimenti
 *  `loom-deck`. Un profilo che non esiste non è un errore: Windows Terminal
 *  apre la tab col profilo di default e non dice niente (misurato), quindi il
 *  deck lo passa sempre senza verificarlo. */
export function wtProfile(env: Readonly<Record<string, string | undefined>>): string | null {
  const v = env.LOOM_DECK_WT_PROFILE;
  if (v === undefined) return WT_PROFILE_DEFAULT;
  return v || null;
}

/** Il titolo come lo riceve `wt`: senza `;`, che spezzerebbe il comando. Il
 *  titolo è composto dal deck (label, TaskID, nota ridotta) e un `;` può
 *  venire solo dal nome del progetto: si toglie invece di fallire. */
export function wtTitle(title: string): string {
  return title.replace(/;/g, '');
}

export interface WtTab {
  newWindow: boolean;
  profile: string | null;
  cwd: string;
  /** `null` = nessun titolo: la tab prende quello della shell. */
  title: string | null;
  /** Il comando della tab; assente = il `commandline` del profilo. */
  command?: readonly string[];
}

/**
 * L'argv di `wt.exe` per una tab nuova.
 *
 * `-w 0` è la finestra di Windows Terminal usata per ultima — quella da cui si
 * lavora col deck —, `-w new` una finestra nuova (l'equivalente di
 * `--new-window` di Ptyxis). `--suppressApplicationTitle` tiene il titolo del
 * deck contro quello che il programma della tab imposta (misurato): è ciò che su
 * Linux fa `-T` di Ptyxis contro l'OSC del prompt. Senza titolo il flag non si
 * passa, e la tab prende quello della shell.
 */
export function wtNewTabArgs(tab: WtTab): string[] {
  const args = ['-w', tab.newWindow ? 'new' : '0', 'new-tab'];
  if (tab.profile) args.push('-p', tab.profile);
  args.push('-d', tab.cwd);
  if (tab.title !== null) args.push('--title', wtTitle(tab.title), '--suppressApplicationTitle');
  if (tab.command) args.push('--', ...tab.command);
  return args;
}

/**
 * Il primo argomento di `wt` che contiene un `;`, o `null`.
 *
 * Il titolo è già ripulito; restano i path (la cartella, node, il wrapper) e il
 * nome del profilo. Un path col `;` è legale su NTFS e `wt` non lo sa portare:
 * lo spawn si ferma dicendolo, invece di aprire una tab d'errore con metà
 * comando.
 */
export function semicolonArg(args: readonly string[]): string | null {
  return args.find((a) => a.includes(';')) ?? null;
}

function hasKey(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  const want = key.toUpperCase();
  return Object.keys(env).some((k) => k.toUpperCase() === want && env[k]);
}

/**
 * L'env di una tab aperta dal deck su Windows: quello del deck, meno le
 * variabili di sessione (`INHERITED_SESSION_ENV`), con la task della
 * conversazione e il bash di Git.
 *
 * `binding.task` = `null` per le tab senza task (`--no-task`, il tasto `t`): una
 * `LOOM_TASK` ereditata legherebbe a una task una sessione che non ne ha, e
 * l'hook `SessionStart` ne inietterebbe il task file. T220 — `binding.orchestrator`
 * c'è solo quando la richiesta dichiara l'orchestrator: `LOOM_ORCHESTRATOR` sta nella lista
 * delle variabili tolte, quindi una tab non la eredita mai dal deck che la apre.
 * `CLAUDE_CODE_GIT_BASH_PATH`
 * entra quando manca e il bash si trova: la tab eredita anche il `PATH`, e col
 * `PATH` di Git Bash `claude` eseguirebbe gli hook del plugin in PowerShell
 * (T174 verdetto 9), cioè senza la task in contesto.
 */
export function windowsTabEnv(
  env: Readonly<Record<string, string | undefined>>,
  binding: SessionBinding,
  gitBash: string | null,
): Record<string, string | undefined> {
  const out = bindSession(dropEnv(env, [...INHERITED_SESSION_ENV, 'LOOM_TASK', TAB_ARGV_ENV]), binding);
  if (gitBash && !hasKey(env, GIT_BASH_ENV)) out[GIT_BASH_ENV] = gitBash;
  return out;
}

/** L'argv di `claude` letto dalla variabile della tab, o `null` se manca o non
 *  è un array di stringhe. */
export function parseTabArgv(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((a) => typeof a === 'string') ? v : null;
  } catch {
    return null;
  }
}
