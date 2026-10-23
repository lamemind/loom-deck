// T175 — COSA il deck sa fare sulla piattaforma su cui gira.
//
// Un modulo solo e non un `process.platform` sparso nei file: la domanda «questa
// funzione c'è qui?» ha una risposta sola, e la mappa di cosa è spento e perché
// si legge in un posto invece che cercando dieci `if`. Le figlie di porting
// dell'epica T173 riaccendono una funzione TOGLIENDO UNA VOCE da `UNAVAILABLE`:
// i tasti, i pane e gli scan leggono la mappa, non la piattaforma.
//
// Modulo PURO: nessun React, nessun I/O. L'unico ingresso esterno è la
// piattaforma stessa, letta a ogni chiamata (`platform()`), così un test può
// cambiarla fra un caso e l'altro senza re-importare il modulo.

/** Le funzioni che una piattaforma può non avere. Una voce = un'area del deck
 *  che dipende da uno strumento che su quella piattaforma manca. */
export type Feature =
  /** Tab e conversazioni: `deck-run` (bash) + `ptyxis`, il terminale `t`. */
  | 'spawn'
  /** Liveness delle conversazioni: `/proc/<pid>/stat`. Ne dipende anche la
   *  guardia di `CANC` sulle conversazioni, che non deve eliminare il transcript
   *  di una conversazione aperta. */
  | 'liveSessions'
  /** Gli script `.sh` del plugin: pane doc, coda inbox, gitlink. */
  | 'pluginScripts'
  /** Lo scan hard-wrap: `md-wrap.py` via `python3`. */
  | 'hardWrap'
  /** Le voci `launch[]` del file di progetto: comandi Linux via `bash -lic`. */
  | 'launch'
  /** La notifica di fine project status: `notify-send`. */
  | 'notify';

/**
 * LA MAPPA: per piattaforma, le funzioni spente. Una piattaforma assente le ha
 * tutte — è il comportamento di prima di T175 su Linux e su macOS.
 *
 * Il commento accanto a ogni voce nomina la figlia di T173 che la riaccende.
 */
export const UNAVAILABLE: Partial<Record<NodeJS.Platform, readonly Feature[]>> = {
  win32: [
    'spawn', // T176 — tab di Windows Terminal al posto di ptyxis
    'liveSessions', // T177 — liveness senza /proc
    'pluginScripts', // T178 — .sh del plugin via Git Bash
    'hardWrap', // T178 — python del wrap-scan
    'launch', // T179 — comando per piattaforma nelle voci launch[]
    'notify', // T180 — toast al posto di notify-send
  ],
};

/** Come una funzione si nomina in un avviso, quando il chiamante non ne dà un
 *  nome più preciso (il tasto che l'ha chiesta, per esempio). */
const FEATURE_LABEL: Record<Feature, string> = {
  spawn: 'apertura di tab e conversazioni',
  liveSessions: 'sessioni vive',
  pluginScripts: 'script del plugin',
  hardWrap: 'scan hard-wrap',
  launch: 'voci launch',
  notify: 'notifiche',
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

/** La funzione c'è su questa piattaforma. */
export function isAvailable(feature: Feature, p: NodeJS.Platform = platform()): boolean {
  return !(UNAVAILABLE[p] ?? []).includes(feature);
}

/** Il testo di una funzione spenta, per un pane o una vista: nomina la funzione
 *  e la piattaforma. `n/d` e non «non disponibile»: resta invariato davanti a un
 *  nome singolare o plurale. */
export function offText(feature: Feature, what?: string, p: NodeJS.Platform = platform()): string {
  return `${what ?? FEATURE_LABEL[feature]} ${OFF_MARK} su ${platformName(p)}`;
}

/** La riga di stato di un tasto spento: il tasto, la funzione, la piattaforma. */
export function offNote(
  key: string,
  feature: Feature,
  what?: string,
  p: NodeJS.Platform = platform(),
): string {
  return `⚠ ${key} → ${offText(feature, what, p)}`;
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
