// T39 — Core della vista: ordinali, sort chain multi-chiave, filtri.
// Modulo PURO: nessun import da ink/react, nessun I/O → testabile senza terminale.

import { taskTail } from './glyphs.js';
import { termWidth } from './width.js';
import type { TaskLive } from './live-sessions.js';
import type { Task } from './tasks.js';

export type SortKey = 'pri' | 'prog' | 'id';
export type SortDir = 'asc' | 'desc';

export interface SortEntry {
  key: SortKey;
  dir: SortDir;
}

export type PriName = 'high' | 'med' | 'low';
export type ProgName = 'wip' | 'ready' | 'todo' | 'locked' | 'done';

export interface ViewState {
  /** Chain ordinata: valutata in cascata, prima chiave = più significativa. */
  sort: SortEntry[];
  /** Valori NASCOSTI (non quelli mostrati): lista vuota = filtro spento. */
  hiddenPri: PriName[];
  hiddenProg: ProgName[];
}

// D2 (preflight T39): sort opinato, filtri off. La lista parte ordinata ma
// completa — nessuna task sparisce senza che l'utente abbia toccato una leva.
export const DEFAULT_VIEW: ViewState = {
  sort: [
    { key: 'pri', dir: 'desc' },
    { key: 'id', dir: 'asc' },
  ],
  hiddenPri: [],
  hiddenProg: [],
};

// Le celle Pri/Prog di tasks.md sono glifi grezzi (tasks.ts:47-50), non ranghi.
// Il rango è un'IMPORTANZA: valore alto = più urgente/attivo, così `desc` legge
// naturalmente come "prima i più importanti" (ed è il default della chain).
const PRI_TABLE: ReadonlyArray<{ name: PriName; glyph: string; rank: number }> = [
  { name: 'high', glyph: '🔥', rank: 3 },
  { name: 'med', glyph: '⚡', rank: 2 },
  { name: 'low', glyph: '🔹', rank: 1 },
];

// Ordine per "attivabilità" (desc = prima ciò su cui puoi agire): in corso →
// preflight fatto → da fare → bloccata → chiusa. Non è l'ordine del ciclo di
// vita: il deck serve a scegliere su cosa lavorare, quindi le Done stanno in
// fondo sotto `desc`. `ready` sta sopra `todo` perché il design è già congelato
// (run-task parte senza Q&A), e sotto `wip` perché il lavoro già aperto viene
// prima. Il rango governa anche l'ordine delle colonne della barra SHIFT+F,
// derivata da PROG_ENTRIES.
const PROG_TABLE: ReadonlyArray<{ name: ProgName; glyph: string; rank: number }> = [
  { name: 'wip', glyph: '🟡', rank: 5 },
  { name: 'ready', glyph: '🟢', rank: 4 },
  { name: 'todo', glyph: '🔵', rank: 3 },
  { name: 'locked', glyph: '🔒', rank: 2 },
  { name: 'done', glyph: '✔', rank: 1 },
];

/** Rango dei glifi non riconosciuti: sotto tutti i noti → coda sotto `desc`. */
const UNKNOWN_RANK = 0;

// `✔️` (con VS16) e `✔` (senza) coesistono in tasks.md; una lookup per
// uguaglianza mancherebbe una delle due forme. Stessa insidia già aggirata ad
// hoc da isDone() con un includes(). Qui si normalizza una volta sola.
const VS16_RE = /️/g;
function normGlyph(s: string): string {
  return s.replace(VS16_RE, '').trim();
}

export function priName(glyph: string): PriName | null {
  const g = normGlyph(glyph);
  return PRI_TABLE.find((e) => e.glyph === g)?.name ?? null;
}

export function progName(glyph: string): ProgName | null {
  const g = normGlyph(glyph);
  return PROG_TABLE.find((e) => e.glyph === g)?.name ?? null;
}

export function priRank(glyph: string): number {
  const g = normGlyph(glyph);
  return PRI_TABLE.find((e) => e.glyph === g)?.rank ?? UNKNOWN_RANK;
}

export function progRank(glyph: string): number {
  const g = normGlyph(glyph);
  return PROG_TABLE.find((e) => e.glyph === g)?.rank ?? UNKNOWN_RANK;
}

