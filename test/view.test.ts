import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyView,
  compareTasks,
  cycleSort,
  describeSort,
  epicRollup,
  groupHierarchy,
  idColumnWidth,
  idNum,
  padId,
  priRank,
  progName,
  progRank,
  taskColumns,
  toggleHidden,
  DEFAULT_VIEW,
  type SortCtx,
  type SortEntry,
  type TaskRowData,
  type ViewState,
} from '../src/view.js';
import { epicTail, taskTail } from '../src/glyphs.js';
import { termWidth } from '../src/width.js';
import { loadView, saveView, parseView } from '../src/view-store.js';
import { cellWidth, launchLegend, parseIdentity, parseLaunch } from '../src/config.js';
import type { Task } from '../src/tasks.js';

const t = (id: string, pri: string, prog: string): Task => ({
  id,
  pri,
  prog,
  desc: id,
  rawDesc: id,
});

const NO_COMMITS: SortCtx = { commitAt: new Map(), epicOf: new Map(), epics: new Set() };

// `TaskRowData` senza nessuna epica: il caso comune dei test pre-T67, così le
// firme restano leggibili come prima con uno spread invece che tre righe in più.
const NO_EPIC_DATA = { epics: new Set<string>(), epicRollup: new Map() };

const sortOf = (tasks: Task[], sort: SortEntry[], ctx: SortCtx = NO_COMMITS) =>
  [...tasks].sort((a, b) => compareTasks(a, b, sort, ctx)).map((x) => x.id);

test('ordinali: rango decrescente per urgenza, glifo ignoto sotto tutti', () => {
  assert.ok(priRank('🔥') > priRank('⚡'));
  assert.ok(priRank('⚡') > priRank('🔹'));
  assert.ok(priRank('🔹') > priRank('?'));
  assert.equal(priRank('🌈'), priRank(''));
});

test('VS16: ✔️ e ✔ hanno lo stesso rango', () => {
  assert.equal(progRank('✔️'), progRank('✔'));
  assert.ok(progRank('✔') > progRank('glifo-ignoto'));
  assert.ok(progRank('🟡') > progRank('🔵'));
  assert.ok(progRank('🔵') > progRank('🔒'));
});

test('🟢 ready: fra 🟡 e 🔵 per attivabilità', () => {
  assert.equal(progName('🟢'), 'ready');
  assert.ok(progRank('🟡') > progRank('🟢'));
  assert.ok(progRank('🟢') > progRank('🔵'));
});

test('id numerico: T9 precede T10 (non lessicografico)', () => {
  assert.ok(idNum('T9') < idNum('T10'));
  assert.deepEqual(
    sortOf([t('T10', '⚡', '🔵'), t('T9', '⚡', '🔵'), t('T100', '⚡', '🔵')], [
      { key: 'id', dir: 'asc' },
    ]),
    ['T9', 'T10', 'T100'],
  );
});

// Un id fuori forma non deve far esplodere il comparator: va in coda.
test('id: forma ignota in coda, ordine comunque deterministico', () => {
  assert.ok(idNum('T999') < idNum('D01'));
  assert.deepEqual(
    sortOf([t('T9', '⚡', '🔵'), t('D01', '⚡', '🔵'), t('T10', '⚡', '🔵')], [
      { key: 'id', dir: 'asc' },
    ]),
    ['T9', 'T10', 'D01'],
  );
});

// T118 — la colonna id è larga quanto l'id più lungo della POPOLAZIONE, e con
// una popolazione tutta a due cifre non c'è nessun padding da aggiungere: il
// rendering resta identico a quello di prima della colonna.
test('larghezza colonna id: massimo della lista, nessun padding se omogenea', () => {
  const list = [t('T9', '⚡', '🔵'), t('T90', '⚡', '🔵')];
  assert.equal(idColumnWidth(list), 3);
  assert.equal(idColumnWidth([]), 0);
  assert.equal(idColumnWidth([t('T90', '⚡', '🔵'), t('T12', '⚡', '🔵')]), 3);
  assert.equal(padId('T90', 3), 'T90');
  assert.equal(padId('T12', 3), 'T12');
});

