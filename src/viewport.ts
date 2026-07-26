// Budget d'altezza del frame — il deck non deve MAI renderizzare più righe di
// quante ne ha il terminale.
//
// Perché: quando `outputHeight >= stdout.rows`, Ink (ink/build/ink.js:121)
// abbandona il diff incrementale e passa a `clearTerminal + write` a ogni
// frame. Su VTE/Ptyxis `clearTerminal` non distrugge il contenuto: lo spinge
// nello scrollback. Col poll del deck che ridisegna ogni POLL_MS, ogni tick
// deposita un frame intero nella cronologia — da lì le righe-fantasma di
// bordi vuoti sopra l'header.
//
// Il fix non è cosmetico: è tenere il frame sotto `rows`, sempre. Tutto ciò
// che è a lunghezza variabile (lista task, lista sessioni, descrizione del
// dettaglio) passa da qui e riceve una capienza in righe.
//
// Logica pura, zero React/Ink: testabile senza pseudo-terminale.

import stringWidth from 'string-width';

/** Variation Selector-16: forza la presentazione emoji del carattere che precede. */
const VS16 = '️';

/**
 * Riallinea la larghezza dei glifi fra Ink e il terminale.
 *
 * Secondo meccanismo di sporcamento dello scrollback, indipendente dal budget
 * d'altezza. Ink assembla ogni riga su una griglia di CARATTERI: per un emoji
 * BMP senza VS16 (`☕` U+2615, `✔` U+2714, `⚡` U+26A1, `✅` U+2705, `▶` U+25B6)
 * riserva una sola posizione, mentre il terminale ne disegna due. La riga esce
 * larga `columns + 1`, il terminale la manda a capo, e l'altezza reale supera
 * quella che Ink crede — senza mai passare dal ramo `clearTerminal`. Con più
 * glifi sulla stessa riga l'eccesso si somma.
 *
 * Il VS16 esplicito fa contare 2 anche a Ink, riallineando le due contabilità.
 *
 * Il predicato è la LARGHEZZA MISURATA, non l'intervallo di codepoint: nello
 * stesso blocco U+2190–U+2BFF vivono anche `↓` `↑` `−`, larghi 1, e timbrarli
 * col VS16 li porterebbe a 2 accorciando la riga — l'errore opposto, con lo
 * stesso effetto di layout rotto. Gli astrali (U+1F000+) Ink li conta già bene.
 *
 * Idempotente: un glifo che ha già il VS16 non viene ri-timbrato.
 */
export function normalizeEmoji(s: string): string {
  if (!s) return s;
  const cps = [...s];
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    out += ch;
    const cp = ch.codePointAt(0)!;
    if (cp < 0x10000 && stringWidth(ch) === 2 && cps[i + 1] !== VS16) out += VS16;
  }
  return out;
}

/**
 * Collassa gli spazi (description multi-paragrafo → blocco unico) e tronca a
 * `n` caratteri, con ellissi quando taglia.
 *
 * Vive qui e non nel modulo di render perché è misura di larghezza come il
 * resto del file, e perché la cascata dell'etichetta di riga (`session-list.ts`)
 * ne ha bisogno restando pura — importarla da `cli.tsx` tirerebbe dentro Ink e
 * React in un modulo che si testa senza terminale.
 */
export function truncate(s: string, n: number): string {
  // Budget non positivo → stringa vuota, e va detto ESPLICITAMENTE: senza questa
  // guardia `n = 0` produce `slice(0, -1)`, e un indice negativo in JS conta
  // dalla FINE — restituirebbe quasi tutta la stringa invece di niente, cioè
  // l'opposto del troncamento, in silenzio e proprio quando lo spazio manca.
  if (n <= 0) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + '…' : flat;
}

/** Righe lasciate libere sotto il frame. La condizione di Ink è `>=`, quindi
 *  basterebbe 1; ne teniamo 1 come margine per l'a-capo del cursore. */
export const SLACK = 1;

/** Sotto questa soglia la lista task non è più utilizzabile: meglio sacrificare
 *  il pannello di dettaglio che ridurre la lista a due righe. */
