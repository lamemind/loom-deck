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
 *  il blocco preview che ridurre la lista a due righe. */
const MIN_TASK_ROWS = 3;

/** La preview è secondaria: non si prende mai più di così, anche con spazio.
 *  A piena larghezza (T70) una riga contiene il doppio del testo di prima,
 *  quindi il tetto sale insieme allo spazio: il blocco è uno solo e lo paga
 *  una volta sola per entrambi i pane. */
const MAX_DETAIL_LINES = 6;

/** Righe di "cornice" fisse dei contenitori a lunghezza variabile. */
// T59 — le righe meta sono DUE (`≡ tutte`, `○ spot`): ogni riga fissa aggiunta
// a un pane va scalata qui, o il frame sfonda `rows` e Ink passa a
// clearTerminal (frame-fantasma nello scrollback di VTE).
const TASKS_PANE_CHROME = 6; // 2 bordi + header "Tasks (n)" + riga sort + 2 righe meta
const SESSIONS_PANE_CHROME = 3; // 2 bordi + header "Sessions · …"
const PREVIEW_CHROME = 3; // marginTop + 2 bordi

/** Preview sessione: righe fisse = titolo + riga meta (size · turni · ultima
 *  attività · branch). Le due anteprime (primo prompt + ultima risposta) sono
 *  variabili, ciascuna al più MAX_SESSION_PREVIEW righe. */
const SESSION_DETAIL_FIXED = 2;
const MAX_SESSION_PREVIEW = 3;

/** Altezza di ciascuna modale, marginTop incluso. In flusso, non in overlay:
 *  spingono giù i pane, quindi il loro costo va scalato dal budget. */
export const MODAL_HEIGHT = {
  normal: 0,
  create: 4, // marginTop + 2 bordi + 1 riga input
  note: 4, // T53 — gemello di create: marginTop + 2 bordi + 1 riga input
  sort: 5, // marginTop + 2 bordi + titolo + 1 riga catena
  filter: 6, // marginTop + 2 bordi + titolo + 2 righe (pri, stato)
  edit: 9, // marginTop + 2 bordi + titolo + 4 campi (pri, stato, prog, titolo) + riga anteprima
  // T112 — conferma di eliminazione: marginTop + 2 bordi + 4 righe di contenuto
  // (titolo, elenco ID, effetto sul disco, riga di stato del bersaglio).
  // Le quattro righe sono FISSE, non condizionali: la quarta ospita tanto gli
  // scarti del bulk quanto la scelta keep/purge della singola task sporca, e due
  // condizionali mutuamente esclusivi obbligherebbero il budget a sapere QUALE
  // dei due è a schermo (stessa ragione della riga nota in DETAIL_CHROME, T111).
  purge: 7,
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
  // T66 — il detail della task: task file scrollabile + barra azioni. Quarta
  // sostitutiva, stesso motivo delle altre tre — un task file da 200 righe non
  // entra in un box sopra i pane. La sua altezza la distribuisce
  // `detailCapacity`.
  detail: 0,
} as const;

export type Mode = keyof typeof MODAL_HEIGHT;

/**
 * Cosa mostra il blocco preview UNICO sotto i due pane (T70).
 *
 * Non è "quale pane ha il focus": è il contenuto che quel focus rende
 * disponibile. Con il focus sul pane task ma una riga meta selezionata (`≡
 * tutte`, `○ spot`) non c'è nessuna task da mostrare, e il blocco non esiste —
 * `none` è quindi uno stato pieno, non un fallback.
 */
export type PreviewKind = 'none' | 'task' | 'session';

export type Budget = {
  /** Task renderizzabili nella finestra scorrevole. */
  taskRows: number;
  /** Sessioni renderizzabili. */
  sessionRows: number;
  /** Il blocco preview è richiesto E ha spazio; false = omesso del tutto. */
  preview: boolean;
  /** Righe di descrizione della task nel blocco preview (kind `task`). */
  detailLines: number;
  /** Righe di anteprima del PRIMO prompt (kind `session`). */
  sessionFirstLines: number;
  /** Righe di anteprima dell'ULTIMA risposta del modello (kind `session`). */
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
  /** Contenuto del blocco preview sotto i pane; `none` = nessun blocco. */
  preview: PreviewKind;
  /** Righe non-wrappabili della preview task: titolo + meta + commit. */
  detailMetaLines: number;
  /** La sessione selezionata ha un titolo custom → l'anteprima del primo prompt
   *  aggiunge info (senza, titolo === primo prompt e la riga duplicherebbe). */
  sessionHasFirstPreview: boolean;
  /** La sessione selezionata ha un'ultima risposta del modello da mostrare. */
  sessionHasLastPreview: boolean;
};

