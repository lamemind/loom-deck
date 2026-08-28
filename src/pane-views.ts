// T100 — Catalogo delle viste dei due pane. L'header smette di essere una riga
// di contatori e diventa un SELETTORE: ogni segmento che nomina un sottoinsieme
// calcolabile (`nascoste`, `archiviabili`, `vive`, `📌`, `+più vecchie`) è una
// vista raggiungibile con `tab`.
//
// Modulo PURO: nessun import da ink/react, nessun I/O. Il calcolo resta dove
// stava — `view.ts` per i filtri task, `session-list.ts` per l'assemblaggio
// della lista — qui c'è solo la mappa di quali sottoinsiemi esistono, come si
// chiamano e con che numero.
//
// Invarianti (decisioni congelate al create-task e al preflight):
//  - D1 create — catalogo FISSO: le voci ci sono tutte anche a contatore 0. Un
//    catalogo che si accorcia quando un numero va a zero sposta le voci sotto le
//    dita e può far svanire la vista corrente mentre la guardi (togliere un
//    filtro mentre sei su `nascoste`).
//  - D1 preflight — navigazione CICLICA, come `DETAIL_ACTIONS` e le righe di
//    scelta del modale edit.
//  - Il numero di una voce si misura SEMPRE sulla vista di default, mai su
//    quella attiva: altrimenti navigare cambierebbe i contatori che si sta
//    navigando, e il catalogo tornerebbe dinamico per la via di dietro.
//  - `↑N`/`↓N` non stanno qui: contano elementi fuori finestra per altezza del
//    terminale, cioè una POSIZIONE, non un insieme.

import type { Task } from './tasks.js';
import type { AssembledList, SessionRow } from './session-list.js';
import { isVisible, compareTasks, type ViewState } from './view.js';

export type TaskViewId = 'tasks' | 'hidden' | 'archivable';
export type SessionViewId = 'context' | 'live' | 'pinned' | 'older';

/** Resa del segmento nell'header. `dim` = informativo per natura (T61), distinto
 *  dal dim che ogni voce prende a contatore 0. */
interface Styling {
  color?: string;
  dim?: boolean;
}

// ── pane task ──────────────────────────────────────────────────────────────

export interface TaskViewCounts {
  /** Task superstiti ai filtri `F`. */
  filtered: number;
  /** Task in `tasks.md`, filtri esclusi. */
  total: number;
  /** Complemento dei filtri. */
  hidden: number;
  /** Done oltre `archivableDays`, cieche ai filtri. */
  archivable: number;
}

export interface TaskViewCtx {
  view: ViewState;
  archivable: ReadonlySet<string>;
}

export interface TaskViewEntry extends Styling {
  id: TaskViewId;
  label(counts: TaskViewCounts): string;
  count(counts: TaskViewCounts): number;
  /** Predicato di appartenenza alla vista. */
  has(task: Task, ctx: TaskViewCtx): boolean;
  /** Nota mostrata quando la vista non ha righe: una lista vuota deve dire
   *  perché è vuota, o si legge come un pane rotto. */
  empty: string;
}

export const TASK_VIEWS: readonly TaskViewEntry[] = [
  {
    id: 'tasks',
    label: (c) => `Tasks (${c.hidden > 0 ? `${c.filtered}/${c.total}` : c.filtered})`,
    count: (c) => c.filtered,
    has: (t, ctx) => isVisible(t, ctx.view),
    empty: 'nessuna task in vista: i filtri le escludono tutte',
  },
  {
    // `yellow` come prima: avverte che la vista è distorta da un filtro.
    id: 'hidden',
    label: (c) => `${c.hidden} nascoste`,
    count: (c) => c.hidden,
    has: (t, ctx) => !isVisible(t, ctx.view),
    color: 'yellow',
    empty: 'nessuna task nascosta: nessun filtro ne esclude',
  },
  {
    // T61 — dim: le Done oltre soglia non alterano ciò che stai guardando.
    id: 'archivable',
    label: (c) => `${c.archivable} archiviabili`,
    count: (c) => c.archivable,
    has: (t, ctx) => ctx.archivable.has(t.id),
    dim: true,
    empty: "nessuna Done oltre la soglia d'età",
  },
];

/**
 * Le task della vista `id`, filtrate col predicato e ordinate con la chain
 * corrente. L'ordinamento vale per ogni vista, non solo la principale: una lista
 * di task ordinata in un modo e l'altra in un altro sarebbe un secondo asse che
 * si muove da solo.
 */
export function selectTasks(tasks: Task[], id: TaskViewId, ctx: TaskViewCtx): Task[] {
  const entry = taskView(id);
  const picked = tasks.filter((t) => entry.has(t, ctx));
  picked.sort((a, b) => compareTasks(a, b, ctx.view.sort));
  return picked;
}

