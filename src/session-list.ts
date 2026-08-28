// T133 — Assemblaggio della lista sessioni: UNA lista sola, le figlie del parent
// selezionato in ordine `ts desc`. Il pin è un ATTRIBUTO della riga (glifo, vista
// dedicata), non una posizione privilegiata.
// Modulo PURO: nessun import da ink/react, nessun I/O → testabile senza terminale
// (il pacchetto non ha infrastruttura TUI di test, solo unit sui core puri).
//
// Invarianti (decisioni congelate al preflight T133):
//  - D1/D3: una forma sola di lista qualunque sia il parent, vista «tutte»
//    compresa. Nessun criterio speciale per le righe pinnate: nessun blocco in
//    cima, nessun ordine proprio, nessuna esenzione dal cap (D6).
//  - D4: una pinnata compare in lista se e solo se è figlia del parent
//    selezionato. Le pinnate fuori contesto vivono nella sola vista `📌`.
//  - D7: le righe pinnate escono in un CAMPO A PARTE (`pinnedRows`), non dentro
//    `rows`: il loro insieme è più largo della lista (tutte le sessioni del
//    progetto più le stale), quindi non è esprimibile come filtro di `rows`.
//  - D8: `pinnedRows` conserva l'ordine per RANGO di pin desc (ultima pinnata in
//    cima), dato dal sidecar `session-tasks.jsonl`. È l'unico lettore rimasto del
//    rango.
//  - D5: una pinnata il cui transcript non esiste più è una riga STALE, presente
//    nelle sole `pinnedRows` — navigabile e spinnabile dalla vista `📌`.
//  - Trap T39: la selezione è KEYED SU sessionId, non su indice posizionale. Le
//    righe a schermo sono quelle della vista attiva, e un indice grezzo
//    identificherebbe la riga sbagliata al primo cambio di vista o di parent.

import type { Session } from './sessions.js';
import { cut, termWidth } from './width.js';

// ── T53 · etichetta di riga ────────────────────────────────────────────────

/**
 * Toglie dal titolo il core del progetto (il suo `name`) e tutto ciò che lo
 * precede — emoji inclusa — più la punteggiatura di giunzione che resta appesa
 * davanti.
 *
 * Il titolo di una sessione È la label della tab Ptyxis (`🧵 loom-works · T52`):
 * dentro un deck che mostra un progetto solo, il core è una COLONNA COSTANTE
 * ripetuta su ogni riga. Toglierlo libera le colonne per ciò che distingue
 * davvero una conversazione dall'altra.
 *
 * `core` null (file config assente o senza identità) → titolo intatto: senza
 * sapere cosa togliere non si indovina, si lascia stare.
 */
export function stripProjectCore(title: string, core: string | null): string {
  let t = title;
  if (core) {
    const at = t.indexOf(core);
    if (at >= 0) t = t.slice(at + core.length);
  }
  return t.replace(/^[\s·]+/, '').trim();
}

/**
 * Toglie il token del task id dal titolo — quello e solo quello, confrontato
 * per token intero e non per substring (`T5` non deve mordere dentro `T59`).
 *
 * Va in coppia con `stripProjectCore`: un titolo di tab è `<emoji> <progetto> ·
 * <task>`, quindi tolto il progetto resta quasi sempre il solo task id.
 */
export function stripTaskId(title: string, taskId: string | null): string {
  if (!taskId) return title;
  return title
    .split(/\s+/)
    .filter((tok) => tok !== taskId)
    .join(' ')
    .replace(/^[\s·]+|[\s·]+$/g, '')
    .trim();
}

/**
 * Il testo che DISTINGUE una conversazione dalle altre — tolto tutto ciò che è
 * già scritto altrove nella stessa riga.
 *
 * Il titolo di una sessione è la label della tab Ptyxis quando esiste
 * (`🧵 loom-works · T59`), e il primo prompt dell'utente quando non esiste. I
 * due casi non vanno trattati allo stesso modo, ed è il punto di questa
 * funzione:
 *
 *  - **con titolo custom** → è composto di pezzi che la riga mostra già in
 *    colonna: il progetto (costante su ogni riga di un deck per-progetto) e il
 *    task id (colonna sua). Tolti quelli non resta quasi mai nulla → si cade sul
 *    primo prompt, che è l'unica cosa lì dentro a dire di cosa si parlava.
 *  - **senza titolo custom** → `title` È già il primo prompt: intatto.
 *
 * `title` (non `customTitle`) è la fonte anche nel primo ramo: è la stessa
 * stringa già sanificata al confine dell'adapter, e usare il campo grezzo
 * rimetterebbe in circolo glifi che il frame non sa disegnare.
 */
