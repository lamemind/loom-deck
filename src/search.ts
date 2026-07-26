// T52 — Core della ricerca full-text nelle conversazioni del progetto.
//
// Modulo PURO, gemello di `session-list.ts`: nessun import da ink/react, nessun
// I/O, nessuno stato globale. Prende in ingresso le `Session` già parsate
// dall'adapter (con i `bodies` trattenuti dalla cache mtime-keyed) e restituisce
// le righe da renderizzare. Tutto ciò che è testabile senza terminale sta qui.
//
// Invarianti (decisioni congelate al preflight):
//  - D3: perimetro = SOLO le sessioni del progetto corrente. Il modulo cerca su
//    ciò che gli viene passato, e chi lo chiama passa `discoverProjectSessions`.
//  - D5: ricerca IN MEMORIA sui corpi, nessun prefiltro esterno. Un solo motore
//    di regex (`RegExp` JS) sia in modalità literal sia in `^R` → non esiste il
//    caso "il prefiltro scarta un file che contiene un'occorrenza reale".
//  - D6: tre kind (ai · tool · human). Il `thinking` non è persistito.
//  - D7: la riga-occorrenza porta l'indice del record; la data sta una volta
//    sola sulla riga-sessione.
//  - Trap T39/T50: la selezione è keyed su una CHIAVE DISCRIMINATA, mai su
//    indice posizionale — la lista si riordina a ogni carattere digitato.

import type { BodyKind, MessageBody, Session } from './sessions.js';

/** Sotto questa soglia non si cerca: 1-2 char matchano ovunque e la lista
 *  sarebbe rumore. Stato lecito, non un errore. */
export const MIN_QUERY = 3;

/** Larghezza nominale dell'estratto attorno al match. */
export const EXCERPT_WIDTH = 50;

/** Cap per singola conversazione. Serve a tenere leggibile un gruppo, non a
 *  proteggere la memoria: una query corta può matchare centinaia di volte nello
 *  stesso transcript e sommergere tutte le altre conversazioni. */
export const MAX_HITS_PER_SESSION = 20;

/** Cap globale. Oltre, la lista non è più navigabile a mano: la risposta giusta
 *  è restringere la query, e il contatore delle nascoste lo dice. */
export const MAX_TOTAL_HITS = 400;

export interface SearchOptions {
  /** `^R` — la chiave è una regex invece che testo letterale. */
  regex: boolean;
  /** `^A` — distingue maiuscole e minuscole. */
  caseSensitive: boolean;
  /** `^W` — solo parole intere. */
  wholeWord: boolean;
  /** `^B` / `^T` / `^U` — quali corpi entrano nell'indice. */
  kinds: Record<BodyKind, boolean>;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  // D4/§Filtro: il testo IA è il caso d'uso che ha generato la task («l'IA me
  // l'ha detto 150k fa»); tools e human si accendono a mano.
  kinds: { ai: true, tool: false, human: false },
};

export interface Hit {
  sessionId: string;
  /** Indice del record nel transcript (prefisso della riga). */
  idx: number;
  kind: BodyKind;
  /** Estratto ~EXCERPT_WIDTH char col match al centro, whitespace collassato. */
  excerpt: string;
  /** Offset del match nel testo RAW del corpo — il reader ci si posiziona. */
  matchStart: number;
  matchEnd: number;
  /** Corpo intero, per il reader. È il RIFERIMENTO alla stringa già in memoria
   *  nella Session, non una copia: risolverlo qui evita al chiamante un lookup
   *  (sessionId, idx, kind) su ogni ⏎. */
  text: string;
}

export interface SessionHits {
  session: Session;
  hits: Hit[];
  /** Occorrenze oltre MAX_HITS_PER_SESSION (contatore non-silenzioso). */
  hidden: number;
}

export interface SearchResult {
  groups: SessionHits[];
  /** Occorrenze mostrate, sommate su tutti i gruppi. */
  shown: number;
  /** Occorrenze trovate e non mostrate (cap per-sessione + cap globale). */
  hidden: number;
  /** Conversazioni con almeno un'occorrenza mostrata. */
  sessionCount: number;
  /** Messaggio d'errore della regex; '' se la query è valida. */
  error: string;
  /** La query è sotto MIN_QUERY (o vuota) → nessuna ricerca eseguita. */
  idle: boolean;
}

