// T217 — le variabili di sessione che nessun `claude` lanciato dal deck eredita:
// una lista sola per i quattro punti che ne lanciano uno con l'env del deck.
//
//  - le tab di Windows Terminal (`windowsTabEnv`): la tab eredita l'env del
//    processo che lancia `wt.exe`;
//  - le tab Ptyxis su Linux (`ptyxisEnv`, T228): la tab eredita l'env del
//    processo `ptyxis` solo quando nessuna istanza è aperta e lui lo diventa;
//  - i turni `claude -p` di `loom-deck-headless` (`headlessEnv`), che di norma
//    lancia una regia, cioè una conversazione;
//  - il `claude -p` delle skill che il deck lancia da sé (`spawnSkill`):
//    creazione di una task, pulizia delle task.
//
// Fino a T217 le liste erano due, una per le tab e una per i turni headless, e
// divergevano: quella delle tab non toglieva `CLAUDE_AFK_TIMEOUT_MS` né
// `CLAUDE_CODE_BRIDGE_SESSION_ID`, e `spawnSkill` non toglieva niente.
//
// Modulo PURO: l'env arriva come valore e torna come copia.

/**
 * T220 — le variabili che LEGANO una conversazione aperta dal deck: la task
 * (`LOOM_TASK`) e la regia che l'ha chiesta (`LOOM_REGIA`). Le scrivono dopo il
 * filtro i due punti che compongono l'env di un `claude` invece di passarlo in
 * una riga di comando: le tab di Windows Terminal (`windowsTabEnv`) e i turni
 * headless (`headlessEnv`). `null` = nessuna, e la variabile manca.
 */
export interface SessionBinding {
  task: string | null;
  regia?: string | null;
}

/** `out` con le variabili del binding scritte sopra: dopo il filtro, così una
 *  variabile ereditata non sopravvive a un binding che la toglie. */
export function bindSession(
  out: Record<string, string | undefined>,
  binding: SessionBinding,
): Record<string, string | undefined> {
  if (binding.task) out.LOOM_TASK = binding.task;
  if (binding.regia) out.LOOM_REGIA = binding.regia;
  return out;
}

/**
 * Le variabili con cui un processo lanciato da una conversazione Claude Code
 * descrive QUELLA conversazione: id, pid, effort, entrypoint, canale dei
 * messaggi, Remote Control, inspector.
 *
 * Un `claude` che le eredita si crede parte della conversazione che lo ha
 * lanciato:
 *  - con `CLAUDE_CODE_CHILD_SESSION` un `claude` interattivo, quello di una tab,
 *    non salva il transcript («Transcript saving is off — inherited
 *    CLAUDE_CODE_CHILD_SESSION marker») e non compare nello storico del deck; un
 *    `claude -p` che la eredita il transcript lo salva comunque;
 *  - con `CLAUDE_EFFORT` gira con l'effort di chi lancia, e vede il suo canale
 *    dei messaggi e il suo Remote Control; un `claude -p` che eredita
 *    `CLAUDE_EFFORT=low` chiede invece all'API l'`effortLevel` dei settings dell'utente;
 *  - con `BUN_INSPECT` (su Windows `ws://127.0.0.1:9222/`) prova ad aprire
 *    l'inspector di Bun sulla porta già tenuta da chi lancia, e muore con
 *    `EADDRINUSE` prima di scrivere il transcript.
 *
 * `BUN_INSPECT` e `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` sono lette solo
 * nell'env di una sessione su Windows: su Linux mancano, e un guasto che
 * dipende da loro non si riproduce da lì.
 *
 * Elenco chiuso e per nome, non un prefisso: `CLAUDE_CONFIG_DIR` e
 * `CLAUDE_CODE_GIT_BASH_PATH` sono configurazione dell'utente e devono passare,
 * e sparirebbero senza segnale. Restano fuori anche le variabili che una
 * sessione aggiunge per gli strumenti che lancia senza descrivere nessuna
 * conversazione (`AI_AGENT`, `GIT_EDITOR`, `COREPACK_ENABLE_AUTO_PIN`): l'effetto
 * di ereditarle su un `claude` figlio non è misurato.
 *
 * La lista ha una copia nel plugin: `SESSION_ENV_DROP` in
 * `loom-works-plugin/scripts/task/triage-altrove.sh`, che porta questi nomi più
 * `PTYXIS_PROFILE`, `LOOM_TASK` e `PROJECT_ROOT` — cioè `HEADLESS_DROP_ENV` di
 * `headless.ts` — e li toglie al `claude -p` che esegue un'uscita di triage in un
 * altro progetto. Il plugin non importa un modulo del deck: le due liste le
 * confronta il banco del cappello, `plugin-tests/triage/run.sh`, e un nome
 * aggiunto qui va aggiunto anche lì.
 */
export const INHERITED_SESSION_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_AFK_TIMEOUT_MS',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP',
  'BUN_INSPECT',
  // T220 — la regia che ha aperto la conversazione che lancia. Un figlio che la
  // ereditasse si vedrebbe negare `AskUserQuestion` e leggerebbe una riga
  // dell'organigramma che non lo riguarda: `LOOM_REGIA` la mette solo il deck,
  // a uno spawn chiesto da una regia (`--regia`), e mai per eredità.
  'LOOM_REGIA',
];

/**
 * Una copia di `env` senza le variabili `names`, ignorando le maiuscole.
 *
 * Su Windows l'env non distingue le maiuscole, e una copia di `process.env` può
 * portare `Claude_Pid` invece di `CLAUDE_PID`: un confronto esatto la
 * lascerebbe passare.
 */
export function dropEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string | undefined> {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v;
  return out;
}