// Il padding sta FRA la lettera e le cifre, non prima della lettera: la `T` è
// l'ancora con cui si riconosce la colonna e deve restare ferma.
test('padId: spazi dentro il prefisso, cifre allineate a destra', () => {
  const mixed = [t('T9', '⚡', '🔵'), t('T90', '⚡', '🔵'), t('T102', '⚡', '🔵')];
  const w = idColumnWidth(mixed);
  assert.equal(w, 4);
  assert.equal(padId('T9', w), 'T  9');
  assert.equal(padId('T90', w), 'T 90');
  assert.equal(padId('T102', w), 'T102');
  // Ogni cella è larga esattamente quanto la colonna dichiara, o Pri e Prog
  // tornano a cadere in colonne diverse riga per riga.
  for (const task of mixed) assert.equal(padId(task.id, w).length, w);
});

// T124 — la colonna coda si misura sulla STESSA stringa che il render disegna,
// e il chiamante non ha modo di comporne una gemella: `taskColumns` prende i tre
// lookup e chiama `taskTail` per conto suo.
test('taskColumns: la coda è il massimo della popolazione, più il proprio gutter', () => {
  const list = [t('T9', '⚡', '🔵'), t('T90', '⚡', '🔵')];
  const data: TaskRowData = {
    childCount: new Map([['T9', 3], ['T90', 12]]),
    live: new Map([['T90', { count: 2, status: 'busy' }]]),
    dirty: new Set<string>(),
    ...NO_EPIC_DATA,
  };
  // `(2/12` è la più larga: 5 colonne, più 1 di gutter.
  assert.equal(taskColumns(list, data).tail, termWidth(taskTail(2, 12, false)) + 1);
  assert.equal(taskColumns(list, data).id, 3);
});

// Nessuna riga con qualcosa da scrivere → colonna SPENTA, non larga 1: è quello
// che restituisce alle descrizioni lo spazio quando la lista non ha né
// conversazioni né marker.
test('taskColumns: coda a zero quando nessuna riga scrive niente', () => {
  const list = [t('T9', '⚡', '🔵')];
  const empty: TaskRowData = {
    childCount: new Map(),
    live: new Map(),
    dirty: new Set<string>(),
    ...NO_EPIC_DATA,
  };
  assert.equal(taskColumns(list, empty).tail, 0);
  // Basta però una sola folder sporca ad accenderla, senza nessun contatore.
  const dirty: TaskRowData = { ...empty, dirty: new Set(['T9']) };
  assert.ok(taskColumns(list, dirty).tail > 0);
});

// La liveness si rilegge a ogni poll, quindi la colonna è un elemento ANIMATO:
// una conversazione che si apre allarga di 2 celle la coda di tutta la lista, e
// il costo lo pagano le descrizioni. È il prezzo accettato per non riservare
// stabilmente la larghezza del caso più largo.
test('taskColumns: accendere una viva qualsiasi allarga la colonna di 2 celle', () => {
  const list = [t('T9', '⚡', '🔵'), t('T90', '⚡', '🔵')];
  const base = { childCount: new Map([['T9', 5], ['T90', 5]]), dirty: new Set<string>(), ...NO_EPIC_DATA };
  const spenta = taskColumns(list, { ...base, live: new Map() }).tail;
  const accesa = taskColumns(list, {
    ...base,
    live: new Map([['T9', { count: 1, status: 'idle' as const }]]),
  }).tail;
  assert.equal(accesa - spenta, 2);
});

test('padId: tre livelli di padding con un id a quattro cifre in lista', () => {
  const w = idColumnWidth([t('T9', '⚡', '🔵'), t('T1024', '⚡', '🔵')]);
  assert.equal(w, 5);
  assert.equal(padId('T9', w), 'T   9');
  assert.equal(padId('T102', w), 'T 102');
  assert.equal(padId('T1024', w), 'T1024');
});

// La regola è su `<lettere><cifre>`, non sulla `T`: un prefisso diverso si
// allinea allo stesso modo, senza che nessuno debba estendere una tabella.
test('padId: la regola è sul prefisso, non sulla lettera T', () => {
  assert.equal(padId('D01', 5), 'D  01');
});

// Un id fuori forma non deve far collassare la colonna: occupa la sua cella e
// basta, come già fa nel comparator (`idNum` lo manda in coda invece di
// esplodere).
test('padId: forma ignota riempita a destra, cella comunque piena', () => {
  assert.equal(padId('spot', 6), 'spot  ');
  assert.equal(padId('spot', 6).length, 6);
});

