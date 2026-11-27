// T175 — COSA il deck sa fare sulla piattaforma su cui gira.
//
// Un modulo solo e non un `process.platform` sparso nei file: la domanda «questa
// funzione c'è qui?» ha una risposta sola, e la mappa di cosa è spento e perché
// si legge in un posto invece che cercando dieci `if`. Le figlie di porting
// dell'epica T173 riaccendono una funzione TOGLIENDO UNA VOCE da `UNAVAILABLE`:
// i tasti, i pane e gli scan leggono la mappa, non la piattaforma.
//
// Modulo PURO: nessun React, nessun I/O proprio. Gli ingressi esterni sono la
// piattaforma, letta a ogni chiamata (`platform()`), così un test può cambiarla
// fra un caso e l'altro senza re-importare il modulo, e gli strumenti di
// `REQUIRES` (T178), che arrivano come funzioni (`Tools`) e un test sostituisce.
import { gitBash } from './git-bash.js';

/** Le funzioni che una piattaforma può non avere. Una voce = un'area del deck
 *  che dipende da uno strumento che su quella piattaforma manca. */
export type Feature =
  /** Tab e conversazioni: `deck-run` e il terminale `t` — Ptyxis su Linux,
   *  Windows Terminal su Windows (T176). */
  | 'spawn'
  /** Liveness delle conversazioni: `/proc/<pid>/stat` su Linux, esistenza del
   *  pid e ora di avvio da `Get-Process` su Windows (T177,
   *  `windows-liveness.ts`). Ne dipendono anche la guardia di `CANC` sulle
   *  conversazioni, che non deve eliminare il transcript di una conversazione
   *  aperta, e il resume e il restore (T176), che senza liveness riaprirebbero
   *  una conversazione già aperta in un'altra tab. */
  | 'liveSessions'
  /** Gli script `.sh` del plugin: il gitlink. Su Windows col bash di Git (T178,
   *  `scriptCommand`), quindi solo dove quel bash si trova (`REQUIRES`). */
  | 'pluginScripts'
  /** Le voci `launch[]` del file di progetto: su Linux `command` in `bash -lic`,
   *  su Windows `windows` nel bash di Git (T179, `launch-platform.ts`), quindi
   *  solo dove quel bash si trova (`REQUIRES`). Una voce senza il comando della
   *  piattaforma è `n/d` da sola: la funzione resta accesa per le altre. */
  | 'launch'
  /** La notifica desktop di un esito (voce launch, spawn in coda): `notify-send` su Linux, un toast
   *  WinRT da Windows PowerShell su Windows (T180, `windows-notify.ts`). */
  | 'notify'
  /** T198 — il controllo della finestra prima di una tab chiesta da una
   *  conversazione: compass dice se la finestra in focus è del progetto
   *  (`window-check.ts`). Serve dove `--tab` nasce nella finestra attiva del
   *  terminale, cioè con Ptyxis. */
  | 'windowCheck';

/**
 * LA MAPPA: per piattaforma, le funzioni spente. Una piattaforma assente le ha
 * tutte — è il comportamento di prima di T175 su Linux e su macOS.
 *
 * Il commento accanto a ogni voce nomina la figlia di T173 che la riaccende.
 */
export const UNAVAILABLE: Partial<Record<NodeJS.Platform, readonly Feature[]>> = {
  win32: [
    // T199 — Windows Terminal apre una tab in una finestra per nome, e compass
    // lì non c'è: il controllo ha un'altra forma. Spento e non lasciato al ramo
    // «compass non raggiungibile», che metterebbe un avviso su ogni spawn.
    'windowCheck',
  ],
};

/** Gli strumenti della macchina che una funzione può richiedere, come funzioni:
 *  `platform.ts` non li cerca da sé, e un test li sostituisce. */
export interface Tools {
  /** Il bash di Git for Windows, o `null` (`git-bash.ts`). */
  gitBash: () => string | null;
}

export const TOOLS: Tools = { gitBash };

/** Uno strumento senza il quale una funzione resta spenta, e come si nomina la
 *  sua assenza nell'avviso. */
interface Requirement {
  found: (tools: Tools) => boolean;
  missing: string;
}

/**
 * T178 — la seconda condizione: per piattaforma, le funzioni accese che
 * dipendono da uno strumento che su quella macchina può mancare.
 *
 * Due mappe e non una, perché sono due fatti diversi. `UNAVAILABLE` dice cosa il
 * deck non sa ancora fare su una piattaforma, ed è uguale su ogni macchina;
 * `REQUIRES` dice cosa il deck sa fare solo dove lo strumento c'è. Su Windows il
 * gitlink lo sa fare col bash di Git: senza, l'indicatore dice `n/d` invece di
 * misurare a vuoto e accendere il glifo di allerta, e l'avviso di `^U` nomina la
 * causa, perché il rimedio è installare Git for Windows o impostare
 * `CLAUDE_CODE_GIT_BASH_PATH`.
 */
