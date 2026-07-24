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

/** Session della riga selezionata; null se stale o nessuna selezione. */
export function selectedSession(rows: SessionRow[], sessionId: string | null): Session | null {
  const r = rows.find((row) => isSelectable(row) && row.sessionId === sessionId);
  return r && isSelectable(r) ? r.session : null;
}
