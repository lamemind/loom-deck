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
  edit: 9, // marginTop + 2 bordi + titolo + 4 campi (pri, stato, prog, titolo) + riga anteprima
  // T52 — search e reader sono gli unici modali NON in flusso: sostituiscono i
  // due pane invece di spingerli giù (una lista di occorrenze non entra in un
  // box sopra il deck). Costo 0 nel budget dei pane perché quel budget non
  // viene nemmeno calcolato: il render esce prima. La loro altezza la
  // distribuiscono `searchListCapacity`/`readerCapacity`.
  search: 0,
  reader: 0,
  // T57 — assign è la terza schermata sostitutiva, per la stessa ragione della
  // ricerca: la lista task non entra in un box sopra i due pane, e in flusso
  // pagherebbe due volte (il suo costo + quello che toglie ai pane sotto, che
  // in quel momento non si stanno nemmeno guardando).
  assign: 0,
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

// T57 — cornice della schermata di assegnazione. Gemella di SEARCH_CHROME, con
// un box filtro di UNA riga invece di tre.
//
//   2  bordi del box esterno
//   1  titolo "loom-deck"
//   1  riga hint/legenda tasti
//   1  marginTop del box filtro
//   2  bordi del box filtro
//   1  riga del filtro
//   1  marginTop del box lista
//   2  bordi del box lista
//   1  header della lista (conteggi + escluse dai filtri)
const ASSIGN_CHROME = 12;

/** Righe di lista task che entrano nel terminale. Zero = nemmeno la cornice ci
 *  sta → schermata sostituita dalla riga compatta (`isCompact`). */
export function assignListCapacity(rows: number, noteLine: boolean): number {
  return Math.max(0, (rows || 24) - SLACK - ASSIGN_CHROME - (noteLine ? 1 : 0));
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