const EMPTY: SearchResult = {
  groups: [],
  shown: 0,
  hidden: 0,
  sessionCount: 0,
  error: '',
  idle: true,
};

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compila la query nel matcher.
 *
 * Ritorna `{re: null, error}` invece di lanciare: con la ricerca eager la regex
 * viene ricompilata a ogni carattere, e uno stato intermedio invalido (`[a-`,
 * `(`) è la NORMA durante la digitazione, non un caso limite. Deve degradare a
 * lista vuota con segnalazione inline, mai a un crash della TUI.
 */
export function buildMatcher(
  query: string,
  opts: SearchOptions,
): { re: RegExp | null; error: string } {
  if (query.length < MIN_QUERY) return { re: null, error: '' };
  let source = opts.regex ? query : escapeLiteral(query);
  // Il gruppo non-catturante è obbligatorio: senza, `\b` si legherebbe al solo
  // primo/ultimo ramo di un'alternativa (`\bfoo|bar\b` ≠ `\b(?:foo|bar)\b`).
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = opts.caseSensitive ? 'g' : 'gi';
  try {
    return { re: new RegExp(source, flags), error: '' };
  } catch (e) {
    return { re: null, error: (e as Error).message };
  }
}

/**
 * Estratto centrato sul match.
 *
 * Il testo è RAW (newline incluse) e gli offset sono suoi: si affetta prima e si
 * collassa il whitespace dopo, su ciascun pezzo separatamente. Collassare prima
 * sposterebbe gli offset; collassare l'intera finestra insieme fonderebbe i
 * confini del match con il contesto.
 *
 * Degrada ai bordi: match a inizio o fine messaggio prende tutto il contesto
 * disponibile dal lato che ce l'ha, invece di lasciare metà estratto vuoto.
 */
export function excerptAround(
  text: string,
  start: number,
  end: number,
  width = EXCERPT_WIDTH,
): string {
  const collapse = (s: string) => s.replace(/\s+/g, ' ');
  // Un match più lungo dell'estratto: si tronca il match stesso, altrimenti la
  // riga andrebbe a capo e sfonderebbe il budget d'altezza della lista.
  if (end - start >= width) {
    return collapse(text.slice(start, start + width - 1)).trimEnd() + '…';
  }

  const budget = width - (end - start);
  // Metà per lato, poi il lato che non riesce a spendere la sua quota (match a
  // ridosso di un bordo) la cede all'altro.
  let before = Math.floor(budget / 2);
  let after = budget - before;
  const availBefore = start;
  const availAfter = text.length - end;
  if (before > availBefore) {
    after += before - availBefore;
    before = availBefore;
  }
  if (after > availAfter) {
    before = Math.min(availBefore, before + (after - availAfter));
    after = availAfter;
  }

  const from = start - before;
  const to = end + after;
  const head = collapse(text.slice(from, start));
  const mid = collapse(text.slice(start, end));
  const tail = collapse(text.slice(end, to));
  return (from > 0 ? '…' : '') + head + mid + tail + (to < text.length ? '…' : '');
}

/**
 * Scansiona un corpo: materializza al più `need` occorrenze, ma le CONTA tutte.
 *
 * I due numeri sono separati apposta. Fermare anche il conteggio al cap
 * renderebbe silenziosa proprio la troncatura che il contatore deve dichiarare
 * («+N occorrenze»), e il conteggio è la parte economica — costruire un Hit
 * significa costruire un estratto, scorrere la stringa no.
 *
 * `re` deve avere il flag `g` (lo garantisce buildMatcher).
 */
function scanBody(
  sessionId: string,
  body: MessageBody,
  re: RegExp,
  need: number,
): { hits: Hit[]; count: number } {
  const hits: Hit[] = [];
  let count = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body.text)) !== null) {
    count++;
    if (hits.length < need) {
      const start = m.index;
      const end = start + m[0].length;
      hits.push({
        sessionId,
        idx: body.idx,
        kind: body.kind,
        excerpt: excerptAround(body.text, start, end),
        matchStart: start,
        matchEnd: end,
        text: body.text,
      });
    }
    // Una regex può matchare la stringa vuota (`a*`, `^`): senza avanzare a
    // mano, `exec` resta fermo sullo stesso indice e il ciclo non termina mai.
    if (m[0].length === 0) re.lastIndex++;
  }
  return { hits, count };
}

/**
 * Cerca su tutte le sessioni passate.
 *
 * `hashPrefix` restringe a una conversazione per PREFISSO del sessionId, non per
 * uguaglianza: gli 8 char che la statusline mostra bastano a individuarla, e
 * nessuno copia un uuid intero a mano.
 */
