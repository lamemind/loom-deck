/**
 * Ricerca dentro UN documento: occorrenze come offset del testo sorgente.
 *
 * Gemello di `search.ts` per il motore, opposto per forma. Lì il corpus è N
 * conversazioni, quindi il risultato raggruppa per sessione, cappa le occorrenze
 * e produce estratti; qui il corpus è una stringa sola e la risposta utile è la
 * posizione, non l'estratto — il testo è già a schermo.
 *
 * Gli offset sono quelli del SORGENTE, mai coordinate riga/colonna del testo
 * wrappato. Due proprietà ne discendono, ed è il motivo per cui il modulo esiste:
 *
 *  - **Immunità al re-wrap.** Un resize cambia larghezza e numero di righe ma non
 *    sposta un match, perché il sorgente non cambia. Coordinate «riga 42,
 *    colonna 7» andrebbero ricalcolate a ogni SIGWINCH.
 *  - **Match a cavallo dell'a-capo senza casi speciali.** Ogni riga di
 *    `wrapWithOffsets` è una fetta contigua del sorgente, quindi evidenziare è
 *    intersecare due intervalli — e un match spezzato su due righe si colora su
 *    entrambe perché entrambe intersecano.
 *
 * Puro: nessun Ink, nessun terminale, nessun filesystem.
 */
import { buildMatcher, type SearchOptions } from './search.js';
import type { WrappedLine } from './width.js';

/** Intervallo `[start, end)` nel testo sorgente. */
export interface Occurrence {
  start: number;
  end: number;
}

/** Le sole opzioni che hanno senso su un documento singolo: `kinds` seleziona
 *  quali corpi di conversazione indicizzare, e qui il corpo è uno solo. */
export type ScanOptions = Pick<SearchOptions, 'regex' | 'caseSensitive' | 'wholeWord'>;

export const LITERAL: ScanOptions = { regex: false, caseSensitive: false, wholeWord: false };

/**
 * Minimo di caratteri più basso di `MIN_QUERY`.
 *
 * Su N conversazioni una query di 2 caratteri produce migliaia di occorrenze
 * inutili, e la soglia a 3 protegge dall'indicizzazione a vuoto. Su un task file
 * `T7` o `⏎` sono query legittime e frequenti: la soglia lì non protegge da
 * niente, impedisce soltanto.
 */
export const MIN_DETAIL_QUERY = 1;

export interface ScanResult {
  occ: Occurrence[];
  /** Messaggio della regex invalida; '' se la query è valida o sotto il minimo. */
  error: string;
}

const EMPTY: ScanResult = { occ: [], error: '' };

/**
 * Tutte le occorrenze di `query` in `text`, in ordine di posizione.
 *
 * Il testo deve essere **la stessa stringa che si renderizza**: passa da
 * `sanitize` al confine di caricamento, e cercare su una rilettura del file
 * produrrebbe offset che indicizzano un documento diverso da quello a schermo —
 * evidenziazione spostata di N caratteri, senza nessun errore.
 */
export function scanText(text: string, query: string, opts: ScanOptions = LITERAL): ScanResult {
  const { re, error } = buildMatcher(query, opts, MIN_DETAIL_QUERY);
  if (!re) return error ? { occ: [], error } : EMPTY;

  const occ: Occurrence[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Una regex può matchare la STRINGA VUOTA (`a*`, `^`, `\b`): `exec` non
    // avanzerebbe `lastIndex` e il ciclo non terminerebbe mai. Un match di
    // larghezza zero non è nemmeno evidenziabile, quindi si salta invece di
    // registrarlo.
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    occ.push({ start: m.index, end: m.index + m[0].length });
  }
  return { occ, error };
}

/** Pezzo di riga da colorare o no. `current` distingue l'occorrenza su cui si è
 *  posizionati dalle altre visibili. */
export interface Segment {
  text: string;
  hit: boolean;
  current: boolean;
}

/**
 * Taglia una riga wrappata nei pezzi da colorare, intersecando gli offset.
 *
 * `occ` è in ordine e senza sovrapposizioni (`exec` avanza monotono), quindi
 * basta una passata. Il guard `a < pos` regge comunque il caso di intervalli
 * sovrapposti passati da un chiamante futuro, senza produrre testo duplicato.
 */
export function sliceLine(
  lineText: string,
  lineStart: number,
  occ: readonly Occurrence[],
  current: number,
): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (let i = 0; i < occ.length; i++) {
    const a = Math.max(0, Math.min(lineText.length, occ[i]!.start - lineStart));
    const b = Math.max(0, Math.min(lineText.length, occ[i]!.end - lineStart));
    if (b <= a || a < pos) continue;
    if (a > pos) out.push({ text: lineText.slice(pos, a), hit: false, current: false });
    out.push({ text: lineText.slice(a, b), hit: true, current: i === current });
    pos = b;
  }
  if (pos < lineText.length) {
    out.push({ text: lineText.slice(pos), hit: false, current: false });
  }
  return out;
}

/**
 * Scroll che porta l'offset al CENTRO della finestra visibile.
 *
 * Stessa ricetta di `submitSearchRow` (T52). Centrare conta più che sembri:
 * un'occorrenza portata in cima alla finestra arriva senza il contesto che la
 * precede, ed è il contesto che dice se è quella giusta.
 */
export function topForOffset(
  lines: readonly WrappedLine[],
  offset: number,
  capacity: number,
): number {
  const maxTop = Math.max(0, lines.length - capacity);
  let i = lines.findIndex((l) => l.end > offset);
  if (i < 0) i = Math.max(0, lines.length - 1);
  return Math.max(0, Math.min(maxTop, i - Math.floor(capacity / 2)));
}
