// T39 — Core della vista: ordinali, sort chain multi-chiave, filtri.
// Modulo PURO: nessun import da ink/react, nessun I/O → testabile senza terminale.

import { epicTail, taskTail } from './glyphs.js';
import { termWidth } from './width.js';
import type { TaskLive } from './live-sessions.js';
import type { Task } from './tasks.js';

export type SortKey = 'pri' | 'prog' | 'id' | 'commit';
export type SortDir = 'asc' | 'desc';

export interface SortEntry {
  key: SortKey;
  dir: SortDir;
}

/**
 * T136 — contesto esterno per la chiave `commit`: la data viene da `git log`,
 * non da una cella di `tasks.md`, e un comparator PURO non può andare a
 * prenderla da sé. Obbligatorio in `rankOf`/`compareTasks`/`applyView`: un
 * parametro opzionale farebbe compilare i chiamanti esistenti senza toccarli,
 * e la chiave nuova ordinerebbe male in silenzio.
 *
 * T67 — `epicOf`/`epics` viaggiano nello STESSO contesto e non in un parametro
 * a parte, per lo stesso motivo di `commitAt`: un dato esterno al comparator
 * (qui il filesystem dei task file, non `tasks.md`) che il grouping deve poter
 * leggere da entrambi i siti di sort (`applyView`, `selectTasks`).
 */
export interface SortCtx {
  commitAt: ReadonlyMap<string, number>;
  /** figlia → cappello dichiarato, grezzo (non filtrato su esistenza/ciclo: lo
   *  fa `groupHierarchy`, che ha la lista intera sotto gli occhi). */
  epicOf: ReadonlyMap<string, string>;
  /** id il cui task file porta `Size: Epic`. */
  epics: ReadonlySet<string>;
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
  /** T67 — id il cui task file porta `Size: Epic`: cella di stato vuota (D4) e
   *  coda sostituita dal rollup (P9), invece del contatore conversazioni. */
  epics: ReadonlySet<string>;
  /** T67/P9 — rollup {chiuse/totali} delle figlie dichiarate di un cappello,
   *  cieco a filtri e viste: chiave = id del cappello. */
  epicRollup: ReadonlyMap<string, { closed: number; total: number }>;
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
    // T67 — un cappello scrive il rollup ({chiuse/totali}) al posto del
    // contatore conversazioni: due formattazioni diverse, quindi la colonna
    // deve misurare quella che la riga disegna DAVVERO per quel task, non
    // sempre `taskTail`.
    const cell = data.epics.has(t.id)
      ? epicTail(data.epicRollup.get(t.id))
      : taskTail(data.live.get(t.id)?.count ?? 0, data.childCount.get(t.id) ?? 0, data.dirty.has(t.id));
    tail = Math.max(tail, termWidth(cell));
  }
  return { id: idColumnWidth(tasks), tail: tail > 0 ? tail + 1 : 0 };
}

// La chiave `commit` non ha un glifo: il rango è l'epoch stesso. Assente →
// UNKNOWN_RANK (0), sempre più basso di un epoch reale → coda sotto `desc`,
// stessa semantica del glifo non riconosciuto per `pri`/`prog`.
function rankOf(task: Task, key: SortKey, ctx: SortCtx): number {
  if (key === 'pri') return priRank(task.pri);
  if (key === 'prog') return progRank(task.prog);
  if (key === 'commit') return ctx.commitAt.get(task.id) ?? UNKNOWN_RANK;
  return idNum(task.id);
}

/**
 * Comparator della chain: chiavi valutate in cascata, prima differenza vince.
 * A parità piena decide `id` ascendente — fallback implicito che rende l'ordine
 * SEMPRE deterministico (mai instabile fra re-render). Se `id` è già una chiave
 * esplicita della chain il fallback non serve: l'id è unico, la parità è totale.
 */
