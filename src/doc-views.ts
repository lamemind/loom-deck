// T160 — Catalogo delle viste del pane doc.
//
// Gemello di `inbox-views.ts` per forma e invarianti, MODULO SEPARATO per il
// tipo: le righe di questo pane sono `DocRow` e le sue azioni (`⏎` sul detail,
// spawn di `rebalance-doc` sul bersaglio) sono scritte per un file o una
// cartella della doc. Infilarle nel catalogo inbox obbligherebbe a un'unione
// discriminata e a rendere inerte ogni azione sulla riga sbagliata — la stessa
// ragione per cui T134 aveva tenuto separato il proprio.
//
// Modulo PURO: nessun import da ink/react, nessun I/O. La misura la fa
// `doc-metrics.sh`, la parsa `doc-tree.ts`, e qui c'è solo la mappa di quali
// sottoinsiemi esistono, come si chiamano e con che numero.
//
// Invarianti ereditate dai tre cataloghi già in esercizio:
//  - catalogo FISSO: le voci ci sono tutte anche a contatore 0, o navigando si
//    spostano sotto le dita;
//  - navigazione CICLICA con `tab`;
//  - il numero di una voce coincide col numero di RIGHE che la voce mostra.
//    Su un pane ad albero questo vincola anche la forma delle viste: `Tutti`
//    conta le cartelle insieme ai file, perché le mostra entrambe, e le viste
//    per flag sono PIATTE — elencano i soli elementi flaggati, senza le cartelle
//    antenate, perché ogni riga di struttura in più farebbe divergere il
//    contatore dalla lista.

import {
  buildDocTree,
  countFlagged,
  flatDocRows,
  type DocFlag,
  type DocRow,
  type DocScanData,
} from './doc-tree.js';

export type DocViewId = 'all' | 'split' | 'merge' | 'tldr' | 'regroup';

/**
 * I flag di ogni vista per flag.
 *
 * `tldr` ne somma TRE. Sono tre difetti diversi della stessa riga 3 — troppo
 * lunga, assente, con un'ancora che nel corpo non c'è — ma chiamano tutti e tre
 * lo stesso rimedio (`write-tldr` sul file), quindi separarli darebbe tre voci
 * di catalogo che si guardano insieme e si eseguono insieme. Le short di riga
 * restano distinte (`CAP`, `NOT`, `ORF`): quale dei tre sia lo dice la riga, non
 * la vista.
 */
const VIEW_FLAGS: Record<Exclude<DocViewId, 'all'>, readonly DocFlag[]> = {
  split: ['SPLIT'],
  merge: ['MERGE?'],
  tldr: ['TLDR>CAP', 'NOTLDR', 'TLDR-ORFANA'],
  regroup: ['REGROUP'],
};

export interface DocViewCounts {
  /** Righe dell'albero: cartelle e file insieme, che è ciò che `Tutti` mostra. */
  total: number;
  split: number;
  merge: number;
  tldr: number;
  regroup: number;
}

export interface DocViewEntry {
  id: DocViewId;
  label(counts: DocViewCounts): string;
  count(counts: DocViewCounts): number;
  /** Attenuazione della voce. È una FUNZIONE e non un flag, come nel catalogo
   *  inbox: `Tutti` non si grigia sul proprio contatore — l'albero ha righe
   *  finché la doc ha file — ma su quello che rende il pane utile, cioè se
   *  esiste almeno un flag su cui lanciare qualcosa. */
  dim(counts: DocViewCounts): boolean;
  rows(data: DocScanData): DocRow[];
  /** Nota mostrata quando la vista non ha righe: una lista vuota deve dire
   *  perché è vuota, o si legge come un pane rotto. */
  empty: string;
  color?: string;
}

/** Quanto lavoro di topologia e di ancore la misura ha trovato: la somma delle
 *  quattro viste per flag. È il numero su cui `Tutti` decide se grigiarsi —
 *  l'albero di una doc in equilibrio si guarda lo stesso, ma non chiede niente. */
export function flaggedTotal(c: DocViewCounts): number {
  return c.split + c.merge + c.tldr + c.regroup;
}

/** I contatori dell'header, da una fonte sola: gli stessi numeri che
 *  dimensionano le quattro viste per flag, quindi non possono dire cose diverse
 *  da quelle che le liste mostrano. */
export function docCounts(data: DocScanData): DocViewCounts {
  return {
    total: buildDocTree(data).length,
    split: countFlagged(data, VIEW_FLAGS.split),
    merge: countFlagged(data, VIEW_FLAGS.merge),
    tldr: countFlagged(data, VIEW_FLAGS.tldr),
    regroup: countFlagged(data, VIEW_FLAGS.regroup),
  };
}

const FLAG_VIEWS: DocViewEntry[] = [
  {
    id: 'split',
    label: (c) => `SPLIT (${c.split})`,
    count: (c) => c.split,
    dim: (c) => c.split === 0,
    rows: (data) => flatDocRows(data, VIEW_FLAGS.split),
    empty: 'nessun file sopra la soglia di split',
  },
  {
    id: 'merge',
    label: (c) => `MERGE? (${c.merge})`,
    count: (c) => c.merge,
    dim: (c) => c.merge === 0,
    rows: (data) => flatDocRows(data, VIEW_FLAGS.merge),
    empty: 'nessun file sotto il pavimento di merge',
  },
  {
    id: 'tldr',
    label: (c) => `TLDR (${c.tldr})`,
    count: (c) => c.tldr,
    dim: (c) => c.tldr === 0,
    rows: (data) => flatDocRows(data, VIEW_FLAGS.tldr),
    empty: 'nessuna riga 3 fuori posto',
  },
  {
    id: 'regroup',
    label: (c) => `REGROUP (${c.regroup})`,
    count: (c) => c.regroup,
    dim: (c) => c.regroup === 0,
    rows: (data) => flatDocRows(data, VIEW_FLAGS.regroup),
    empty: 'nessuna cartella oltre la soglia di regroup',
  },
];

export const DOC_VIEWS: readonly DocViewEntry[] = [
  {
    id: 'all',
    label: (c) => `Tutti (${c.total})`,
    count: (c) => c.total,
    dim: (c) => flaggedTotal(c) === 0,
    rows: (data) => buildDocTree(data),
    empty: 'nessun file sotto la docs-root',
  },
  ...FLAG_VIEWS,
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