// `T10`.localeCompare(`T9`) mette T10 prima: l'ID va confrontato NUMERICO.
// Prefisso unico → il numero è già una chiave totale, e il rango è il numero.
// Un id fuori forma non deve far esplodere il comparator → coda con MAX_SAFE.
export function idNum(id: string): number {
  const m = /^T(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * T118 — larghezza della colonna id, DERIVATA dalla popolazione.
 *
 * La popolazione è la vista attiva COMPLETA, non la finestra visibile: una
 * larghezza misurata sulle sole righe renderizzate sposta le colonne mentre si
 * scorre, cioè una tabella corretta a ogni frame e illeggibile nel movimento.
 * Il chiamante deve quindi passare `paneTasks`, non l'array che finisce nel
 * pane (`tasks` in `TaskPane` è già la finestra).
 *
 * Gli id sono `T` + cifre (`TASK_ID_RE`), cioè ASCII: `.length` conta colonne.
 */
export function idColumnWidth(tasks: ReadonlyArray<Task>): number {
  let w = 0;
  for (const t of tasks) w = Math.max(w, t.id.length);
  return w;
}

/**
 * T118 — id allineato a destra DENTRO il prefisso: `T102` in lista rende `T90`
 * come `T 90`, non come ` T90`.
 *
 * Il prefisso di tipo è l'ancora con cui l'occhio riconosce la colonna:
 * spostarlo riga per riga toglie proprio ciò che l'allineamento dava. Sono le
 * cifre ad allinearsi fra loro, la `T` resta ferma.
 */
export function padId(id: string, cols: number): string {
  const m = /^([A-Za-z]+)(\d+)$/.exec(id);
  if (!m) return id.padEnd(cols);
  return m[1]! + ' '.repeat(Math.max(0, cols - id.length)) + m[2]!;
}

/**
 * T124 — i tre lookup per-task che una riga di lista consuma insieme. Viaggiano
 * come un blocco perché hanno due consumatori (il pane task e la schermata di
 * assegnazione) e perché la larghezza della colonna coda si misura sugli stessi
 * tre: passarli sciolti significa poterne dimenticare uno su un lato solo, che
 * è esattamente come la schermata di assegnazione era divergita.
 */
export interface TaskRowData {
  childCount: ReadonlyMap<string, number>;
  live: ReadonlyMap<string, TaskLive>;
  dirty: ReadonlySet<string>;
}

/**
 * T118/T124 — le due colonne fisse della lista task, misurate sulla popolazione
 * COMPLETA della vista e non sulla finestra visibile.
 *
 * `tail` porta dentro il proprio gutter (`+1`), così l'allineamento a destra lo
 * produce `pad` da sé; nessuna riga con qualcosa da scrivere → `0`, colonna
 * spenta, e le descrizioni si riprendono lo spazio.
 *
 * La stringa misurata qui è la STESSA che il render disegna (`taskTail`): due
 * formattazioni gemelle divergerebbero alla prima modifica, e la colonna
 * risulterebbe larga quanto una stringa che nessuno scrive.
 */
export function taskColumns(
  tasks: ReadonlyArray<Task>,
  data: TaskRowData,
): { id: number; tail: number } {
  let tail = 0;
  for (const t of tasks) {
    tail = Math.max(
      tail,
      termWidth(
        taskTail(data.live.get(t.id)?.count ?? 0, data.childCount.get(t.id) ?? 0, data.dirty.has(t.id)),
      ),
    );
  }
  return { id: idColumnWidth(tasks), tail: tail > 0 ? tail + 1 : 0 };
}

function rankOf(task: Task, key: SortKey): number {
  if (key === 'pri') return priRank(task.pri);
  if (key === 'prog') return progRank(task.prog);
  return idNum(task.id);
}

/**
 * Comparator della chain: chiavi valutate in cascata, prima differenza vince.
 * A parità piena decide `id` ascendente — fallback implicito che rende l'ordine
 * SEMPRE deterministico (mai instabile fra re-render). Se `id` è già una chiave
 * esplicita della chain il fallback non serve: l'id è unico, la parità è totale.
 */
export function compareTasks(a: Task, b: Task, sort: SortEntry[]): number {
  for (const entry of sort) {
    const diff = rankOf(a, entry.key) - rankOf(b, entry.key);
    if (diff !== 0) return entry.dir === 'asc' ? diff : -diff;
  }
  if (sort.some((e) => e.key === 'id')) return 0;
  return idNum(a.id) - idNum(b.id);
}

/**
 * Ciclo di una chiave nella chain: assente → asc → desc → assente.
 * La POSIZIONE nella chain nasce dall'ordine di prima pressione (digitare
 * `ppi` produce [pri desc, id asc]); ri-aggiungere una chiave rimossa la
 * riaccoda in fondo, non la rimette al posto vecchio.
 */
export function cycleSort(sort: SortEntry[], key: SortKey): SortEntry[] {
  const i = sort.findIndex((e) => e.key === key);
  if (i < 0) return [...sort, { key, dir: 'asc' }];
  if (sort[i].dir === 'asc') {
    const next = [...sort];
    next[i] = { key, dir: 'desc' };
    return next;
  }
  return sort.filter((e) => e.key !== key);
}

export function toggleHidden<T extends string>(hidden: T[], name: T): T[] {
  return hidden.includes(name) ? hidden.filter((h) => h !== name) : [...hidden, name];
}

/**
 * Un filtro nasconde solo valori RICONOSCIUTI: un glifo ignoto non è
 * classificabile, quindi resta visibile. Regola voluta — un filtro non deve
 * far sparire in silenzio task che non sa leggere.
 */
export function isVisible(task: Task, view: ViewState): boolean {
  const p = priName(task.pri);
  if (p && view.hiddenPri.includes(p)) return false;
  const s = progName(task.prog);
  if (s && view.hiddenProg.includes(s)) return false;
  return true;
}

export interface ViewResult {
  visible: Task[];
  hidden: number;
}

/** Filtra poi ordina. Non muta l'input: il polling di tasks.md resta ignaro. */
export function applyView(tasks: Task[], view: ViewState): ViewResult {
  const visible = tasks.filter((t) => isVisible(t, view));
  visible.sort((a, b) => compareTasks(a, b, view.sort));
  return { visible, hidden: tasks.length - visible.length };
}

export const PRI_ENTRIES = PRI_TABLE.map((e) => ({ name: e.name, glyph: e.glyph }));
export const PROG_ENTRIES = PROG_TABLE.map((e) => ({ name: e.name, glyph: e.glyph }));

const SORT_LABEL: Record<SortKey, string> = { pri: 'pri', prog: 'stato', id: 'id' };

/** Riassunto della chain per l'header ("pri↓ id↑"); vuota → "—". */
export function describeSort(sort: SortEntry[]): string {
  if (sort.length === 0) return '—';
  return sort.map((e) => `${SORT_LABEL[e.key]}${e.dir === 'asc' ? '↑' : '↓'}`).join(' ');
}
