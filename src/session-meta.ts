// T162 — i campi DERIVATI del sidecar: cosa scrivere in `title`/`model` e
// quando scriverlo.
//
// Esiste perché compass ha bisogno del titolo di una conversazione e non può
// leggerne il transcript: l'estensione gira dentro il processo di gnome-shell,
// e una lettura sincrona di qualche megabyte blocca il compositore. Il dato
// deve quindi arrivargli da un file piccolo che già apre — il sidecar — messo
// lì da chi ce l'ha in mano, cioè il deck, che a ogni tick materializza le
// `Session` complete di titolo e modello.
//
// Il giudizio è separato dalla scrittura: `sidecarGaps` decide e ritorna i
// record, `fillSidecarGaps` li scrive. La separazione è ciò che rende testabile
// la parte non ovvia — la convergenza: un derivato che non combacia mai col
// valore su disco produrrebbe un append a ogni tick del poll, per sempre, senza
// nessun errore a dirlo.
//
// Nessun import da ink/react: il chiamante è un hook, questo modulo no.

import { modelAlias } from './glyphs.js';
import { stripProjectCore, stripTaskId } from './session-list.js';
import { NO_TITLE, type Session } from './sessions.js';
import { NO_SPAWN } from './spawn.js';
import { appendSessionMeta } from './task-index.js';

/**
 * Cap del titolo scritto nel sidecar, in CODE POINT.
 *
 * È il `LABEL_MAX` del lettore (compass): oltre, Pango ellissizza comunque, e
 * il file non deve portare una stringa che nessuno mostrerà per intero. Misura
 * del preflight: col primo prompt come titolo il massimo osservato era 1.367
 * caratteri, 36 conversazioni su 604 sopra 120, p90 a 61 — il cap morde su una
 * minoranza e non tocca il caso normale.
 *
 * In code point e non in code unit perché il taglio va fatto senza spezzare una
 * coppia surrogata: un'emoji tagliata a metà lascia nel file un surrogato
 * spaiato, cioè un glifo rotto nel menu.
 */
export const SIDECAR_TITLE_MAX = 120;

function capTitle(s: string): string {
  const cps = [...s];
  return cps.length <= SIDECAR_TITLE_MAX ? s : cps.slice(0, SIDECAR_TITLE_MAX).join('');
}

/**
 * Il valore da scrivere in `title`: il RESIDUO del titolo, non il titolo
 * grezzo. `''` = non c'è niente da scrivere.
 *
 * I due casi non si trattano allo stesso modo, ed è il punto di questa
 * funzione:
 *
 *  - **con titolo custom** → il titolo di una conversazione nata dal deck È la
 *    label della tab (`🧵 loom-works · T32 revisione`), composta di tre pezzi
 *    che il lettore ha già altrove: il progetto (la riga sotto cui la
 *    conversazione compare), il task id (il campo `taskId` dello stesso
 *    record) e la nota (il campo `note`). Copiare il grezzo obbligherebbe
 *    compass a una seconda copia di `stripTaskId`, e a schermo ripeterebbe tre
 *    volte quello che già si legge.
 *  - **senza titolo custom** → `title` È il primo prompt, e vale intatto:
 *    quella è l'unica cosa che dice di cosa si parlava.
 *
 * Non è `sessionTitle`: quella, con residuo vuoto, cade sul primo prompt —
 * dentro il deck è giusto, perché una riga muta non serve a nessuno, ma qui il
 * primo prompt di una sessione nata dal deck è l'invocazione di una skill
 * (`/loom-works:recap-status-task T32`), che nel menu non aggiunge nulla. Qui
 * il residuo vuoto è ASSENZA: non si scrive, e chi legge cade sulla nota.
 */
export function sidecarTitle(
  s: Pick<Session, 'title' | 'customTitle'>,
  core: string | null,
  taskId: string | null,
): string {
  if (!s.customTitle) return s.title === NO_TITLE ? '' : capTitle(s.title);
  return capTitle(stripTaskId(stripProjectCore(s.title, core), taskId));
}

/** Un buco da riempire: i campi da appendere per QUELLA conversazione. Porta
 *  solo quelli che mancano o non corrispondono più. */
