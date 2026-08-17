// Funzioni pure di LARGHEZZA e di manipolazione testo che i componenti di vista
// consumano. Stanno insieme perché condividono un'unica invariante: la cornice
// da scalare va tolta in un posto solo, o due chiamanti tolgono cose diverse
// dalla stessa larghezza e il bordo viene mangiato.
import { stripProjectCore } from './session-list.js';
import type { Session } from './sessions.js';

export type EditRow = 0 | 1 | 2 | 3;
export const EDIT_ROWS = 4;

/** Le righe del modale edit che sono campi di TESTO (il resto è scelta ←→). */
export function isTextRow(r: EditRow): r is 2 | 3 {
  return r === 2 || r === 3;
}

/** Chiave della bozza scritta dalla riga di testo `r`. */
export function editField(r: 2 | 3): 'detail' | 'title' {
  return r === 2 ? 'detail' : 'title';
}

/**
 * Lunghezza in CODE POINT. Il caret ci indicizza sopra: `.length` conterebbe le
 * code unit UTF-16 e un'emoji nel titolo varrebbe 2 posizioni, cioè un cursore
 * che si ferma a metà glifo e un `slice` che lo spezza in due surrogati.
 */
export function cpLen(s: string): number {
  return [...s].length;
}

/** Inserisce `ins` alla posizione `at` (code point). */
export function insertAt(s: string, at: number, ins: string): string {
  const cp = [...s];
  return cp.slice(0, at).join('') + ins + cp.slice(at).join('');
}

/** Toglie il code point in posizione `at`; fuori range = stringa invariata. */
export function removeAt(s: string, at: number): string {
  const cp = [...s];
  if (at < 0 || at >= cp.length) return s;
  cp.splice(at, 1);
  return cp.join('');
}

export function isDone(prog: string): boolean {
  return prog.includes('✔');
}

/**
 * Larghezza dell'estratto, DERIVATA dalle colonne del terminale.
 *
 * Una costante qui è spazio buttato a ogni riga: su un terminale a 190 colonne
 * un estratto fisso a 50 lascia il match con ~20 caratteri di contesto per lato
 * quando potrebbe averne 80 — e il contesto attorno al match è l'unica ragione
 * per cui si legge la riga invece di aprire il reader.
 *
 * Scomposizione delle colonne consumate dalla cornice e dal prefisso di riga:
 *   4  box esterno (2 bordi + 2 padding)
 *   4  box lista   (2 bordi + 2 padding)
 *   2  caret
 *   4  indice del record
 *   4  spazio + tag del kind (2 caratteri) + spazio
 * Prudente per costruzione: sottostimare tronca un carattere in più,
 * sovrastimare manderebbe la riga a capo e sfonderebbe il budget d'altezza.
 */
export function searchExcerptWidth(columns: number): number {
  return Math.max(30, (columns || 80) - 18);
}

/** Titolo della conversazione sulla riga-gruppo: prende ciò che avanza dopo le
 *  colonne a larghezza fissa (caret, pin, hash, task, conteggio, data). */
export function searchTitleWidth(columns: number): number {
  return Math.max(24, (columns || 80) - 56);
}

/**
 * Cosa scrivere sulla riga-gruppo per distinguere una conversazione dall'altra.
 *
 * Non basta `session.title`: quel titolo è la label della tab Ptyxis, cioè
 * `<emoji> <name>` più un eventuale suffisso. Su una lista tutta dello
 * stesso progetto (D3) è una COLONNA COSTANTE — tre righe su quattro
 * identiche, che è esattamente il difetto che la riga-gruppo doveva evitare.
 *
 * Si toglie quindi il core `<name>` con tutto ciò che lo precede (noto dal file
 * config), e se ciò
 * che resta è vuoto o duplica la task già mostrata nella sua colonna, si
 * ripiega sul primo prompt — l'unica cosa che davvero identifica quella
 * conversazione e non un'altra.
 */
export function conversationLabel(s: Session, core: string | null, bound: string | undefined): string {
  let t = stripProjectCore(s.title, core);
  if (bound && t === bound) t = '';
  return t || s.firstPrompt || '(senza titolo)';
}

/**
 * Larghezza del testo dentro la lista della schermata di assegnazione: box
 * esterno (2 bordi + 2 padding) + box lista (2 bordi + 2 padding).
 *
 * Invariante ③ (`width.ts`): il taglio lo fa il chiamante. Delegarlo a
 * `wrap="truncate-end"` passerebbe da `cli-truncate`, che restituisce una riga
 * più larga di quella chiesta di una colonna per emoji — e quelle colonne
 * finiscono sopra il bordo, che sparisce dalla riga.
 */
export function assignTextWidth(columns: number): number {
  return Math.max(20, (columns || 80) - 8);
}


/**
 * T70 — larghezza utile del testo dentro il blocco preview, che è a PIENA
 * larghezza: box esterno (2 bordi + 2 padding) → box preview (2 bordi + 2
 * padding). Niente più `/2`: il blocco non vive più dentro un pane al 50%,
 * quindi una riga di descrizione dispone del doppio delle colonne.
 *
 * Volutamente prudente: sottostimare tronca qualche carattere in più,
 * sovrastimare farebbe andare a capo una riga e sforare il tetto d'altezza.
 */
export function previewTextWidth(columns: number) {
  return Math.max(10, (columns || 80) - 8);
}

/**
 * Larghezza del TESTO dentro un pane al 50%: box esterno (2 bordi + 2 padding)
 * → metà → bordo + padding del pane.
 *
 * Invariante ③ (`width.ts`): chi renderizza una riga a lunghezza libera la
 * taglia PRIMA con questa larghezza. Delegarlo a `wrap="truncate-end"`
 * significa passare da `cli-truncate`, che indicizza per code point e restituisce
 * una riga più larga di quella chiesta — una colonna per ogni emoji astrale a
 * sinistra del taglio. Quelle colonne finiscono sopra il bordo del pane, che
 * sparisce dalla riga: è la sminchiatura visibile a schermo.
 */
export function paneTextWidth(columns: number) {
  return Math.max(20, Math.floor(((columns || 80) - 4) / 2) - 4);
}