export function searchSessions(
  sessions: Session[],
  hashPrefix: string,
  query: string,
  opts: SearchOptions,
): SearchResult {
  const prefix = hashPrefix.trim().toLowerCase();
  const scoped = prefix
    ? sessions.filter((s) => s.sessionId.toLowerCase().startsWith(prefix))
    : sessions;

  const { re, error } = buildMatcher(query, opts);
  if (error) return { ...EMPTY, idle: false, error };
  if (!re) return EMPTY;

  const groups: SessionHits[] = [];
  let shown = 0;
  let hidden = 0;

  for (const session of scoped) {
    const hits: Hit[] = [];
    let found = 0;
    for (const body of session.bodies) {
      if (!opts.kinds[body.kind]) continue;
      // Quanto ancora si può MATERIALIZZARE: il minore fra spazio nel gruppo e
      // spazio nella lista. A zero la scansione prosegue lo stesso — serve il
      // conteggio, che è ciò che alimenta «+N occorrenze».
      const need = Math.max(
        0,
        Math.min(MAX_HITS_PER_SESSION - hits.length, MAX_TOTAL_HITS - shown - hits.length),
      );
      const r = scanBody(session.sessionId, body, re, need);
      found += r.count;
      hits.push(...r.hits);
    }
    if (found === 0) continue;
    hidden += found - hits.length;
    if (hits.length === 0) continue; // tutte tagliate dal cap globale
    groups.push({ session, hits, hidden: found - hits.length });
    shown += hits.length;
  }

  return { groups, shown, hidden, sessionCount: groups.length, error: '', idle: false };
}

// ── Righe della lista ───────────────────────────────────────────────────────
//
// La lista mescola DUE tipi di riga e `⏎` fa cose diverse sui due (sessione →
// spawn resume, occorrenza → reader). La selezione va quindi keyed su una chiave
// che porti dentro anche il TIPO: un indice posizionale, o una chiave che
// distingua solo la sessione, farebbe partire l'azione sbagliata dopo che la
// lista si è riordinata sotto — e si riordina a ogni carattere digitato.

export type SearchRow =
  | { kind: 'session'; key: string; session: Session; hitCount: number; hidden: number }
  | { kind: 'hit'; key: string; hit: Hit };

/** Chiave discriminata di una riga-occorrenza. `matchStart` è nella chiave
 *  perché due match nello stesso record sono righe distinte. */
function hitKey(h: Hit): string {
  return `hit:${h.sessionId}:${h.idx}:${h.kind}:${h.matchStart}`;
}

/**
 * Appiattisce i gruppi in righe.
 *
 * Con `hashPrefix` valorizzato la lista è PIATTA: la conversazione è una sola e
 * già nominata nel campo hash, quindi la riga-sessione ripeterebbe un dato
 * costante rubando una riga per gruppo.
 */
export function buildRows(result: SearchResult, flat: boolean): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const g of result.groups) {
    if (!flat) {
      rows.push({
        kind: 'session',
        key: `sess:${g.session.sessionId}`,
        session: g.session,
        hitCount: g.hits.length,
        hidden: g.hidden,
      });
    }
    for (const h of g.hits) rows.push({ kind: 'hit', key: hitKey(h), hit: h });
  }
  return rows;
}

/** Prima riga selezionabile; null = lista vuota. Ogni riga è selezionabile —
 *  non esiste un separatore, a differenza di `session-list.ts`. */
export function firstRowKey(rows: SearchRow[]): string | null {
  return rows[0]?.key ?? null;
}

/** Indice della riga con quella chiave; -1 se assente. */
export function rowIndexOfKey(rows: SearchRow[], key: string | null): number {
  if (key === null) return -1;
  return rows.findIndex((r) => r.key === key);
}

/** Sposta la selezione di `delta` righe. Chiave persa (la lista è cambiata sotto)
 *  → prima riga; lista vuota → null. */
export function moveRowSelection(
  rows: SearchRow[],
  currentKey: string | null,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const cur = rowIndexOfKey(rows, currentKey);
  if (cur < 0) return rows[0].key;
  return rows[Math.max(0, Math.min(rows.length - 1, cur + delta))].key;
}

/** Riga selezionata, o null. */
export function selectedRow(rows: SearchRow[], key: string | null): SearchRow | null {
  if (key === null) return null;
  return rows.find((r) => r.key === key) ?? null;
}