const MIN_TASK_ROWS = 3;

/** Il dettaglio è secondario: non si prende mai più di così, anche con spazio. */
const MAX_DETAIL_LINES = 4;

/** Righe di "cornice" fisse dei tre contenitori a lunghezza variabile. */
const TASKS_PANE_CHROME = 5; // 2 bordi + header "Tasks (n)" + riga sort + riga spot
const SESSIONS_PANE_CHROME = 3; // 2 bordi + header "Sessions · …"
const DETAIL_CHROME = 3; // marginTop + 2 bordi

/** Detail pane sessione (T49): righe fisse = titolo + riga meta (size · turni ·
 *  ultima attività). Le preview (primo prompt + ultima risposta) sono variabili,
 *  ciascuna al più MAX_SESSION_PREVIEW righe. */
const SESSION_DETAIL_FIXED = 2;
const MAX_SESSION_PREVIEW = 2;
/** Gemello di MIN_TASK_ROWS: sotto questa soglia la lista sessioni non serve
 *  più — meglio sacrificare il detail pane. */
const MIN_SESSION_ROWS = 3;

/** Altezza di ciascuna modale, marginTop incluso. In flusso, non in overlay:
 *  spingono giù i pane, quindi il loro costo va scalato dal budget. */
export const MODAL_HEIGHT = {
  normal: 0,
  create: 4, // marginTop + 2 bordi + 1 riga input
  note: 4, // T53 — gemello di create: marginTop + 2 bordi + 1 riga input
  sort: 5, // marginTop + 2 bordi + titolo + 1 riga catena
  filter: 6, // marginTop + 2 bordi + titolo + 2 righe (pri, stato)
  edit: 8, // marginTop + 2 bordi + titolo + 3 campi + riga anteprima
  // T52 — search e reader sono gli unici modali NON in flusso: sostituiscono i
  // due pane invece di spingerli giù (una lista di occorrenze non entra in un
  // box sopra il deck). Costo 0 nel budget dei pane perché quel budget non
  // viene nemmeno calcolato: il render esce prima. La loro altezza la
  // distribuiscono `searchListCapacity`/`readerCapacity`.
  search: 0,
  reader: 0,
} as const;

export type Mode = keyof typeof MODAL_HEIGHT;

export type Budget = {
  /** Task renderizzabili nella finestra scorrevole. */
  taskRows: number;
  /** Sessioni renderizzabili. */
  sessionRows: number;
  /** Righe di descrizione nel pannello dettaglio; 0 = pannello omesso. */
  detailLines: number;
  /** Detail pane sessione (T49): richiesto E con spazio; false = omesso. */
  sessionDetail: boolean;
  /** Righe di preview del PRIMO prompt concesse al detail pane sessione. */
  sessionFirstLines: number;
  /** Righe di preview dell'ULTIMA risposta del modello. */
  sessionLastLines: number;
  /**
   * Il terminale non ospita nemmeno la cornice a righe zero: il layout a box va
   * abbandonato per una riga singola. Non è un caso di lusso — un terminale
   * basso è proprio la condizione in cui il ramo `clearTerminal` scatta, quindi
   * qui il fallback è il fix, non una comodità.
   */
  compact: boolean;
};

export type BudgetInput = {
  /** `stdout.rows`. Valore falsy (non-TTY, spawn prima del SIGWINCH) → 24. */
  rows: number;
  mode: Mode;
  /** Riga della legenda launch, presente solo in mode `normal` con voci. */
  launchLine: boolean;
  /** Riga di note in fondo al frame. */
  noteLine: boolean;
  /** Il pannello dettaglio è richiesto (task selezionata con task file). */
  hasDetail: boolean;
  /** Righe non-wrappabili del dettaglio: titolo + meta + commit. */
  detailMetaLines: number;
  /** Detail pane sessione richiesto (focus sessions + sessione selezionata). */
  hasSessionDetail: boolean;
  /** La sessione selezionata ha un titolo custom → la preview del primo prompt
   *  aggiunge info (senza, titolo === primo prompt e la riga duplicherebbe). */
  sessionHasFirstPreview: boolean;
  /** La sessione selezionata ha un'ultima risposta del modello da mostrare. */
  sessionHasLastPreview: boolean;
};

