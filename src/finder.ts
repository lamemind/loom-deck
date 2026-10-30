// T169 — il MOTORE del finder delle task: dalla lista intera di `tasks.md` e da
// ciò che si è digitato, le righe da mostrare e quella da cui partire.
//
// Puro: nessun Ink, nessun filesystem, nessuna vista del pane. Lavora sulle
// sole righe di `tasks.md` (P8 preflight): il corpo dei task file e il titolo
// intero dall'H1 restano fuori, e con loro la lettura di cento file a ogni
// carattere digitato.
//
// Due domande diverse passano dallo stesso campo, e la forma della query le
// separa:
//
//  - un NUMERO (`142`, `T142`, `t142`) cerca un id — «il 99% delle volte mi
//    serve per numero» (D2). L'id esatto sta in testa e diventa la selezione
//    iniziale, poi gli id che cominciano con quelle cifre. Il titolo non si
//    guarda: `142` non deve tirare dentro ogni task che nomina T142 in prosa,
//    o `T` `142` `⏎` rischierebbe di cadere su un'altra riga;
//  - tutto il resto è TESTO, sottostringa letterale del titolo senza maiuscole
//    (P2). Passa da `scanText`, lo stesso compilatore della ricerca nel detail:
//    stessa soglia (`MIN_DETAIL_QUERY`, un carattere), stessa resa dei caratteri
//    speciali, che un `includes` scritto qui avrebbe potuto divergere.
//
// L'ordine è quello di `tasks.md` — id decrescente, lista piatta (P3) — e non
// quello del pane: la sort chain del pane chiede date di commit e gerarchia
// delle epiche, cioè due scan che il motore non deve conoscere.
import { scanText } from './text-search.js';
import { idNum } from './view.js';
import type { Task } from './tasks.js';

/** La forma di ciò che si è digitato. `all` è il campo vuoto: la lista intera. */
export type FinderQuery =
  | { kind: 'all' }
  | { kind: 'id'; digits: string }
  | { kind: 'text'; text: string };

export interface FinderResult {
  query: FinderQuery;
  /** Le righe che passano, già nell'ordine in cui si mostrano. */
  tasks: Task[];
  /** L'id che coincide con le cifre digitate, se c'è: sta in testa a `tasks`. */
  exact: string | null;
}

/** Un id è `T` + cifre (`TASK_ID_RE`); la `T` si può omettere e si accetta
 *  minuscola, perché chi digita un numero non deve ricordarsi lo shift. */
const ID_QUERY_RE = /^[Tt]?(\d+)$/;

export function parseFinderQuery(raw: string): FinderQuery {
  const q = raw.trim();
  if (q === '') return { kind: 'all' };
  const m = ID_QUERY_RE.exec(q);
  if (m) return { kind: 'id', digits: m[1]! };
  return { kind: 'text', text: q };
}

/** Le cifre di un id (`T142` → `142`); `null` su un id fuori forma, che quindi
 *  non risponde mai a una query numerica. */
function idDigits(id: string): string | null {
  const m = /^T(\d+)$/.exec(id);
  return m ? m[1]! : null;
}

function byIdDesc(a: Task, b: Task): number {
  return idNum(b.id) - idNum(a.id);
}

/**
 * Le righe del finder per la query `raw`, su `tasks` — tutte le righe di
 * `tasks.md`, viste e filtri del pane ignorati per costruzione: il chiamante
 * passa la lista grezza, e qui non esiste nessun predicato di visibilità.
 */
export function findTasks(tasks: readonly Task[], raw: string): FinderResult {
  const query = parseFinderQuery(raw);
  if (query.kind === 'all') {
    return { query, tasks: [...tasks].sort(byIdDesc), exact: null };
  }
  if (query.kind === 'id') {
    // L'esatto è un confronto di STRINGHE di cifre, non di numeri: `T0142` non
    // è un id, e `0142` digitato non deve diventare T142 per via di `Number`.
    const exact = tasks.find((t) => idDigits(t.id) === query.digits) ?? null;
    const prefixed = tasks
      .filter((t) => t !== exact && (idDigits(t.id) ?? '').startsWith(query.digits))
      .sort(byIdDesc);
    return { query, tasks: exact ? [exact, ...prefixed] : prefixed, exact: exact?.id ?? null };
  }
  // `desc` e non `rawDesc`: è la stringa che la riga disegna, quindi un match
  // trovato qui è un match che si vede — su `rawDesc` un glifo sanificato al
  // confine (`✔` → `✅`) darebbe un risultato senza nulla di visibile che lo
  // giustifichi.
  const matched = tasks.filter((t) => scanText(t.desc, query.text).occ.length > 0).sort(byIdDesc);
  return { query, tasks: matched, exact: null };
}

/**
 * La riga da cui parte la selezione: l'id esatto quando c'è, altrimenti la
 * prima. `null` solo a lista vuota.
 *
 * Esiste come funzione e non come `exact ?? tasks[0]` sparso nell'overlay
 * perché è il contratto del gesto `T` `142` `⏎`: la selezione deve stare
 * sull'id esatto anche quando l'ordine delle righe cambiasse un giorno, e la
 * regola si prova qui senza montare nulla.
 */
export function initialSelection(result: FinderResult): string | null {
  return result.exact ?? result.tasks[0]?.id ?? null;
}
