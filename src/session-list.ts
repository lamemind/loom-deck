// T50 — Assemblaggio della lista sessioni a DUE gruppi: pinnate (sempre in
// lista, in cima) + separatore + contestuali (figlie del parent selezionato).
// Modulo PURO: nessun import da ink/react, nessun I/O → testabile senza terminale
// (il pacchetto non ha infrastruttura TUI di test, solo unit sui core puri).
//
// Invarianti (decisioni congelate al preflight):
//  - D2: dentro il blocco pinnate l'ordine è di PIN stabile (ultima pinnata in
//    cima), dato dal rango del sidecar `session-tasks.jsonl` — non `ts desc`.
//  - Dedup: una sessione sia pinnata sia contestuale compare SOLO fra le pinnate.
//  - Cap: `maxContext` limita SOLO le contestuali; le pinnate sono esenti. Il
//    conteggio delle troncate (`contextHidden`) resta esposto (non-silenzioso).
//  - D3: una pinnata il cui transcript non esiste più è una riga STALE (session
//    null), navigabile e spinnabile — non sparisce in silenzio.
//  - Trap T39: la selezione è KEYED SU sessionId, non su indice posizionale. La
//    lista è una vista trasformata (due gruppi + separatore): un indice grezzo
//    identificherebbe la riga sbagliata dopo un pin/cambio-contesto.

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
  | { kind: 'pinned'; sessionId: string; session: Session | null; stale: boolean }
  | { kind: 'context'; sessionId: string; session: Session }
  | { kind: 'separator' };

/** Riga selezionabile: pinnata (anche stale) o contestuale — mai il separatore. */
type SelectableRow = Extract<SessionRow, { sessionId: string }>;

export interface AssembledList {
  /** Lista appiattita: pinnate, [separatore], contestuali. Il separatore è una
   *  riga a sé così il budget d'altezza lo conta come le altre. */
  rows: SessionRow[];
  pinnedCount: number;
  /** Contestuali deduplicate, PRIMA del cap. */
  contextTotal: number;
  /** Contestuali troncate dal cap (contatore non-silenzioso). */
  contextHidden: number;
}

export function assembleSessionList(
  childSessions: Session[],
  allSessions: Session[],
  pinned: Map<string, number>,
  maxContext: number,
): AssembledList {
  // Le pinnate si risolvono contro TUTTE le sessioni del progetto, non solo le
  // figlie del parent: una pinnata può appartenere a un'altra task. Assente
  // dallo store → stale.
  const byId = new Map(allSessions.map((s) => [s.sessionId, s]));
  const pinnedIds = [...pinned.entries()]
    .sort((a, b) => b[1] - a[1]) // rango desc → ultima pinnata in cima (D2)
    .map(([id]) => id);
  const pinnedRows: SessionRow[] = pinnedIds.map((id) => {
    const session = byId.get(id) ?? null;
    return { kind: 'pinned', sessionId: id, session, stale: session === null };
  });

  const pinnedSet = new Set(pinnedIds);
  const dedupedContext = childSessions.filter((s) => !pinnedSet.has(s.sessionId));
  const shownContext = dedupedContext.slice(0, Math.max(0, maxContext));
  const contextRows: SessionRow[] = shownContext.map((s) => ({
    kind: 'context',
    sessionId: s.sessionId,
    session: s,
  }));

  const rows: SessionRow[] = [...pinnedRows];
  // Separatore SOLO fra due gruppi entrambi non vuoti: senza pinnate o senza
  // contestuali non c'è confine da segnare.
  if (pinnedRows.length > 0 && contextRows.length > 0) rows.push({ kind: 'separator' });
  rows.push(...contextRows);

  return {
    rows,
    pinnedCount: pinnedRows.length,
    contextTotal: dedupedContext.length,
    contextHidden: dedupedContext.length - shownContext.length,
  };
}

function isSelectable(r: SessionRow): r is SelectableRow {
  return r.kind !== 'separator';
}

/** Primo id selezionabile (salta il separatore); null = lista senza righe. */
export function firstSelectableId(rows: SessionRow[]): string | null {
  return rows.find(isSelectable)?.sessionId ?? null;
}

/** Indice della riga con quel sessionId nell'ARRAY COMPLETO (per il windowing);
 *  -1 se assente o id null. Il separatore non ha id → mai matchato. */
export function rowIndexOf(rows: SessionRow[], sessionId: string | null): number {
  if (sessionId === null) return -1;
  return rows.findIndex((r) => isSelectable(r) && r.sessionId === sessionId);
}

/** Sposta la selezione di `delta` fra le sole righe selezionabili (attraversa il
 *  separatore senza fermarcisi). Id perso → prima riga; lista vuota → null. */
export function moveSelection(
  rows: SessionRow[],
  currentId: string | null,
  delta: number,
): string | null {
  const selectable = rows.filter(isSelectable);
  if (selectable.length === 0) return null;
  const cur = selectable.findIndex((r) => r.sessionId === currentId);
  if (cur < 0) return selectable[0].sessionId;
  const next = Math.max(0, Math.min(selectable.length - 1, cur + delta));
  return selectable[next].sessionId;
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
 */
export function neighborId(rows: SessionRow[], sessionId: string): string | null {
  const selectable = rows.filter(isSelectable);
  const at = selectable.findIndex((r) => r.sessionId === sessionId);
  if (at < 0) return null;
  return selectable[at + 1]?.sessionId ?? selectable[at - 1]?.sessionId ?? null;
}

/** Session della riga selezionata; null se stale o nessuna selezione. */
export function selectedSession(rows: SessionRow[], sessionId: string | null): Session | null {
  const r = rows.find((row) => isSelectable(row) && row.sessionId === sessionId);
  return r && isSelectable(r) ? r.session : null;
}