/**
 * Distribuisce le righe disponibili fra lista task, lista sessioni e dettaglio.
 *
 * I due pane stanno affiancati (flexDirection row) → l'altezza del blocco è il
 * MAX delle due colonne, non la somma: ognuna riceve lo stesso tetto.
 *
 * Ordine di sacrificio quando lo spazio stringe:
 *   1. righe di descrizione del dettaglio (fino a sparire col pannello),
 *   2. righe della lista task, mai sotto MIN_TASK_ROWS finché il dettaglio c'è.
 */
export function layoutBudget(input: BudgetInput): Budget {
  const outerChrome =
    2 + // bordi del box esterno
    1 + // titolo "loom-deck"
    1 + // riga navigazione
    (input.launchLine ? 1 : 0) +
    MODAL_HEIGHT[input.mode] +
    1 + // marginTop del blocco pane
    (input.noteLine ? 1 : 0);

  // Tetto per colonna: righe che restano ai due pane affiancati.
  const avail = (input.rows || 24) - SLACK - outerChrome;

  // La cornice del pane task (bordi + 3 header) più ALMENO una riga di lista.
  // Il `+1` non è cosmetico: senza, un terminale bassissimo produce un pane
  // regolamentare con zero task dentro — occupa 5 righe per non mostrare nulla,
  // mentre la riga compatta dice le stesse cose in una.
  if (avail < TASKS_PANE_CHROME + 1) {
    return {
      taskRows: 0,
      sessionRows: 0,
      detailLines: 0,
      sessionDetail: false,
      sessionFirstLines: 0,
      sessionLastLines: 0,
      compact: true,
    };
  }

  // Detail pane sessione (T49): stesso schema del dettaglio task — prima la
  // lista minima, poi la cornice, le preview solo con lo spazio che avanza.
  // A differenza del dettaglio task il box regge anche senza righe variabili:
  // titolo + meta sono il valore, le preview (primo prompt + ultima risposta)
  // sono bonus. Priorità al primo prompt, poi l'ultima risposta prende ciò che
  // resta: su terminale stretto cade prima l'ultima risposta, non il primo.
  // Riservo righe solo per le preview che davvero renderizzeranno (i due
  // `has…Preview`), così non sottraggo righe alla lista per un blocco vuoto.
  let sessionDetail = false;
  let sessionDetailCost = 0;
  let sessionFirstLines = 0;
  let sessionLastLines = 0;
  if (input.hasSessionDetail) {
    const fixed = DETAIL_CHROME + SESSION_DETAIL_FIXED;
    const spare = avail - SESSIONS_PANE_CHROME - MIN_SESSION_ROWS - fixed;
    if (spare >= 0) {
      sessionDetail = true;
      if (input.sessionHasFirstPreview) sessionFirstLines = Math.min(MAX_SESSION_PREVIEW, spare);
      if (input.sessionHasLastPreview) {
        sessionLastLines = Math.min(MAX_SESSION_PREVIEW, spare - sessionFirstLines);
      }
      sessionDetailCost = fixed + sessionFirstLines + sessionLastLines;
    }
  }

  const sessionRows = Math.max(0, avail - SESSIONS_PANE_CHROME - sessionDetailCost);

  let detailLines = 0;
  let detailChrome = 0;
  if (input.hasDetail) {
    const fixed = DETAIL_CHROME + input.detailMetaLines;
    // Righe che avanzano dopo aver garantito la lista minima e la cornice del
    // dettaglio. Serve almeno 1 riga di descrizione per giustificare il box:
    // un pannello con la sola cornice ruberebbe 3+ righe per mostrare nulla.
    const spare = avail - TASKS_PANE_CHROME - MIN_TASK_ROWS - fixed;
    if (spare >= 1) {
      detailChrome = fixed;
      detailLines = Math.min(MAX_DETAIL_LINES, spare);
    }
  }

  const taskRows = Math.max(0, avail - TASKS_PANE_CHROME - detailChrome - detailLines);

  return {
    taskRows,
    sessionRows,
    detailLines,
    sessionDetail,
    sessionFirstLines,
    sessionLastLines,
    compact: false,
  };
}