test('parità piena su tutte le chiavi → decide id ascendente', () => {
  const tasks = [t('T7', '⚡', '🔵'), t('T3', '⚡', '🔵'), t('T5', '⚡', '🔵')];
  assert.deepEqual(sortOf(tasks, [{ key: 'pri', dir: 'desc' }]), ['T3', 'T5', 'T7']);
});

test('id esplicito in chain disattiva il fallback implicito', () => {
  const tasks = [t('T3', '⚡', '🔵'), t('T7', '⚡', '🔵')];
  assert.deepEqual(sortOf(tasks, [{ key: 'id', dir: 'desc' }]), ['T7', 'T3']);
});

test('chain a più chiavi con direzioni miste', () => {
  const tasks = [
    t('T1', '⚡', '✔️'),
    t('T2', '🔥', '🔵'),
    t('T3', '⚡', '🟡'),
    t('T4', '🔥', '🟡'),
  ];
  // pri desc (🔥 prima), poi stato asc (rango basso prima: ✔️ < 🔒 < 🔵 < 🟢 < 🟡)
  assert.deepEqual(
    sortOf(tasks, [
      { key: 'pri', dir: 'desc' },
      { key: 'prog', dir: 'asc' },
    ]),
    ['T2', 'T4', 'T1', 'T3'],
  );
});

test('glifo sconosciuto non fa crashare il comparator', () => {
  const tasks = [t('T1', '🔥', '🔵'), t('T2', '🦄', '🎃'), t('T3', '⚡', '🟡')];
  assert.doesNotThrow(() => sortOf(tasks, DEFAULT_VIEW.sort));
  // rango minimo → sotto i noti quando si ordina desc
  assert.deepEqual(sortOf(tasks, DEFAULT_VIEW.sort), ['T1', 'T3', 'T2']);
});

test('sort deterministico: stesso input, stesso ordine (nessuna instabilità)', () => {
  const tasks = [t('T5', '⚡', '🔵'), t('T2', '⚡', '🔵'), t('T9', '⚡', '🔵')];
  const a = sortOf(tasks, DEFAULT_VIEW.sort);
  const b = sortOf([...tasks].reverse(), DEFAULT_VIEW.sort);
  assert.deepEqual(a, b);
});

test('cycleSort: assente → asc → desc → assente, in coda alla chain', () => {
  let sort: SortEntry[] = [];
  sort = cycleSort(sort, 'pri');
  assert.deepEqual(sort, [{ key: 'pri', dir: 'asc' }]);
  sort = cycleSort(sort, 'pri');
  assert.deepEqual(sort, [{ key: 'pri', dir: 'desc' }]);
  sort = cycleSort(sort, 'id');
  assert.deepEqual(sort, [
    { key: 'pri', dir: 'desc' },
    { key: 'id', dir: 'asc' },
  ]);
  sort = cycleSort(sort, 'pri');
  assert.deepEqual(sort, [{ key: 'id', dir: 'asc' }]);
});

test('sequenza "ppi" produce [pri desc, id asc]', () => {
  const sort = ['p', 'p', 'i'].reduce<SortEntry[]>(
    (acc, k) => cycleSort(acc, k === 'p' ? 'pri' : 'id'),
    [],
  );
  assert.deepEqual(sort, [
    { key: 'pri', dir: 'desc' },
    { key: 'id', dir: 'asc' },
  ]);
  assert.equal(describeSort(sort), 'pri↓ id↑');
});

// ── T136 · chiave `commit` ────────────────────────────────────────────────

test('commit↓: la testa della lista è il commit più recente', () => {
  const tasks = [t('T1', '⚡', '🔵'), t('T2', '⚡', '🔵'), t('T3', '⚡', '🔵')];
  const ctx: SortCtx = {
    commitAt: new Map([
      ['T1', 100],
      ['T2', 300],
      ['T3', 200],
    ]),
    epicOf: new Map(),
    epics: new Set(),
  };
  assert.deepEqual(sortOf(tasks, [{ key: 'commit', dir: 'desc' }], ctx), ['T2', 'T3', 'T1']);
});

