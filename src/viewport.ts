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
  sort: 5, // marginTop + 2 bordi + titolo + 1 riga catena
  filter: 6, // marginTop + 2 bordi + titolo + 2 righe (pri, stato)
  edit: 8, // marginTop + 2 bordi + titolo + 3 campi + riga anteprima
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