// T52 — cornice fissa della schermata di ricerca. Stesso vincolo del deck
// normale (il frame non deve superare `rows`), contabilità separata perché la
// schermata è sostitutiva, non additiva.
//
//   2  bordi del box esterno
//   1  titolo "loom-deck"
//   1  riga hint/legenda tasti
//   1  marginTop del box query
//   2  bordi del box query
//   3  righe del box query: hash · chiave · toggle
//   1  marginTop del box lista
//   2  bordi del box lista
//   1  header della lista (conteggi)
const SEARCH_CHROME = 14;

/** Righe di lista occorrenze che entrano nel terminale. Zero = la cornice non
 *  ci sta nemmeno vuota → la schermata va sostituita (vedi `isCompact`). */
export function searchListCapacity(rows: number, noteLine: boolean): number {
  return Math.max(0, (rows || 24) - SLACK - SEARCH_CHROME - (noteLine ? 1 : 0));
}

// T52 — cornice del reader fullscreen.
//   2  bordi del box esterno
//   1  titolo "loom-deck"
//   1  riga meta (sessione · record · tipo · posizione)
//   1  riga hint
//   1  marginTop del box corpo
//   2  bordi del box corpo
const READER_CHROME = 8;

/** Righe di testo del messaggio che entrano nel terminale. */
export function readerCapacity(rows: number): number {
  return Math.max(0, (rows || 24) - SLACK - READER_CHROME);
}

// T52 — cornice del pannello di anteprima sotto la lista occorrenze:
// marginTop + 2 bordi + riga meta.
const SEARCH_PREVIEW_CHROME = 4;

/**
 * Righe di contesto concesse all'anteprima dell'occorrenza selezionata.
 *
 * Prende SOLO ciò che avanza: la lista si dimensiona sul contenuto e, quando i
 * risultati sono pochi, il resto del terminale resterebbe vuoto. Con molti
 * risultati lo spazio torna alla lista e il pannello sparisce da sé — la
 * priorità è vedere quante più occorrenze possibile, il contesto è il premio
 * per una ricerca già stretta.
 *
 * Restituisce 0 quando non c'è spazio nemmeno per una riga utile: un pannello
 * di sola cornice ruberebbe 4 righe per non mostrare nulla.
 */
export function searchPreviewCapacity(capacity: number, listRows: number): number {
  return Math.max(0, capacity - listRows - SEARCH_PREVIEW_CHROME);
}

/**
 * Il terminale non ospita nemmeno la cornice della schermata: va sostituita da
 * una riga singola, come fa `Budget.compact` per il deck.
 *
 * Non è una comodità estetica ed è lo stesso ragionamento del layout a box: un
 * frame più alto di `rows` fa cadere Ink nel ramo `clearTerminal`, che su
 * VTE/Ptyxis riversa ogni redraw nello scrollback. Un terminale basso è proprio
 * la condizione che innesca quel ramo, quindi qui il fallback È il fix.
 */
export function isCompact(capacity: number): boolean {
  return capacity < 1;
}

/** Riga wrappata che sa da dove viene: `start`/`end` sono offset nel testo
 *  SORGENTE, e servono a evidenziare il match a cavallo dell'a-capo. */
export interface WrappedLine {
  text: string;
  start: number;
  end: number;
}