test('commit: timestamp assente va in coda sotto `desc`, come il rango ignoto di pri/prog', () => {
  const tasks = [t('T1', '⚡', '🔵'), t('T2', '⚡', '🔵'), t('T3', '⚡', '🔵')];
  const ctx: SortCtx = { ...NO_COMMITS, commitAt: new Map([['T1', 500], ['T3', 100]]) }; // T2 mai committata
  assert.deepEqual(sortOf(tasks, [{ key: 'commit', dir: 'desc' }], ctx), ['T1', 'T3', 'T2']);
});

test('commit: componibile in chain — pri decide, commit spareggia a parità', () => {
  const tasks = [t('T1', '🔥', '🔵'), t('T2', '🔥', '🔵'), t('T3', '⚡', '🔵')];
  const ctx: SortCtx = {
    ...NO_COMMITS,
    commitAt: new Map([
      ['T1', 100],
      ['T2', 900],
      ['T3', 500],
    ]),
  };
  assert.deepEqual(
    sortOf(
      tasks,
      [
        { key: 'pri', dir: 'desc' },
        { key: 'commit', dir: 'desc' },
      ],
      ctx,
    ),
    ['T2', 'T1', 'T3'],
  );
});

test('describeSort rende la chiave `commit`', () => {
  assert.equal(describeSort([{ key: 'commit', dir: 'desc' }]), 'commit↓');
});

test('persistenza: la chain con `commit` sopravvive al round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-view-'));
  const view: ViewState = {
    sort: [{ key: 'commit', dir: 'desc' }, { key: 'id', dir: 'asc' }],
    hiddenPri: [],
    hiddenProg: [],
  };
  saveView(root, view);
  assert.deepEqual(loadView(root), view);
});

// ── T67 · grouping gerarchico (cappello + figlie) ───────────────────────────

const epicCtx = (
  epicOf: Record<string, string>,
  epics: string[] = [],
  commitAt = new Map<string, number>(),
): SortCtx => ({ commitAt, epicOf: new Map(Object.entries(epicOf)), epics: new Set(epics) });

test('groupHierarchy: le figlie sparse nell input finiscono tutte sotto la mamma, in blocco', () => {
  const tasks = [t('T5', '⚡', '🔵'), t('T1', '⚡', '🔵'), t('T3', '⚡', '🔵'), t('T2', '⚡', '🔵')];
  const ctx = epicCtx({ T2: 'T1', T3: 'T1', T5: 'T1' }, ['T1']);
  const { tasks: order, blockMark } = groupHierarchy(tasks, [{ key: 'id', dir: 'asc' }], ctx);
  assert.deepEqual(order.map((x) => x.id), ['T1', 'T2', 'T3', 'T5']);
  assert.equal(blockMark.get('T1'), '┌');
  assert.equal(blockMark.get('T2'), '│');
  assert.equal(blockMark.get('T3'), '│');
  assert.equal(blockMark.get('T5'), '└', 'ultima del blocco, non della sola lista in ingresso');
});

test('groupHierarchy: il blocco segue la mamma su qualunque chain, chiave `commit` compresa', () => {
  const tasks = [t('T1', '⚡', '🔵'), t('T2', '⚡', '🔵'), t('T3', '🔥', '🔵'), t('T4', '⚡', '🔵')];
  const ctx = epicCtx({ T4: 'T3' }, ['T3'], new Map([['T3', 100], ['T1', 900]]));
  // pri decide: T3 (🔥) in testa col suo blocco, benché T1 abbia il commit più recente.
  const byPri = groupHierarchy(
    tasks,
    [{ key: 'pri', dir: 'desc' }, { key: 'id', dir: 'asc' }],
    ctx,
  );
  assert.deepEqual(byPri.tasks.map((x) => x.id), ['T3', 'T4', 'T1', 'T2']);
  // stessa mamma, chain `commit`: il blocco si sposta insieme a lei.
  const byCommit = groupHierarchy(tasks, [{ key: 'commit', dir: 'desc' }], ctx);
  assert.deepEqual(byCommit.tasks.map((x) => x.id), ['T1', 'T3', 'T4', 'T2']);
});