export function sessionTitle(
  s: Pick<Session, 'title' | 'customTitle' | 'firstPrompt'>,
  core: string | null,
  taskId: string | null,
): string {
  if (!s.customTitle) return s.title;
  const rest = stripTaskId(stripProjectCore(s.title, core), taskId);
  return rest || s.firstPrompt || '';
}

/** T53 — le due parti dell'etichetta di riga, già troncate a budget. */
export interface RowLabel {
  /** Nota umana, senza caporali (li mette il render). '' = nessuna nota. */
  note: string;
  /** Ciò che segue la nota: titolo intatto senza nota, residuo dello strip con
   *  nota. '' = niente da mostrare dopo la nota (caso legittimo). */
  rest: string;
}

/** Colonne minime perché un residuo dopo la nota valga la riga: sotto questa
 *  soglia si vedrebbero due lettere e un'ellissi, cioè rumore. */
const MIN_REST = 6;
/** Colonne garantite alla nota quando c'è anche un residuo da mostrare: la nota
 *  è la parte scelta da un umano, non è lei a cedere il posto per prima. */
const MIN_NOTE = 14;

/**
 * Come dividere `budget` colonne fra la nota umana e il testo della
 * conversazione, quando ci sono entrambi.
 *
 * `text` arriva GIÀ ripulito da `sessionTitle`: qui non si decide più *cosa*
 * mostrare, solo *quanto*. Prima lo strip del prefisso di progetto avveniva
 * dentro questa funzione e solo sul ramo con nota — asimmetria nata quando il
 * task id non aveva una colonna sua e togliere il core avrebbe lasciato il
 * nulla. Con la riga incolonnata quella premessa è caduta, e tenere due regimi
 * diversi avrebbe reso la colonna titolo larga in un caso e stretta nell'altro.
 *
 * Il budget dà la precedenza alla nota, ma senza affamare il resto: con
 * entrambi presenti la nota cede fino a `MIN_NOTE`, e il resto sparisce del
 * tutto sotto `MIN_REST` invece di ridursi a un moncone.
 */
export function rowLabel(text: string, note: string | undefined, budget: number): RowLabel {
  if (!note) return { note: '', rest: cut(text, Math.max(0, budget)) };

  // 2 colonne per i caporali « », 1 per lo spazio prima del residuo.
  const rest = text;
  const noteBudget = Math.max(0, budget - 2);
  if (!rest) return { note: cut(note, noteBudget), rest: '' };

  // Il `min` col budget totale non è ridondante: su un pane strettissimo
  // `MIN_NOTE` supererebbe le colonne disponibili e la riga andrebbe a capo —
  // che è precisamente il difetto che ogni larghezza qui dentro esiste per
  // evitare (una riga wrappata sfonda il budget d'ALTEZZA, non solo l'estetica).
  const shownNote = cut(note, Math.min(noteBudget, Math.max(MIN_NOTE, noteBudget - MIN_REST - 1)));
  // `termWidth`, non `.length`: quanto RESTA si misura in colonne come tutto il
  // resto: una nota con un emoji conta 2 sullo schermo e 1 (o 2) code unit, e
  // sottrarre le une dalle altre rimetterebbe la riga fuori dal pane.
  const restBudget = noteBudget - termWidth(shownNote) - 1;
  return { note: shownNote, rest: restBudget >= MIN_REST ? cut(rest, restBudget) : '' };
}

export type SessionRow =
  /** Conversazione col suo transcript. `pinned` è un attributo della riga: dice
   *  che è pinnata senza spostarla, e serve al render per il marker. */
  | { kind: 'session'; sessionId: string; session: Session; pinned: boolean }
  /** Pinnata orfana: il transcript non esiste più. Nessuna `Session` da mostrare,
   *  quindi nessuna colonna — compare nella sola vista `📌`, l'unico posto da cui
   *  spinnarla. */
  | { kind: 'stale'; sessionId: string };