const REQUIRES: Partial<Record<NodeJS.Platform, Partial<Record<Feature, Requirement>>>> = {
  win32: {
    pluginScripts: { found: (t) => t.gitBash() !== null, missing: 'bash di Git non trovato' },
    launch: { found: (t) => t.gitBash() !== null, missing: 'bash di Git non trovato' },
  },
};

/** La causa per cui una funzione che la piattaforma sa fare resta spenta su
 *  questa macchina, o `null`. */
function missingTool(feature: Feature, p: NodeJS.Platform, tools: Tools): string | null {
  const req = REQUIRES[p]?.[feature];
  return req && !req.found(tools) ? req.missing : null;
}

/** Come una funzione si nomina in un avviso, quando il chiamante non ne dà un
 *  nome più preciso (il tasto che l'ha chiesta, per esempio). */
const FEATURE_LABEL: Record<Feature, string> = {
  spawn: 'apertura di tab e conversazioni',
  liveSessions: 'sessioni vive',
  pluginScripts: 'script del plugin',
  launch: 'voci launch',
  notify: 'notifiche',
  windowCheck: 'verifica della finestra del progetto',
};

const PLATFORM_NAME: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
};

/**
 * Il marcatore di una funzione spenta, al posto del valore: in un indicatore
 * della testata (`gitlink n/d`), in un'etichetta di vista (`● vive n/d`).
 *
 * Il marcatore SOSTITUISCE il valore e non lo nasconde: un indicatore assente è
 * già uno stato (il gitlink non disegnato vuol dire «repo senza `.gitmodules`»),
 * e un `0` direbbe «ho misurato e non c'è niente».
 */
export const OFF_MARK = 'n/d';

/**
 * La piattaforma delle FUNZIONI. `LOOM_DECK_PLATFORM` la sostituisce, ed esiste
 * per i test: rende verificabile su Linux il deck di Windows, avvisi compresi.
 *
 * Vale solo per la mappa delle funzioni. La semantica dei path (`project-path.ts`)
 * legge la piattaforma vera, perché descrive il filesystem e non una scelta.
 */
export function platform(): NodeJS.Platform {
  return (process.env.LOOM_DECK_PLATFORM as NodeJS.Platform | undefined) || process.platform;
}

export function platformName(p: NodeJS.Platform = platform()): string {
  return PLATFORM_NAME[p] ?? p;
}

/** La funzione c'è su questa piattaforma, e su questa macchina ci sono gli
 *  strumenti che richiede (`REQUIRES`). */
export function isAvailable(
  feature: Feature,
  p: NodeJS.Platform = platform(),
  tools: Tools = TOOLS,
): boolean {
  if ((UNAVAILABLE[p] ?? []).includes(feature)) return false;
  return missingTool(feature, p, tools) === null;
}

/** Il testo di una funzione spenta, per un pane o una vista: nomina la funzione
 *  e la piattaforma, e lo strumento mancante quando è lui a spegnerla. `n/d` e
 *  non «non disponibile»: resta invariato davanti a un nome singolare o
 *  plurale. */
export function offText(
  feature: Feature,
  what?: string,
  p: NodeJS.Platform = platform(),
  tools: Tools = TOOLS,
): string {
  const base = `${what ?? FEATURE_LABEL[feature]} ${OFF_MARK} su ${platformName(p)}`;
  if ((UNAVAILABLE[p] ?? []).includes(feature)) return base;
  const cause = missingTool(feature, p, tools);
  return cause ? `${base}: ${cause}` : base;
}

/** La riga di stato di un tasto spento: il tasto, la funzione, la piattaforma. */
export function offNote(
  key: string,
  feature: Feature,
  what?: string,
  p: NodeJS.Platform = platform(),
  tools: Tools = TOOLS,
): string {
  return `⚠ ${key} → ${offText(feature, what, p, tools)}`;
}

/**
 * La GUARDIA di un tasto: `true` se la funzione è spenta, e in quel caso
 * l'avviso è già nella riga di stato. Il chiamante esce e basta:
 *
 *     if (refuse('spawn', '^K', setNote)) return;
 *
 * Un tasto spento che non facesse niente in silenzio sarebbe indistinguibile da
 * un binding mancante, e uno che arrivasse fino al processo esterno fallirebbe
 * con un messaggio che non nomina la piattaforma («ptyxis non lanciabile»).
 */
export function refuse(
  feature: Feature,
  key: string,
  setNote: (s: string) => void,
  what?: string,
): boolean {
  if (isAvailable(feature)) return false;
  setNote(offNote(key, feature, what));
  return true;
}
