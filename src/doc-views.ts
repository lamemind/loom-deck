// T160 — Catalogo delle viste del pane doc.
//
// Gemello di `inbox-views.ts` per forma e invarianti, MODULO SEPARATO per il
// tipo: le righe di questo pane sono `DocRow`, file e cartelle della doc.
// Infilarle nel catalogo inbox obbligherebbe a un'unione discriminata e a
// rendere inerte ogni azione sulla riga sbagliata — la stessa ragione per cui
// T134 aveva tenuto separato il proprio.
//
// Una vista sola, `Tutti`: l'albero intero. `doc-metrics.sh` emette tre flag
// soli, tutti descrittivi (`ONLINE`, `INBOX`, `GEN` — `doc-tree.ts`), e nessuno
// di loro chiede un'operazione: una vista per flag sarebbe un filtro su un
// fatto che la colonna di riga dice già. Il catalogo resta un catalogo — header,
// hit-test e cicli di `tab` lo leggono come gli altri tre — e una vista nuova ci
// entra senza toccare chi lo consuma.
//
// Modulo PURO: nessun import da ink/react, nessun I/O. La misura la fa
// `doc-metrics.sh`, la parsa `doc-tree.ts`, e qui c'è solo la mappa di quali
// sottoinsiemi esistono, come si chiamano e con che numero.
//
// Invariante ereditata dai tre cataloghi già in esercizio: il numero di una
// voce coincide col numero di RIGHE che la voce mostra. `Tutti` conta le
// cartelle insieme ai file, perché le mostra entrambe.

import { buildDocTree, type DocRow, type DocScanData } from './doc-tree.js';

export type DocViewId = 'all';

export interface DocViewCounts {
  /** Righe dell'albero: cartelle e file insieme, che è ciò che `Tutti` mostra. */
  total: number;
}

export interface DocViewEntry {
  id: DocViewId;
  label(counts: DocViewCounts): string;
  count(counts: DocViewCounts): number;
  /** Attenuazione della voce: una FUNZIONE come nel catalogo inbox, perché la
   *  firma è condivisa dall'header (`pane-header.ts`). */
  dim(counts: DocViewCounts): boolean;
  rows(data: DocScanData): DocRow[];
  /** Nota mostrata quando la vista non ha righe: una lista vuota deve dire
   *  perché è vuota, o si legge come un pane rotto. */
  empty: string;
  color?: string;
}

/** I contatori dell'header, dalla stessa fonte da cui esce la lista. */
export function docCounts(data: DocScanData): DocViewCounts {
  return { total: buildDocTree(data).length };
}

export const DOC_VIEWS: readonly DocViewEntry[] = [
  {
    id: 'all',
    label: (c) => `Tutti (${c.total})`,
    count: (c) => c.total,
    dim: (c) => c.total === 0,
    rows: (data) => buildDocTree(data),
    empty: 'nessun file sotto la docs-root',
  },
];

export function docView(id: DocViewId): DocViewEntry {
  return DOC_VIEWS.find((v) => v.id === id) ?? DOC_VIEWS[0]!;
}

export function selectDocRows(id: DocViewId, data: DocScanData): DocRow[] {
  return docView(id).rows(data);
}

/** Scorrimento ciclico, come gli altri tre cataloghi: `→` sull'ultima voce torna
 *  alla prima. Id ignoto → prima voce, mai un indice negativo. */
export function cycleDocView(current: DocViewId, delta: number): DocViewId {
  const at = DOC_VIEWS.findIndex((v) => v.id === current);
  if (at < 0) return DOC_VIEWS[0]!.id;
  return DOC_VIEWS[(at + delta + DOC_VIEWS.length) % DOC_VIEWS.length]!.id;
}