export interface AssembledList {
  /** La lista: figlie del parent selezionato, `ts desc`, cap applicato. Le
   *  pinnate che appartengono al parent ci stanno dentro come le altre. */
  rows: SessionRow[];
  /** D7 — tutte le pinnate del progetto, ordine rango desc, stale comprese. Fuori
   *  da `rows` perché il loro insieme è più largo della lista: la vista `📌` legge
   *  questo campo invece di filtrare le righe. */
  pinnedRows: SessionRow[];
  /** Figlie del parent, PRIMA del cap. */
  contextTotal: number;
  /** T100 — le troncate dal cap, come righe e non come solo numero: il contatore
   *  `+N più vecchie` è diventato una vista, e una vista ha bisogno delle righe.
   *  D6 — nessuna esenzione: anche una pinnata vecchia cade qui dentro. */
  overflowRows: SessionRow[];
}

export function assembleSessionList(
  childSessions: Session[],
  allSessions: Session[],
  pinned: Map<string, number>,
  maxContext: number,
): AssembledList {
  const cap = Math.max(0, maxContext);
  const toRow = (s: Session): SessionRow => ({
    kind: 'session',
    sessionId: s.sessionId,
    session: s,
    pinned: pinned.has(s.sessionId),
  });
  const rows = childSessions.slice(0, cap).map(toRow);
  const overflowRows = childSessions.slice(cap).map(toRow);

  // Le pinnate si risolvono contro TUTTE le sessioni del progetto, non solo le
  // figlie del parent: una pinnata può appartenere a un'altra task, e la vista
  // dedicata è l'unico posto dove resta raggiungibile. Assente dallo store →
  // stale.
  const byId = new Map(allSessions.map((s) => [s.sessionId, s]));
  const pinnedRows: SessionRow[] = [...pinned.entries()]
    .sort((a, b) => b[1] - a[1]) // rango desc → ultima pinnata in cima (D8)
    .map(([id]) => {
      const session = byId.get(id);
      return session
        ? ({ kind: 'session', sessionId: id, session, pinned: true } as const)
        : ({ kind: 'stale', sessionId: id } as const);
    });

  return { rows, pinnedRows, contextTotal: childSessions.length, overflowRows };
}

/** Primo id della lista; null = lista senza righe. */
export function firstSelectableId(rows: SessionRow[]): string | null {
  return rows[0]?.sessionId ?? null;
}

/** Indice della riga con quel sessionId nell'ARRAY COMPLETO (per il windowing);
 *  -1 se assente o id null. */
export function rowIndexOf(rows: SessionRow[], sessionId: string | null): number {
  if (sessionId === null) return -1;
  return rows.findIndex((r) => r.sessionId === sessionId);
}

/** Sposta la selezione di `delta`. Id perso → prima riga; lista vuota → null. */
export function moveSelection(
  rows: SessionRow[],
  currentId: string | null,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const cur = rows.findIndex((r) => r.sessionId === currentId);
  if (cur < 0) return rows[0].sessionId;
  const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
  return rows[next].sessionId;
}

/**
 * T57 — id su cui atterrare quando la riga `sessionId` sta per USCIRE dalla
 * lista (riassegnata a un'altra task): la SUCCESSIVA, o la precedente se era
 * l'ultima, null se era l'unica.
 *
 * Serve perché il fallback di `moveSelection` (id perso → prima riga) qui
 * sarebbe sbagliato: smistare una spot dopo l'altra è il caso d'uso, e ogni
 * assegnazione rimanderebbe la selezione in cima. L'id va catturato PRIMA di
 * riscrivere il sidecar — dopo, la riga non c'è più e il vicino non è
 * calcolabile.
 *
 * T133 D12 — stesso servizio per l'unpin dentro la vista `📌`, dove spinnare fa
 * uscire la riga. Nella lista principale non serve: lì una pinnata è in lista
 * perché è figlia del parent, e spinnarla non la fa uscire.
 */
export function neighborId(rows: SessionRow[], sessionId: string): string | null {
  const at = rows.findIndex((r) => r.sessionId === sessionId);
  if (at < 0) return null;
  return rows[at + 1]?.sessionId ?? rows[at - 1]?.sessionId ?? null;
}

/** Session della riga selezionata; null se stale o nessuna selezione. */
export function selectedSession(rows: SessionRow[], sessionId: string | null): Session | null {
  const r = rows.find((row) => row.sessionId === sessionId);
  return r && r.kind === 'session' ? r.session : null;
}