test('groupHierarchy: capo-blocco quando il cappello non è nella lista passata (inesistente o fuori vista)', () => {
  // Stessa regola per un cappello mai esistito e per uno filtrato via altrove
  // (P6): la funzione vede solo l'array che riceve.
  const tasks = [t('T9', '⚡', '🔵'), t('T1', '⚡', '🔵')];
  const ctx = epicCtx({ T9: 'T34' });
  const { tasks: order, blockMark } = groupHierarchy(tasks, [{ key: 'id', dir: 'asc' }], ctx);
  assert.deepEqual(order.map((x) => x.id), ['T1', 'T9']);
  assert.equal(blockMark.has('T9'), false, 'nessun blocco da disegnare: T9 è sola');
});

test('applyView: figlia nascosta dal filtro, mamma visibile → resta capo-blocco quando la si guarda da sola', () => {
  const tasks = [t('T1', '🔥', '🔵'), t('T2', '⚡', '✔️')]; // T2 è figlia di T1, Done
  const ctx = epicCtx({ T2: 'T1' }, ['T1']);
  const view: ViewState = { ...DEFAULT_VIEW, hiddenProg: ['done'] };
  const shown = applyView(tasks, view, ctx);
  assert.deepEqual(shown.visible.map((x) => x.id), ['T1']);
  assert.equal(shown.blockMark.size, 0, 'T1 senza T2 in vista non ha nessun blocco da disegnare');
  // Come farebbe `selectTasks('hidden', …)`: solo i task esclusi dal filtro.
  const { blockMark } = groupHierarchy(
    tasks.filter((x) => x.id === 'T2'),
    view.sort,
    ctx,
  );
  assert.equal(blockMark.has('T2'), false, 'T1 non è in questa lista: T2 diventa capo-blocco');
});

test('groupHierarchy: ciclo A→B→A — entrambi capi-blocco, nessuna task sparisce', () => {
  const tasks = [t('A', '⚡', '🔵'), t('B', '⚡', '🔵'), t('C', '⚡', '🔵')];
  const ctx = epicCtx({ A: 'B', B: 'A', C: 'A' });
  const { tasks: order, blockMark } = groupHierarchy(tasks, [{ key: 'id', dir: 'asc' }], ctx);
  assert.deepEqual(order.map((x) => x.id).sort(), ['A', 'B', 'C']);
  // Rotto il ciclo, A resta un capo-blocco valido per C (che non ne faceva parte).
  assert.equal(blockMark.get('A'), '┌');
  assert.equal(blockMark.get('C'), '└');
  assert.equal(blockMark.has('B'), false, 'B è root senza figlie: nessun blocco');
});

test('groupHierarchy: epica annidata — porta le proprie figlie subito sotto di sé, senza chiudere il blocco', () => {
  // Fixture sintetica (Description): il repo non ha più un esemplare reale da
  // quando T141 è stata resa una task normale, ma il contratto la ammette.
  const tasks = [t('A', '⚡', '🔵'), t('B', '⚡', '🔵'), t('C', '⚡', '🔵'), t('D', '⚡', '🔵')];
  const ctx = epicCtx({ B: 'A', C: 'A', D: 'B' }, ['A', 'B']);
  const { tasks: order, blockMark } = groupHierarchy(tasks, [{ key: 'id', dir: 'asc' }], ctx);
  assert.deepEqual(order.map((x) => x.id), ['A', 'B', 'D', 'C']);
  assert.equal(blockMark.get('A'), '┌');
  // B è epica ma qui è FIGLIA: porta la spina di figlia, non un secondo '┌'
  // (D4) — la si riconosce come cappello dalla cella di stato vuota, altrove.
  assert.equal(blockMark.get('B'), '│');
  assert.equal(blockMark.get('D'), '│');
  assert.equal(blockMark.get('C'), '└', 'ultima dell intero sottoalbero, non della sola lista figli di A');
});

test('groupHierarchy: cappello Done con figlie Done affonda in blocco quando si ordina per stato', () => {
  const tasks = [t('T10', '⚡', '✔️'), t('T1', '⚡', '🟡'), t('T11', '⚡', '✔️')];
  const ctx = epicCtx({ T11: 'T10' }, ['T10']);
  const { tasks: order } = groupHierarchy(tasks, [{ key: 'prog', dir: 'desc' }], ctx);
  assert.deepEqual(order.map((x) => x.id), ['T1', 'T10', 'T11']);
});

test('epicRollup: conta tutte le figlie dichiarate, chiuse comprese', () => {
  const tasks = [t('T1', '⚡', '🔵'), t('T2', '⚡', '✔️'), t('T3', '⚡', '🟡')];
  const rollup = epicRollup(tasks, new Map([['T2', 'T1'], ['T3', 'T1']]));
  assert.deepEqual(rollup.get('T1'), { closed: 1, total: 2 });
});