export interface SidecarGap {
  sessionId: string;
  title?: string;
  model?: string;
}

/**
 * I buchi da riempire in questo giro: per ogni conversazione PINNATA, i campi
 * derivati che nel sidecar mancano o non corrispondono più al valore corrente.
 *
 * Solo le pinnate, e non tutte le conversazioni del progetto, perché sono le
 * sole che un lettore esterno mostra: il resto sarebbe churn su un file
 * append-only, un record per conversazione per ogni deck che si apre.
 *
 * Tre cose che non producono un append, e nessuna delle tre è un errore:
 *  - una pinnata STALE (il transcript non c'è più) — nessuna `Session`, quindi
 *    nessun valore da cui derivare;
 *  - un titolo derivato VUOTO — è l'assenza di P1, e appenderlo scriverebbe la
 *    cancellazione di un campo che nessuno ha chiesto di cancellare;
 *  - un modello non riconducibile a un alias (`''` o fuori famiglia) — chi
 *    riprende cadrà sulla propria cascata, che è meglio di un alias inventato.
 *
 * La CONVERGENZA è l'invariante da tenere: il confronto avviene fra il valore
 * derivato e il valore letto dal sidecar senza riscritture in mezzo (nessuna
 * sanificazione in lettura, cap applicato da questo lato una volta sola),
 * quindi un buco riempito resta riempito e il giro successivo non trova niente
 * da fare.
 */
export interface SidecarGapInput {
  pinned: ReadonlyMap<string, number>;
  sessions: readonly Session[];
  bindings: ReadonlyMap<string, string>;
  titles: ReadonlyMap<string, string>;
  models: ReadonlyMap<string, string>;
  core: string | null;
}

export function sidecarGaps(input: SidecarGapInput): SidecarGap[] {
  const { pinned, sessions, bindings, titles, models, core } = input;
  if (pinned.size === 0) return [];
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  const out: SidecarGap[] = [];
  for (const sessionId of pinned.keys()) {
    const session = byId.get(sessionId);
    if (!session) continue; // pinnata stale: niente da cui derivare
    const gap: SidecarGap = { sessionId };

    const title = sidecarTitle(session, core, bindings.get(sessionId) ?? null);
    if (title && titles.get(sessionId) !== title) gap.title = title;

    const model = modelAlias(session.model);
    if (model && models.get(sessionId) !== model) gap.model = model;

    if (gap.title !== undefined || gap.model !== undefined) out.push(gap);
  }
  return out;
}

/**
 * Scrive i buchi di questo giro. Ritorna quanti record ha appeso — zero è
 * l'esito normale a regime, non un fallimento.
 *
 * `NO_SPAWN` frena anche questa scrittura, ed è lo stesso freno delle tab
 * Ptyxis per la stessa ragione: il gate su pseudo-terminale avvia il DECK VERO
 * con cwd la project root del cappello, quindi senza freno ogni run della suite
 * appende record nel sidecar reale di chi la lancia. Il valore scritto sarebbe
 * pure corretto — è quello che il deck scriverebbe comunque — ma è una
 * scrittura fuori dalla sandbox del test, che è precisamente ciò che il freno
 * esiste per impedire.
 *
 * Il freno sta QUI e non nel chiamante perché questa è l'unica sede della
 * scrittura: nel chiamante sarebbe una guardia che il prossimo scrittore non
 * vede.
 *
 * Un sidecar non scrivibile non è un errore da mostrare: il giro dopo riprova,
 * e nel frattempo il deck funziona identico — questi campi li legge un altro
 * processo, non lui.
 */
export function fillSidecarGaps(projectRoot: string, input: SidecarGapInput): number {
  if (NO_SPAWN) return 0;
  let scritti = 0;
  try {
    for (const gap of sidecarGaps(input)) {
      appendSessionMeta(projectRoot, gap.sessionId, gap);
      scritti++;
    }
  } catch {
    // sidecar non scrivibile: si riprova al giro dopo, niente a schermo — è
    // manutenzione di un campo di servizio, non un'azione che l'utente ha chiesto.
  }
  return scritti;
}