// ── pane sessioni ──────────────────────────────────────────────────────────

export interface SessionViewCounts {
  /** T133 D9 — le figlie del parent corrente, cap escluso (voce 1). Le pinnate
   *  non si sommano più: non sono un gruppo della lista, e quelle del parent sono
   *  già contate qui dentro come tutte le altre. */
  total: number;
  live: number;
  /** Pinnate del progetto intero, stale comprese: è l'insieme della vista `📌`,
   *  più largo della lista di qualunque parent. */
  pinned: number;
  /** Figlie troncate dal cap `maxContext`. */
  older: number;
}

export interface SessionViewCtx {
  assembled: AssembledList;
  isLive(sessionId: string): boolean;
}

export interface SessionViewEntry extends Styling {
  id: SessionViewId;
  /** `parentLabel` entra solo nella voce 1, che per costruzione è variabile:
   *  il pane task sceglie il parent, l'header quale sottoinsieme di quel parent
   *  (D2 create — due assi ortogonali). */
  label(counts: SessionViewCounts, parentLabel: string): string;
  count(counts: SessionViewCounts): number;
  rows(ctx: SessionViewCtx): SessionRow[];
  /** Nota della lista vuota; `null` = la nota la scrive il pane, che sa se il
   *  parent è una task, `spot` o `tutte`. */
  empty: string | null;
}

/** Glifo della sessione viva, gemello di `LIVE_IDLE` del render. Duplicato qui
 *  perché il catalogo è puro e non può importare da `cli.tsx`; è un carattere
 *  concorde (largo 1 per entrambe le contabilità), quindi non passa da
 *  `sanitize`. */
const LIVE_GLYPH = '●';

export const SESSION_VIEWS: readonly SessionViewEntry[] = [
  {
    id: 'context',
    label: (c, parent) => `${parent} (${c.total})`,
    count: (c) => c.total,
    rows: (ctx) => ctx.assembled.rows,
    empty: null,
  },
  {
    id: 'live',
    label: (c) => `${LIVE_GLYPH}${c.live} vive`,
    count: (c) => c.live,
    rows: (ctx) => ctx.assembled.rows.filter((r) => ctx.isLive(r.sessionId)),
    color: 'green',
    empty: 'nessuna conversazione viva in questa lista',
  },
  {
    // T133 D7 — sola vista che NON filtra la lista: il suo insieme è più largo
    // (le pinnate di ogni task, più le stale), quindi il core lo consegna a
    // parte. Un filtro su `rows` mostrerebbe le sole pinnate del parent
    // selezionato, cioè la risposta sbagliata alla domanda «quali ho pinnato».
    id: 'pinned',
    label: (c) => `📌${c.pinned}`,
    count: (c) => c.pinned,
    rows: (ctx) => ctx.assembled.pinnedRows,
    color: 'yellow',
    empty: 'nessuna conversazione pinnata',
  },
  {
    // D4 preflight — la coda troncata, non la lista intera senza cap: il numero
    // dell'header e il numero di righe devono coincidere.
    id: 'older',
    label: (c) => `+${c.older} più vecchie`,
    count: (c) => c.older,
    rows: (ctx) => ctx.assembled.overflowRows,
    dim: true,
    empty: 'nessuna conversazione oltre il cap',
  },
];

export function selectSessionRows(id: SessionViewId, ctx: SessionViewCtx): SessionRow[] {
  return sessionView(id).rows(ctx);
}

// ── lookup e navigazione ───────────────────────────────────────────────────

export function taskView(id: TaskViewId): TaskViewEntry {
  return TASK_VIEWS.find((v) => v.id === id) ?? TASK_VIEWS[0]!;
}

export function sessionView(id: SessionViewId): SessionViewEntry {
  return SESSION_VIEWS.find((v) => v.id === id) ?? SESSION_VIEWS[0]!;
}

/** Scorrimento ciclico del catalogo: `→` sull'ultima voce torna alla prima. Id
 *  ignoto → prima voce, mai un indice negativo. */
function cycle<T extends { id: string }>(catalog: readonly T[], current: string, delta: number): T {
  const at = catalog.findIndex((v) => v.id === current);
  if (at < 0) return catalog[0]!;
  return catalog[(at + delta + catalog.length) % catalog.length]!;
}

export function cycleTaskView(current: TaskViewId, delta: number): TaskViewId {
  return cycle(TASK_VIEWS, current, delta).id;
}

export function cycleSessionView(current: SessionViewId, delta: number): SessionViewId {
  return cycle(SESSION_VIEWS, current, delta).id;
}