test('epicRollup: un cappello senza figlie non compare nella mappa', () => {
  assert.equal(epicRollup([t('T1', '⚡', '🔵')], new Map()).has('T1'), false);
});

test('epicTail: coda vuota senza figlie, graffa senza chiusa altrimenti', () => {
  assert.equal(epicTail(undefined), '');
  assert.equal(epicTail({ closed: 0, total: 0 }), '', 'P9 — mai {0/0}');
  assert.equal(epicTail({ closed: 3, total: 11 }), '{3/11');
});

test('filtri: visibili + nascoste = totale', () => {
  const tasks = [t('T1', '🔥', '🔵'), t('T2', '⚡', '✔️'), t('T3', '🔹', '🟡')];
  const view: ViewState = { ...DEFAULT_VIEW, hiddenProg: ['done'] };
  const { visible, hidden } = applyView(tasks, view, NO_COMMITS);
  assert.equal(visible.length + hidden, tasks.length);
  assert.equal(hidden, 1);
  assert.deepEqual(visible.map((x) => x.id), ['T1', 'T3']);
});

test('filtri componibili in AND su pri e prog', () => {
  const tasks = [t('T1', '🔥', '🔵'), t('T2', '⚡', '✔️'), t('T3', '🔹', '🟡')];
  const view: ViewState = { ...DEFAULT_VIEW, hiddenPri: ['low'], hiddenProg: ['done'] };
  const { visible } = applyView(tasks, view, NO_COMMITS);
  assert.deepEqual(visible.map((x) => x.id), ['T1']);
});

test('un filtro non nasconde mai un glifo che non sa classificare', () => {
  const tasks = [t('T1', '🦄', '🎃')];
  const view: ViewState = { ...DEFAULT_VIEW, hiddenPri: ['high', 'med', 'low'] };
  assert.equal(applyView(tasks, view, NO_COMMITS).visible.length, 1);
});

test('applyView non muta l array in ingresso', () => {
  const tasks = [t('T3', '🔹', '🔵'), t('T1', '🔥', '🔵')];
  applyView(tasks, DEFAULT_VIEW, NO_COMMITS);
  assert.deepEqual(tasks.map((x) => x.id), ['T3', 'T1']);
});

test('toggleHidden aggiunge e rimuove', () => {
  assert.deepEqual(toggleHidden<'done'>([], 'done'), ['done']);
  assert.deepEqual(toggleHidden<'done'>(['done'], 'done'), []);
});

test('persistenza: round-trip salva → rilegge', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-view-'));
  const view: ViewState = {
    sort: [{ key: 'prog', dir: 'desc' }],
    hiddenPri: ['low'],
    hiddenProg: ['done'],
  };
  saveView(root, view);
  assert.deepEqual(loadView(root), view);
});

test('persistenza: file assente → default puliti', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-view-'));
  assert.deepEqual(loadView(root), DEFAULT_VIEW);
});

test('persistenza: file corrotto → default puliti, nessun crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-view-'));
  mkdirSync(join(root, '.claude', 'loom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'loom', 'deck-view.json'), '{ non json ][');
  assert.doesNotThrow(() => loadView(root));
  assert.deepEqual(loadView(root), DEFAULT_VIEW);
});

test('persistenza: chiavi sconosciute scartate, valide tenute', () => {
  const parsed = parseView({
    sort: [{ key: 'pri', dir: 'desc' }, { key: 'boom', dir: 'asc' }, { key: 'id', dir: 'su' }],
    hiddenPri: ['low', 'inventato'],
    hiddenProg: 'non-un-array',
  });
  assert.deepEqual(parsed.sort, [{ key: 'pri', dir: 'desc' }]);
  assert.deepEqual(parsed.hiddenPri, ['low']);
  assert.deepEqual(parsed.hiddenProg, []);
});

test('launch: label opzionale con fallback sul comando, voci invalide scartate', () => {
  const entries = parseLaunch({
    launch: [
      { emoji: '📝', label: 'codium', command: 'codium .' },
      { emoji: '☕', command: 'idea ud-maven-parent' },
      { emoji: '💥' },
      'spazzatura',
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].label, 'idea ud-maven-parent');
});

test('launch: config assente o senza array → nessuna voce', () => {
  assert.deepEqual(parseLaunch({}), []);
  assert.deepEqual(parseLaunch(null), []);
});

test('identity: name presente → identità; owner ignorato, name mancante o vuoto → null', () => {
  assert.deepEqual(parseIdentity({ owner: 'LOCAL', name: 'loom-works' }), { name: 'loom-works' });
  assert.deepEqual(parseIdentity({ name: 'loom-works' }), { name: 'loom-works' });
  assert.equal(parseIdentity({ owner: 'LOCAL' }), null);
  assert.equal(parseIdentity({ name: '' }), null);
  assert.equal(parseIdentity(null), null);
});

// ── T43 · legenda launch ─────────────────────────────────────────────────────

const L = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ emoji: '📝', label: `app${i + 1}`, command: `app${i + 1}` }));

