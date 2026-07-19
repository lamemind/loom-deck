// T39 — Core della vista: ordinali, sort chain multi-chiave, filtri.
// Modulo PURO: nessun import da ink/react, nessun I/O → testabile senza terminale.

import type { Task } from './tasks.js';

export type SortKey = 'pri' | 'prog' | 'id';
export type SortDir = 'asc' | 'desc';

export interface SortEntry {
  key: SortKey;
  dir: SortDir;
}

export type PriName = 'high' | 'med' | 'low';
export type ProgName = 'wip' | 'todo' | 'locked' | 'done';

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
// da fare → bloccata → chiusa. Non è l'ordine del ciclo di vita: il deck serve
// a scegliere su cosa lavorare, quindi le Done stanno in fondo sotto `desc`.
const PROG_TABLE: ReadonlyArray<{ name: ProgName; glyph: string; rank: number }> = [
  { name: 'wip', glyph: '🟡', rank: 4 },
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
// parseTasks ammette solo /^T\d+$/, ma un id fuori forma non deve far esplodere
// il comparator → finisce in coda con Number.MAX_SAFE_INTEGER.
export function idNum(id: string): number {
  const m = /^T(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
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