/**
 * A-capo che PRESERVA la struttura del testo e traccia gli offset.
 *
 * Distinto da `wrapLines`, che collassa tutto in un flusso unico: lì serviva una
 * preview compatta di 2-4 righe, qui si legge un messaggio intero — appiattire
 * le newline renderebbe illeggibile qualunque blocco di codice o elenco.
 *
 * Ogni riga prodotta è una FETTA CONTIGUA del sorgente: è ciò che permette di
 * intersecarla con l'intervallo del match e colorare solo la parte giusta,
 * anche quando il match cade a cavallo di due righe.
 *
 * Taglia sull'ultimo spazio disponibile; una parola più larga della riga viene
 * spezzata a forza, altrimenti l'a-capo lo farebbe il terminale — fuori dal
 * conteggio delle righe, cioè di nuovo un frame più alto di `rows`.
 */
export function wrapWithOffsets(text: string, width: number): WrappedLine[] {
  const out: WrappedLine[] = [];
  if (width <= 0) return out;

  let base = 0;
  for (const raw of text.split('\n')) {
    // Tab e CR diventano UN singolo spazio, non quattro: la sostituzione deve
    // conservare la lunghezza, o gli offset delle righe smettono di indicizzare
    // il sorgente e il match verrebbe evidenziato spostato. Un tab lasciato
    // passare sarebbe l'errore opposto — lo conteremmo 1 e il terminale 8.
    const line = raw.replace(/[\t\r]/g, ' ');
    if (line.length === 0) {
      out.push({ text: '', start: base, end: base });
    }
    let pos = 0;
    while (pos < line.length) {
      if (line.length - pos <= width) {
        out.push({ text: line.slice(pos), start: base + pos, end: base + line.length });
        break;
      }
      let brk = line.lastIndexOf(' ', pos + width);
      if (brk <= pos) brk = pos + width; // parola più lunga della riga
      out.push({ text: line.slice(pos, brk), start: base + pos, end: base + brk });
      pos = brk;
      while (line[pos] === ' ') pos++; // lo spazio del taglio non apre la riga dopo
    }
    base += raw.length + 1; // +1 = il '\n' consumato dallo split
  }
  return out;
}

/**
 * Finestra scorrevole su una lista più lunga della capienza.
 *
 * Centra la selezione, poi clampa ai bordi — così in cima e in fondo alla lista
 * la finestra non spreca righe fuori dai dati.
 *
 * `selected` è l'indice nella lista completa; -1 (o fuori range) = nessuna
 * selezione, la finestra parte da capo.
 */
export function windowRange(
  total: number,
  selected: number,
  capacity: number,
): { start: number; end: number } {
  if (capacity <= 0 || total <= 0) return { start: 0, end: 0 };
  if (total <= capacity) return { start: 0, end: total };

  const sel = selected >= 0 && selected < total ? selected : 0;
  const start = Math.max(0, Math.min(sel - Math.floor(capacity / 2), total - capacity));
  return { start, end: start + capacity };
}

/**
 * Hard-wrap a larghezza fissa, con tetto di righe.
 *
 * Serve un conteggio righe DETERMINISTICO: `<Text wrap="wrap">` di Ink wrappa a
 * runtime su una larghezza che il budget non conosce, quindi il pannello
 * dettaglio potrebbe sforare il tetto e riaprire il bug. Qui il testo viene
 * spezzato prima, e ogni riga è renderizzata con `wrap="truncate-end"`.
 *
 * Sottostimare `width` è sicuro (tronca prima), sovrastimarlo no (la riga
 * andrebbe a capo aggiungendo altezza non contabilizzata).
 */
export function wrapLines(text: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0 || width <= 0) return [];
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];

  const lines: string[] = [];
  let line = '';
  for (const word of flat.split(' ')) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
    // Parola più lunga della riga: spezzala a forza, altrimenti l'a-capo lo
    // farebbe il terminale — fuori dal nostro conteggio.
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
      if (lines.length === maxLines) break;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  const kept = lines.slice(0, maxLines);
  // Troncamento MAI silenzioso, come le liste: l'ellissi segnala che il testo
  // continua oltre il pannello.
  const consumed = kept.join(' ').length;
  if (consumed < flat.length && kept.length > 0) {
    const last = kept[kept.length - 1]!;
    kept[kept.length - 1] = last.length >= width ? last.slice(0, Math.max(0, width - 1)) + '…' : last + '…';
  }
  return kept;
}
