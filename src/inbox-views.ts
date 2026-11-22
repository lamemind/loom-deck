// T134 — Catalogo delle viste del pane inbox.
//
// Gemello di `pane-views.ts` per forma e invarianti, MODULO SEPARATO per il
// tipo: `SessionViewEntry.rows()` è tipizzata su `SessionRow[]` e ogni azione
// del pane destro (`p` pin, `N` nota, `A` riassegna, resume, fork) è scritta
// per una conversazione. Infilare una vista inbox in quel catalogo
// obbligherebbe a un'unione discriminata e a rendere inerte ogni azione sulla
// riga sbagliata (D6); con due cataloghi i tipi restano disgiunti per
// costruzione.
//
// Modulo PURO: nessun import da ink/react, nessun I/O. Il calcolo dei conteggi
// resta in `inbox.ts`, qui c'è solo la mappa di quali sottoinsiemi esistono,
// come si chiamano e con che numero.
//
// Invarianti ereditate dal catalogo dei due pane storici:
//  - catalogo FISSO: le voci ci sono tutte anche a contatore 0, o navigando si
//    spostano sotto le dita;
//  - navigazione CICLICA con `tab`;
//  - il numero di una voce coincide col numero di righe che la voce mostra —
//    un header che dice un numero e una lista che ne mostra un altro è un
//    contatore che mente, e non c'è schermata che lo dica.

import { NATURE, countByNatura, isReleased, type InboxFile, type Natura } from './inbox.js';

export type InboxViewId = 'all' | Natura;

export interface InboxViewCounts {
  /** Ogni file in inbox, malformati, branched e in lavorazione compresi: è
   *  l'insieme che la vista `Tutti` elenca (D5 — il contatore conta i rilasci
   *  chiusi, la lista mostra tutto). */
  total: number;
  /** I tre contatori del bottone di pane: solo drainable non-branched. */
  nozioni: number;
  derivazione: number;
  sweep: number;
}

interface Styling {
  color?: string;
}

export interface InboxViewEntry extends Styling {
  id: InboxViewId;
  label(counts: InboxViewCounts): string;
  count(counts: InboxViewCounts): number;
  /** Attenuazione della voce. È una FUNZIONE e non un flag come nei due
   *  cataloghi storici perché la voce `Tutti` non si grigia sul proprio
   *  contatore (D7): la lista può essere piena di file in lavorazione o
   *  congelati su un branch, e a somma delle tre nature zero non c'è nessun
   *  rilascio chiuso, anche con dieci righe a schermo. */
  dim(counts: InboxViewCounts): boolean;
  rows(files: readonly InboxFile[]): InboxFile[];
  /** Nota mostrata quando la vista non ha righe: una lista vuota deve dire
   *  perché è vuota, o si legge come un pane rotto. */
  empty: string;
}

/** La somma dei tre contatori: quanti file descrivono un rilascio chiuso. */
export function releasedTotal(c: InboxViewCounts): number {
  return c.nozioni + c.derivazione + c.sweep;
}

/** I contatori dell'header E del bottone di pane, da una fonte sola: i tre
 *  numeri che il bottone mostra sono gli stessi che dimensionano le tre viste
 *  di natura, quindi non possono dire cose diverse. */
export function inboxCounts(files: readonly InboxFile[]): InboxViewCounts {
  return { total: files.length, ...countByNatura(files) };
}

const NATURA_VIEWS: InboxViewEntry[] = NATURE.map((natura) => ({
  id: natura,
  label: (c) => `${natura} (${c[natura]})`,
  count: (c) => c[natura],
  dim: (c) => c[natura] === 0,
  rows: (files) => files.filter((f) => isReleased(f) && f.natura === natura),
  empty: `nessun file ${natura} a rilascio chiuso`,
}));

export const INBOX_VIEWS: readonly InboxViewEntry[] = [
  {
    id: 'all',
    label: (c) => `Tutti (${c.total})`,
    count: (c) => c.total,
    dim: (c) => releasedTotal(c) === 0,
    // Nessun filtro: `parseInboxTsv` consegna già l'ordine per età decrescente
    // (D8 — i più vecchi in cima).
    rows: (files) => [...files],
    empty: 'inbox vuota: nessun file in inbox/',
  },
  ...NATURA_VIEWS,
];

export function inboxView(id: InboxViewId): InboxViewEntry {
  return INBOX_VIEWS.find((v) => v.id === id) ?? INBOX_VIEWS[0]!;
}

export function selectInboxRows(id: InboxViewId, files: readonly InboxFile[]): InboxFile[] {
  return inboxView(id).rows(files);
}

/** Scorrimento ciclico, come i due cataloghi storici: `→` sull'ultima voce
 *  torna alla prima. Id ignoto → prima voce, mai un indice negativo. */
export function cycleInboxView(current: InboxViewId, delta: number): InboxViewId {
  const at = INBOX_VIEWS.findIndex((v) => v.id === current);
  if (at < 0) return INBOX_VIEWS[0]!.id;
  return INBOX_VIEWS[(at + delta + INBOX_VIEWS.length) % INBOX_VIEWS.length]!.id;
}