test('legenda: indice base-1 + emoji + label, concorde col dispatch dei tasti', () => {
  const legend = launchLegend(L(3), 200);
  assert.equal(legend.shown, '1 📝 app1 · 2 📝 app2 · 3 📝 app3');
  assert.equal(legend.overflow, 0);
  assert.equal(legend.unreachable, 0);
});

test('legenda: nessuna voce → riga vuota, nessun contatore', () => {
  assert.deepEqual(launchLegend([], 200), {
    shown: '',
    taken: [],
    overflow: 0,
    unreachable: 0,
  });
});

test('legenda: label mancante → parseLaunch mette il comando, la legenda lo mostra', () => {
  const entries = parseLaunch({ launch: [{ emoji: '☕', command: 'idea ud-maven-parent' }] });
  // `☕️` con VS16: parseLaunch normalizza la larghezza dei glifi al confine
  // (vedi normalizeEmoji). Senza il timbro Ink riserva una cella sola per `☕`
  // mentre il terminale ne disegna due, e la riga della legenda va a capo.
  assert.equal(launchLegend(entries, 200).shown, '1 ☕️ idea ud-maven-parent');
});

test('legenda: emoji mancante → fallback ▸, non voce vuota', () => {
  const entries = parseLaunch({ launch: [{ command: 'lazygit' }] });
  assert.equal(launchLegend(entries, 200).shown, '1 ▸ lazygit');
});

test('legenda: terminale stretto → tronca a voci intere e conta le fuori riga', () => {
  const legend = launchLegend(L(6), 40);
  assert.ok(legend.shown.length > 0);
  assert.ok(legend.overflow > 0);
  // Degradazione NON silenziosa: mostrate + fuori riga = tutte le raggiungibili.
  assert.equal(legend.shown.split(' · ').length + legend.overflow, 6);
  // La riga non deve sfondare il box: budget = columns - 6 (bordo, padding e
  // margine; il prefisso "launch " non occupa più celle), con 10 di riserva.
  assert.ok(cellWidth(legend.shown) <= 40 - 6);
});

test('legenda: le celle riservate alle surface built-in escono dal budget', () => {
  // `t`/`c` stanno in testa alla stessa riga: quelle celle sono già spese,
  // quindi le voci launch devono vederne di meno — o la riga sfonda il box.
  const senza = launchLegend(L(6), 120);
  const con = launchLegend(L(6), 120, 60);
  assert.equal(senza.overflow, 0); // a 120 colonne nude ci stanno tutte
  assert.ok(cellWidth(con.shown) < cellWidth(senza.shown));
  assert.ok(cellWidth(con.shown) <= 120 - 6 - 60);
  assert.ok(con.overflow > 0); // e la degradazione resta contata, non silenziosa
});

test('legenda: oltre la nona voce → configurate ma non raggiungibili, contate a parte', () => {
  const legend = launchLegend(L(12), 400);
  assert.equal(legend.unreachable, 3);
  assert.equal(legend.shown.split(' · ').length, 9);
  assert.ok(!legend.shown.includes('app10'));
});

test('cellWidth: emoji largo 2, VS16 a larghezza 0, ascii 1', () => {
  assert.equal(cellWidth('ab'), 2);
  assert.equal(cellWidth('📝'), 2);
  assert.equal(cellWidth('⚡️'), 2); // simbolo BMP + VS16 → 2, non 3
});