export function compareTasks(a: Task, b: Task, sort: SortEntry[], ctx: SortCtx): number {
  for (const entry of sort) {
    const diff = rankOf(a, entry.key, ctx) - rankOf(b, entry.key, ctx);
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

// ── T67 · grouping gerarchico (cappello + figlie) ───────────────────────────
//
// NON è una chiave di sort in più: `compareTasks` resta un comparator piatto,
// e sopra ci sta un LIVELLO — si ordinano i capi-blocco con la chain, poi le
// figlie di ognuno con la STESSA chain, poi si appiattisce in preordine. Una
// chiave gerarchica dentro `compareTasks` produrrebbe un ordine corretto solo
// per la chain di default e sbagliato per tutte le altre (Description).

/** Glifo della spina di blocco (D3 preflight): assente = task normale, che
 *  NON riserva le 2 colonne davanti alla descrizione. */
export type BlockMark = '┌' | '│' | '└';

/**
 * Cappello → id normalizzati a un albero valido: entrate scartate quando il
 * cappello non è NELLA LISTA passata (P6 — capo-blocco, non sparizione), punta
 * a se stesso, o chiude un ciclo.
 *
 * Rilevamento ciclo sul grafo ORIGINALE (mai su una versione già potata): per
 * ogni id si cammina la catena fino a `raw.size` passi. Se la catena rivede
 * l'id di PARTENZA, quell'id è membro di un ciclo e perde il proprio arco — chi
 * punta a lui da fuori il ciclo mantiene invece il proprio, e finisce agganciato
 * a un capo-blocco valido (l'ex membro del ciclo, ora orfano). Implementation
 * Notes: «i membri del ciclo diventano capi-blocco, nessuno sparisce».
 */
function resolveParents(tasks: Task[], epicOf: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const byId = new Set(tasks.map((t) => t.id));
  const raw = new Map<string, string>();
  for (const t of tasks) {
    const p = epicOf.get(t.id);
    if (p && p !== t.id && byId.has(p)) raw.set(t.id, p);
  }
  const cyclic = new Set<string>();
  for (const id of raw.keys()) {
    let cur = raw.get(id);
    let steps = 0;
    while (cur !== undefined && steps <= raw.size) {
      if (cur === id) {
        cyclic.add(id);
        break;
      }
      cur = raw.get(cur);
      steps++;
    }
  }
  const parentOf = new Map<string, string>();
  for (const [id, p] of raw) if (!cyclic.has(id)) parentOf.set(id, p);
  return parentOf;
}

export interface HierarchyResult {
  tasks: Task[];
  blockMark: ReadonlyMap<string, BlockMark>;
}

/**
 * Riordina `tasks` in blocchi cappello+figlie e li appiattisce in un unico
 * array: i capi-blocco (cappelli + task senza cappello valido, P6) si ordinano
 * fra loro con `sort`, poi le figlie di ognuno si ordinano fra loro con lo
 * STESSO `sort` e si appiattiscono in preordine sotto la propria mamma —
 * ricorsivo, non un livello solo (P7), così un'epica annidata porta le proprie
 * figlie subito sotto di sé.
 *
 * `blockMark` marca SOLO le righe che fanno parte di un blocco: `┌` sul
 * cappello (un capo-blocco con almeno una figlia in lista), `│`/`└` sulle
 * figlie (`└` sull'ultima dell'INTERO sottoalbero, non della sola lista
 * immediata — un'epica annidata non chiude il blocco, ci sono ancora le sue
 * figlie sotto). Una task normale non compare nella mappa: niente cella (D3).
 */
export function groupHierarchy(tasks: Task[], sort: SortEntry[], ctx: SortCtx): HierarchyResult {
  const parentOf = resolveParents(tasks, ctx.epicOf);
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    const p = parentOf.get(t.id);
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(t);
  }
  const roots = tasks.filter((t) => !parentOf.has(t.id));
  roots.sort((a, b) => compareTasks(a, b, sort, ctx));

  function flatten(task: Task): Task[] {
    const kids = [...(childrenOf.get(task.id) ?? [])].sort((a, b) => compareTasks(a, b, sort, ctx));
    const sub = [task];
    for (const kid of kids) sub.push(...flatten(kid));
    return sub;
  }

  const order: Task[] = [];
  const blockMark = new Map<string, BlockMark>();
  for (const root of roots) {
    const block = flatten(root);
    if (block.length > 1) blockMark.set(root.id, '┌');
    for (let i = 1; i < block.length; i++) {
      blockMark.set(block[i]!.id, i === block.length - 1 ? '└' : '│');
    }
    order.push(...block);
  }
  return { tasks: order, blockMark };
}

/**
 * Rollup {chiuse/totali} delle figlie DICHIARATE di ogni cappello — cieco a
 * filtri e viste (P9): conta su TUTTE le task passate, non sulla vista
 * corrente, o il numero cambierebbe filtrando senza che nessuna figlia sia
 * davvero comparsa o sparita.
 */
export function epicRollup(
  tasks: Task[],
  epicOf: ReadonlyMap<string, string>,
): ReadonlyMap<string, { closed: number; total: number }> {
  const parentOf = resolveParents(tasks, epicOf);
  const rollup = new Map<string, { closed: number; total: number }>();
  for (const t of tasks) {
    const p = parentOf.get(t.id);
    if (!p) continue;
    const entry = rollup.get(p) ?? { closed: 0, total: 0 };
    entry.total++;
    if (progName(t.prog) === 'done') entry.closed++;
    rollup.set(p, entry);
  }
  return rollup;
}

export interface ViewResult {
  visible: Task[];
  hidden: number;
  blockMark: ReadonlyMap<string, BlockMark>;
}

/** Filtra, ordina, raggruppa in blocchi. Non muta l'input: il polling di
 *  tasks.md resta ignaro. */
export function applyView(tasks: Task[], view: ViewState, ctx: SortCtx): ViewResult {
  const filtered = tasks.filter((t) => isVisible(t, view));
  const { tasks: visible, blockMark } = groupHierarchy(filtered, view.sort, ctx);
  return { visible, hidden: tasks.length - filtered.length, blockMark };
}

export const PRI_ENTRIES = PRI_TABLE.map((e) => ({ name: e.name, glyph: e.glyph }));
export const PROG_ENTRIES = PROG_TABLE.map((e) => ({ name: e.name, glyph: e.glyph }));

const SORT_LABEL: Record<SortKey, string> = { pri: 'pri', prog: 'stato', id: 'id', commit: 'commit' };

/** Riassunto della chain per l'header ("pri↓ id↑"); vuota → "—". */
export function describeSort(sort: SortEntry[]): string {
  if (sort.length === 0) return '—';
  return sort.map((e) => `${SORT_LABEL[e.key]}${e.dir === 'asc' ? '↑' : '↓'}`).join(' ');
}