/**
 * Distribuisce le righe disponibili fra lista task, lista sessioni e preview.
 *
 * I due pane stanno affiancati (flexDirection row) → l'altezza del blocco è il
 * MAX delle due colonne, non la somma: ognuna riceve lo stesso tetto.
 *
 * T70 — il blocco preview è UNO e sta SOTTO i due pane, non dentro uno di essi:
 * il suo costo esce quindi da `avail` PRIMA della distribuzione, e ciò che
 * resta va a entrambe le colonne. Con i due pannelli separati il costo gravava
 * su una colonna sola, e siccome l'altezza del blocco è il max delle due, il
 * pannello del pane meno alto era di fatto gratis: contabilità che qui non
 * esiste più.
 *
 * Ordine di sacrificio quando lo spazio stringe:
 *   1. righe variabili della preview (fino a sparire col blocco),
 *   2. righe delle liste, mai sotto MIN_TASK_ROWS finché la preview c'è.
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
      preview: false,
      detailLines: 0,
      sessionFirstLines: 0,
      sessionLastLines: 0,
      compact: true,
    };
  }

  // Pavimento sotto cui la preview non si concede: la lista minima del pane
  // TASK, cioè il più caro in cornice dei due. Garantito lui, il pane sessioni
  // (3 di cornice contro 6) sta comodo per costruzione — un secondo controllo
  // sul suo minimo sarebbe una condizione che non può mai scattare.
  const floor = TASKS_PANE_CHROME + MIN_TASK_ROWS;

  let preview = false;
  let previewCost = 0;
  let detailLines = 0;
  let sessionFirstLines = 0;
  let sessionLastLines = 0;

  if (input.preview === 'task') {
    const fixed = PREVIEW_CHROME + input.detailMetaLines;
    // Serve almeno 1 riga di descrizione per giustificare il blocco: titolo e
    // meta sono già nella riga di lista, quindi una cornice senza descrizione
    // ruberebbe righe alle liste per non aggiungere niente.
    const spare = avail - floor - fixed;
    if (spare >= 1) {
      preview = true;
      detailLines = Math.min(MAX_DETAIL_LINES, spare);
      previewCost = fixed + detailLines;
    }
  } else if (input.preview === 'session') {
    const fixed = PREVIEW_CHROME + SESSION_DETAIL_FIXED;
    const spare = avail - floor - fixed;
    // A differenza della task il blocco regge anche a zero righe variabili:
    // titolo e riga meta (size, turni, data, branch) non stanno da nessun'altra
    // parte a schermo, quindi sono già il valore. Priorità al primo prompt, poi
    // l'ultima risposta prende ciò che resta: quando lo spazio stringe cade
    // prima l'ultima risposta, non il primo prompt. Le righe si riservano solo
    // per le anteprime che davvero renderizzeranno (i due `has…Preview`), o si
    // toglierebbero righe alle liste per un blocco vuoto.
    if (spare >= 0) {
      preview = true;
      if (input.sessionHasFirstPreview) sessionFirstLines = Math.min(MAX_SESSION_PREVIEW, spare);
      if (input.sessionHasLastPreview) {
        sessionLastLines = Math.min(MAX_SESSION_PREVIEW, spare - sessionFirstLines);
      }
      previewCost = fixed + sessionFirstLines + sessionLastLines;
    }
  }

  // Ciò che resta va a ENTRAMBE le colonne: la preview sta sotto il blocco dei
  // pane, quindi il suo costo lo pagano insieme una volta sola.
  const listAvail = avail - previewCost;

  return {
    taskRows: Math.max(0, listAvail - TASKS_PANE_CHROME),
    sessionRows: Math.max(0, listAvail - SESSIONS_PANE_CHROME),
    preview,
    detailLines,
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

// T66 — cornice del detail della task.
//   2  bordi del box esterno
//   1  titolo "loom-deck"
//   1  riga meta (id · titolo · posizione nel testo)
//   1  riga hint
//   1  marginTop del box testo
//   2  bordi del box testo
//   1  marginTop dell'area di compilazione
//   1  riga azione   (T66)
//   1  riga prompt   (T117)
//   1  riga modello  (T108)
//   1  riga titolo   (T111)
//
// Le ultime cinque sono il motivo per cui il detail non può riusare
// READER_CHROME: le quattro righe dell'area di compilazione sono righe FISSE in
// più dentro l'overlay, e ogni riga fissa aggiunta va scalata dalla capienza del
// contenuto o il frame sfonda `rows` (stessa invariante di TASKS_PANE_CHROME).
//
// Sono fisse e non `extra` condizionali di `detailCapacity` (T111 · D1): due
// condizionali mutuamente esclusivi obbligherebbero il parametro a dire QUALE è
// a schermo — un solo booleano per entrambi sottostima quando quello aperto è il
// più alto, e sommarli toglie righe al testo per un campo che non c'è.
const DETAIL_CHROME = 13;

// T91 — la ricerca dentro il detail: marginTop + riga del campo.
//
// `MODAL_HEIGHT` dice che il detail costa 0 ai due pane (li sostituisce), e da
// lì è facile leggere «dentro l'overlay lo spazio è gratis». Le due contabilità
// sono distinte: quella dice quanto l'overlay toglie ai PANE, questa quanto
// toglie al PROPRIO contenuto. Una riga fissa aggiunta e non scalata è ciò che
// fa sfondare `rows` e manda Ink nel ramo `clearTerminal`, che su VTE riversa un
// frame nello scrollback a ogni tick del poll.
const DETAIL_SEARCH_CHROME = 2;

/** Righe di task file che entrano nel terminale; con la ricerca aperta il campo
 *  si paga qui, non altrove. */
export function detailCapacity(rows: number, searching = false): number {
  const extra = searching ? DETAIL_SEARCH_CHROME : 0;
  return Math.max(0, (rows || 24) - SLACK - DETAIL_CHROME - extra);
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

