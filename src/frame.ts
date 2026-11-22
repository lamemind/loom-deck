// La GEOMETRIA di un frame del deck: cosa entra a schermo, dove, e quali righe
// sono cliccabili.
//
// Modulo PURO — nessun React, nessuno stato, nessun effetto. Prende le misure
// del terminale e le liste intere, restituisce il budget d'altezza, le finestre
// di rendering e la mappa dell'hit-test. Ne discende che è testabile a unità,
// che è la ragione principale per cui è uscito da `cli.tsx`: qui vive un'invariante
// che prima era affidata a un commento — le righe cliccabili devono essere
// esattamente quelle disegnate.
//
// T131 — l'ordine di calcolo è vincolante rispetto al cablaggio dell'input.
// `frameGeometry` va invocata PRIMA di `useDeckInput`, perché l'hook del mouse
// riceve `listGeometry` come valore e non più attraverso una closure che la
// leggeva dichiarata seicento righe più in basso. Il costo è calcolare il
// budget anche quando il render esce presto su una schermata sostitutiva:
// aritmetica su array già in memoria, e `layoutBudget` accetta ogni `Mode`.
import { headerItems, sessionHeaderParts, taskHeaderParts } from './pane-header.js';
import {
  FRAME_TEXT_COL,
  HEADER_ROW,
  HINT_ROW,
  inlineRegions,
  LAUNCH_ROW,
  PANE_TEXT_PAD,
  paneSpans,
  rowRegions,
  type ListGeometry,
  type Region,
  type Segment,
} from './mouse.js';
import { cellWidth, launchLegend, LAUNCH_SEP, type LaunchEntry } from './config.js';
import { layoutBudget, windowRange, type Budget, type PreviewKind } from './viewport.js';
import { cut, sanitize, termWidth } from './width.js';
import { MODEL_SHORT_LIST, WARN } from './glyphs.js';
import { META_ROWS, type Mode } from './model.js';
import type { SessionViewCounts, SessionViewId, TaskViewCounts, TaskViewId } from './pane-views.js';
import { rowIndexOf, type SessionRow } from './session-list.js';
import type { Task } from './tasks.js';
import { VERSION } from './version.js';
import { OFF_MARK } from './platform.js';

// La surface built-in del cappello, in testa alla riga launch. Non sta fra i
// tasti perché ha la stessa natura delle voci `launch` — fire-once, cwd =
// project root, nessuno stato. Per il terminale compass usa 🖥️, che nel frame
// Ink NON passa — `sanitize` lo sostituisce (VTE lo disegna largo 1,
// string-width dice 2: discordante, invariante ① di width.ts) e resterebbe un
// `·` muto. 💻 è il gemello concorde; il `sanitize` qui rende il vincolo
// automatico invece che da ricordare.
//
// T21 — `key` è il tasto che la superficie rappresenta: un click su di essa
// entra nell'handler di tastiera con quel tasto, invece di chiamare l'azione
// per conto proprio. È ciò che tiene click e tasto per costruzione allineati.
//
// T154/P9 — `c` non vive più qui: la surface trasloca a destra come etichetta
// del blocco selettore della nuda (`BARE_LABEL` sotto), adiacente ai bottoni
// col modello con cui apre invece che sull'estremo opposto della riga.
export const SURFACE_SEGMENTS: readonly Segment[] = [{ key: 't', text: sanitize('t 💻') }];

/**
 * Il corpo di un indicatore di testata prima della sua prima misura: lo dice
 * il gitlink. Una parola e non uno zero,
 * perché `0` direbbe «ho misurato e non c'è niente» — cioè la cosa sbagliata
 * (D2 di T134: `missing` e guasto sono stati distinti).
 */
export const STATUS_MISSING = 'missing';

// T154/P9 — l'etichetta del blocco selettore della nuda: unico segmento
// cliccabile del blocco (nessun tasto nomina un modello, `m` cicla e non
// seleziona — i bottoni non lo sono).
export const BARE_LABEL: Segment = { key: 'c', text: sanitize('c 🤖') };

// T154/D1 — i bottoni usano le SHORT (`fab`/`ops`/`son`/`hak`), non i nomi
// interi del selettore di resume/fork: la riga launch compete per spazio con
// la legenda delle voci custom, e le short sono già il vocabolario compatto
// che la colonna modello della lista sessioni usa per lo stesso motivo.
const BARE_BUTTONS_TEXT = MODEL_SHORT_LIST.map((s) => `[ ${s} ]`).join('  ');
/** Larghezza dei soli bottoni, in celle: passata come `avail` a
 *  `choiceButtons` — esattamente la larghezza naturale, così `cutParts` non
 *  taglia mai (il blocco è RISERVATO, D1/P8: a cedere sono le voci `launch`,
 *  mai il selettore). */
export const BARE_BUTTONS_WIDTH = termWidth(BARE_BUTTONS_TEXT);
/** Spazio fra l'etichetta `c 🤖` e il primo bottone. */
const BARE_LABEL_GAP = ' ';
/** Larghezza FISSA del blocco intero (etichetta + spazio + bottoni): non
 *  dipende da quale modello sia selezionato né dal default — ogni short è
 *  larga uguale (3 lettere) — quindi la geometria non ha bisogno di saperli;
 *  la STILATURA sì, e la fa il chiamante con `choiceButtons` sugli stessi
 *  valori (`MODEL_SHORT_LIST`). 39 celle con l'attuale `MODELS` a 4 voci
 *  (D1 preflight).
 */
const BARE_BLOCK_WIDTH =
  termWidth(BARE_LABEL.text) + termWidth(BARE_LABEL_GAP) + BARE_BUTTONS_WIDTH;

export type LaunchRow = {
  /** I segmenti di SINISTRA, nell'ordine in cui si disegnano: la surface `t`,
   *  poi le voci. Il blocco selettore della nuda non è fra questi (P9): sta a
   *  destra, ancorato al bordo, e la sua sola parte cliccabile (`BARE_LABEL`)
   *  entra in `regions` ma non in `segments`. */
  segments: Segment[];
  /** Le colonne cliccabili: quelle dei segmenti di sinistra più quella
   *  dell'etichetta del blocco a destra — non una regione per bottone, perché
   *  nessun tasto nomina un modello (`m` cicla, non seleziona). */
  regions: Region[];
  /** Voci che non entrano nella riga. */
  overflow: number;
  /** Voci oltre la nona, quindi senza un tasto-cifra che le raggiunga. */
  unreachable: number;
  /** T154/P5 — il riempimento fra i segmenti di sinistra e il blocco a destra,
   *  già calcolato in spazi: la riga resta un `<Text>` unico (un `Box
   *  space-between` con figli `Text` annidati non si stira alla larghezza del
   *  box, misurato su `IndicatorRow`), quindi l'ancoraggio a destra si ottiene
   *  inserendo questo riempimento nel testo, non con un layout a due colonne. */
  filler: string;
};

/**
 * T21 — la riga launch come DATO, non come stringa: gli stessi segmenti
 * compongono il testo renderizzato e le colonne dell'hit-test. Derivare le
 * seconde ri-splittando il primo sarebbe un conto parallelo, che diverge alla
 * prima label che contenga il separatore.
 *
 * Le celle della surface (più il ` · ` che la separa dalle voci) sono già spese
 * sulla riga → vanno riservate, o le voci launch la sfonderebbero di quel
 * tanto. T154/P8 — il blocco selettore della nuda entra nella STESSA riserva:
 * su un progetto con molte voci `launch` a cedere per prima è una voce custom,
 * mai il selettore (un bottone di modello troncato sarebbe indistinguibile da
 * un modello che non esiste, una voce launch resta raggiungibile col suo
 * tasto-cifra anche quando non è scritta in riga).
 */
export function launchRow(launch: LaunchEntry[], columns: number): LaunchRow {
  const surfaceLegend = SURFACE_SEGMENTS.map((s) => s.text).join(LAUNCH_SEP);
  const reserved = cellWidth(surfaceLegend) + cellWidth(LAUNCH_SEP) + BARE_BLOCK_WIDTH;
  const legend = launchLegend(launch, columns, reserved);
  // T168 — la chiave di ogni voce è la SUA cifra (`legend.digits`), non
  // `i + 1`: con le `key` pinnate la terza voce in riga può rispondere al `7`.
  const segments: Segment[] = [
    ...SURFACE_SEGMENTS,
    ...legend.taken.map((text, i) => ({ key: legend.digits[i]!, text })),
  ];
  // Larghezza REALE della sinistra, testo di overflow/irraggiungibili incluso:
  // sono loro a decidere quanto riempimento serve, non solo i segmenti.
  const leftWidth =
    termWidth(segments.map((s) => s.text).join(LAUNCH_SEP)) +
    (legend.overflow > 0 ? termWidth(` · +${legend.overflow} fuori riga`) : 0) +
    (legend.unreachable > 0 ? termWidth(unreachableText(legend.unreachable)) : 0);
  // T154/P5 — la formula dell'ancoraggio: colonne del bordo esterno, meno la
  // sinistra già disegnata, meno il blocco che deve starci per intero. Un
  // pavimento di 1 tiene sempre almeno uno spazio fra le due metà, invece di
  // farle toccare quando lo schermo è troppo stretto per il resto.
  const filler = ' '.repeat(Math.max(1, columns - 6 - leftWidth - BARE_BLOCK_WIDTH));
  const bareCol = FRAME_TEXT_COL + leftWidth + termWidth(filler);
  const bareRegion: Region = {
    key: BARE_LABEL.key,
    start: bareCol,
    end: bareCol + termWidth(BARE_LABEL.text) - 1,
  };
  return {
    segments,
    regions: [...rowRegions(segments, LAUNCH_SEP, FRAME_TEXT_COL), bareRegion],
    overflow: legend.overflow,
    unreachable: legend.unreachable,
    filler,
  };
}

/** T168 — il testo della coda per le voci in riga senza cifra: dieci slot, le
 *  voci oltre restano configurate e si lanciano dalla pagina `^L`. Una funzione
 *  perché lo misurano `launchRow` e lo disegna `cli.tsx`: due stringhe scritte a
 *  mano divergerebbero di una colonna. */
export function unreachableText(n: number): string {
  return ` · ${n} senza cifra (^L)`;
}

/**
 * T134 — gli INDICATORI ancorati a destra della riga legenda: dato, non
 * stringa, per la stessa ragione della riga launch (`launchRow`). Gli stessi
 * segmenti compongono il testo disegnato e le colonne dell'hit-test, e chi
 * derivasse le seconde ri-splittando il primo terrebbe due conti che divergono
 * alla prima etichetta che contiene il separatore.
 *
 * `key` è la COMBO che l'indicatore rappresenta, col prefisso `^`: il click non
 * chiama l'azione, rientra dalla porta della tastiera premendola. È lo stesso
 * schema delle superfici launch, esteso ai `ctrl` — senza il prefisso il click
 * sintetizzerebbe una lettera nuda, che su questa tastiera fa un'altra cosa.
 */
export const INDICATOR_SEP = '  ';

export type IndicatorRow = {
  segments: Segment[];
  /** I segmenti già uniti, nella forma che il render disegna. Una STRINGA
   *  PIATTA e non un albero di `Text` annidati: misurato sotto pty, Ink non
   *  stira alla larghezza del box un `Text` i cui figli sono altri `Text`, e la
   *  riga esce larga `columns - 1` — cioè col bordo mangiato. La testata
   *  (`space-between` con due figli a stringa piatta) non ne soffre, ed è la
   *  forma che questa riga adotta. Il prezzo è un colore solo per il blocco
   *  invece di uno per indicatore. */
  text: string;
  regions: Region[];
  /** Colonne occupate dal blocco intero, separatori compresi: la legenda a
   *  sinistra riceve il resto. Gli indicatori hanno la PRECEDENZA sul budget
   *  (D5 preflight) — `keyLegend` è già troncabile per costruzione e la sua
   *  perdita è recuperabile a memoria, mentre un contatore troncato mente. */
  width: number;
};

/**
 * T155 — l'indicatore del gitlink: `gitlink 2`.
 *
 * Conta i membri il cui checkout NON coincide col gitlink registrato, in
 * entrambi i versi (`disalignedCount` in `gitlink.ts`). Fuori dal numero restano
 * i membri che nessun bump sistema — non inizializzati, in conflitto — perché un
 * contatore che il tasto non può portare a zero smette di essere letto.
 *
 * Quattro corpi distinti: `missing` finché la
 * prima misura non è tornata, `?` quando lo script non è raggiungibile (plugin
 * non installato su questa macchina, o uscito male), il numero quando c'è
 * qualcosa da bumpare, `ok` quando tutti i membri coincidono.
 *
 * Il glifo di allerta si AGGIUNGE al corpo invece di sostituirlo, e copre i due
 * fatti che il numero non dice: l'ultimo bump è fallito, oppure un membro
 * richiede un gesto che il bump non fa. Entrambi restano veri accanto al
 * conteggio, e chi lo vede preme il tasto per leggere la riga di stato, che
 * nomina i membri.
 */
export function gitlinkIndicator(state: {
  count: number;
  attention: number;
  scanned: boolean;
  ok: boolean;
  /** L'ultimo bump si è fermato prima di committare. */
  failed: boolean;
  /** T175 — `false` = il progetto ha submodule ma lo script che li misura non
   *  gira su questa piattaforma. Il segmento resta, col marcatore al posto del
   *  valore: sparire direbbe «repo senza `.gitmodules`». */
  available?: boolean;
}): string {
  if (state.available === false) return `gitlink ${OFF_MARK}`;
  const body = !state.scanned
    ? STATUS_MISSING
    : !state.ok
      ? '?'
      : state.count > 0
        ? String(state.count)
        : 'ok';
  const warn = state.failed || state.attention > 0 ? ` ${WARN}` : '';
  return sanitize(`gitlink ${body}${warn}`);
}

/**
 * T168/P23 — il glifo delle voci launch in testata: 🔄 se una voce con esito
 * gira, 🚨 se l'ultimo exit di una è non-zero, NIENTE quando tutto è verde.
 *
 * L'assenza è uno stato e non un buco, al contrario del gitlink: qui il
 * successo è implicito, come nel rollup di compass che mostra solo ciò che
 * chiede attenzione. Con una voce rossa e una in corso vince 🚨 (ordine di
 * rollup della famiglia). La label nomina la voce quando è una sola; con più
 * voci nello stesso stato resta il conteggio, perché la riga legenda non ha
 * colonne per due nomi.
 */
export function launchIndicator(state: { kind: 'running' | 'red'; label: string; count: number }): string {
  const glyph = state.kind === 'running' ? '🔄' : '🚨';
  return sanitize(`${glyph} ${state.count > 1 ? String(state.count) : state.label}`);
}

export function indicatorRow(
  state: {
    /** T168 — `null` = nessuna voce con esito in corso né rossa: nessun
     *  segmento, il verde non si scrive (P23). */
    launch?: Parameters<typeof launchIndicator>[0] | null;
    /** T155 — `null` = il progetto non ha `.gitmodules`: nessun segmento, non
     *  uno che dice «0». La riga legenda riceve indietro quelle colonne. */
    gitlink: Parameters<typeof gitlinkIndicator>[0] | null;
  },
  columns: number,
): IndicatorRow {
  // Il gitlink sta in TESTA al blocco, che è ancorato al bordo destro: è un
  // segmento che può mancare del tutto (il gate su `.gitmodules`), e da lì la
  // sua assenza non sposta gli altri. T168 — il glifo launch gli sta davanti
  // per la stessa ragione, ed è ancora più intermittente: compare e sparisce
  // col giro di una voce.
  const segments: Segment[] = [
    ...(state.launch ? [{ key: '^l', text: launchIndicator(state.launch) }] : []),
    ...(state.gitlink ? [{ key: '^u', text: gitlinkIndicator(state.gitlink) }] : []),
  ];
  const text = segments.map((s) => s.text).join(INDICATOR_SEP);
  const width = termWidth(text);
  // Ancorato al bordo destro del box esterno: il blocco è renderizzato da un
  // `justifyContent="space-between"`, quindi la sua prima colonna si ricava per
  // sottrazione e non da un accumulo da sinistra.
  const start = FRAME_TEXT_COL + Math.max(0, (columns || 80) - 4) - width;
  return { segments, text, regions: rowRegions(segments, INDICATOR_SEP, start), width };
}

/**
 * T181 — il bottone della testata: `[ restore 3 sessions ]`, a sinistra di
 * risoluzione e versione.
 *
 * `key` come gli indicatori della riga legenda: la COMBO col prefisso `^`, e il
 * click rientra dalla porta della tastiera premendola (`HEADER_ROW` in
 * `mouse.ts`). La combo non sta nel testo del bottone (P5 preflight): la dice la
 * legenda, come per gli indicatori di T134.
 *
 * Tre forme, dalla più lunga, e vince la prima che lascia al nome del progetto
 * a sinistra almeno il pavimento di `headlineWidth`: il bottone entra nel
 * budget della testata, e una forma che non ci sta spingerebbe la riga oltre il
 * bordo. Nessuna delle tre ci sta → nessun bottone; `^T` resta valido, perché
 * il tasto non dipende da cosa entra a schermo.
 */
/** Il pavimento del budget del nome del progetto in testata: sotto, non resta
 *  niente di leggibile. Il bottone di restore lo rispetta (`restoreButton`). */
const HEADLINE_MIN = 4;

export const RESTORE_KEY = '^t';
export const HEADER_BUTTON_SEP = '  ';

export function restoreButtonForms(n: number): string[] {
  return [`[ restore ${n} ${n === 1 ? 'session' : 'sessions'} ]`, `[ restore ${n} ]`, `[ ${n} ]`];
}

export function restoreButton(n: number, columns: number, headerRight: string): string | null {
  if (n <= 0) return null;
  for (const form of restoreButtonForms(n)) {
    const block = termWidth(form) + termWidth(HEADER_BUTTON_SEP) + termWidth(headerRight);
    if ((columns || 80) - 4 - block - 1 >= HEADLINE_MIN) return form;
  }
  return null;
}

export type FrameInput = {
  rows: number;
  columns: number;
  mode: Mode;
  /** La riga di stato è presente (occupa una riga del budget). */
  hasNote: boolean;
  previewKind: PreviewKind;
  detailMetaLines: number;
  sessionHasFirstPreview: boolean;
  sessionHasLastPreview: boolean;
  /** La lista task INTERA della vista attiva, non la finestra visibile. */
  paneTasks: Task[];
  selIndex: number;
  /** La lista sessioni INTERA della vista attiva. */
  sessionRows: SessionRow[];
  selSessionId: string | null;
  taskCounts: TaskViewCounts;
  taskViewId: TaskViewId;
  sessionCounts: SessionViewCounts;
  sessionViewId: SessionViewId;
  parentLabel: string;
  /** `tasks.md` non è stato caricato: al posto delle righe task c'è la riga rossa. */
  hasLoadError: boolean;
  /** T181 — quante conversazioni riapre il restore (`restoreSet`); 0 = niente
   *  bottone in testata. */
  restoreCount: number;
};

export type Frame = {
  budget: Budget;
  taskWin: { start: number; end: number };
  windowTasks: Task[];
  sessionWin: { start: number; end: number };
  windowRows: SessionRow[];
  /** `null` in compatto: lì i pane non esistono, quindi non c'è nulla da colpire. */
  listGeometry: ListGeometry | null;
  /** Segmento destro della testata: risoluzione in celle e versione. */
  headerRight: string;
  /** T181 — il bottone di restore, già nella forma che entra; `null` = assente. */
  headerButton: string | null;
  /** Tutto ciò che sta a destra nella testata, bottone e separatore compresi:
   *  è la stringa da cui `headlineWidth` sottrae il budget del nome del progetto. */
  headerBlock: string;
  /** Le colonne cliccabili della testata (`HEADER_ROW`). */
  headerRegions: Region[];
  /** La riga launch è presente. */
  launchLine: boolean;
};

/**
 * Il budget d'altezza e le finestre di rendering.
 *
 * Il frame deve restare sotto `rows`, sempre: oltre quella soglia Ink smette di
 * aggiornare per differenza e pulisce lo schermo a ogni redraw, che su Ptyxis
 * significa un frame intero versato nello scrollback per ogni tick del poll.
 * Tutto ciò che varia in altezza (le due liste e la descrizione del dettaglio)
 * riceve qui la propria capienza.
 *
 * Le liste "logiche" restano intere: navigazione, selezione e spawn continuano
 * a ragionare su quelle, la finestra è solo ciò che finisce a schermo.
 */
export function frameGeometry(input: FrameInput): Frame {
  // Le surface built-in `t`/`c` la rendono sempre presente in modalità normale:
  // non dipende da quante voci `launch` il progetto dichiara.
  const launchLine = input.mode === 'normal';
  const budget: Budget = layoutBudget({
    rows: input.rows,
    mode: input.mode,
    launchLine,
    noteLine: input.hasNote,
    preview: input.previewKind,
    detailMetaLines: input.detailMetaLines,
    // Riservo righe di anteprima solo per i blocchi che davvero renderizzano: il
    // primo prompt aggiunge info solo con un titolo custom (senza, titolo ===
    // primo prompt); l'ultima risposta solo se il modello ha già risposto.
    sessionHasFirstPreview: input.sessionHasFirstPreview,
    sessionHasLastPreview: input.sessionHasLastPreview,
  });

  const taskWin = windowRange(
    input.paneTasks.length,
    input.selIndex - META_ROWS,
    budget.taskRows,
  );
  const windowTasks = input.paneTasks.slice(taskWin.start, taskWin.end);
  const selRowIndex = rowIndexOf(input.sessionRows, input.selSessionId);
  const sessionWin = windowRange(input.sessionRows.length, selRowIndex, budget.sessionRows);
  const windowRows = input.sessionRows.slice(sessionWin.start, sessionWin.end);

  // T21 — geometria delle liste per l'hit-test del click, dalla STESSA
  // aritmetica che disegna i pane: le parti degli header escono dal modulo che
  // `ui/panes.tsx` consuma per renderle, le righe cliccabili sono le finestre
  // appena calcolate.
  const spans = paneSpans(input.columns);
  const listGeometry: ListGeometry | null = budget.compact
    ? null
    : {
        columns: input.columns,
        taskHeader: inlineRegions(
          headerItems(
            taskHeaderParts(
              input.taskCounts,
              input.taskViewId,
              taskWin.start,
              input.paneTasks.length - taskWin.end,
              input.columns,
            ),
          ),
          spans.tasks.start + PANE_TEXT_PAD,
        ),
        sessionHeader: inlineRegions(
          headerItems(
            sessionHeaderParts(
              input.parentLabel,
              input.sessionCounts,
              input.sessionViewId,
              sessionWin.start,
              input.sessionRows.length - sessionWin.end,
              input.columns,
            ),
          ),
          spans.sessions.start + PANE_TEXT_PAD,
        ),
        // Con un errore di caricamento al posto delle task c'è la riga rossa:
        // restano cliccabili le sole righe meta.
        taskRows: META_ROWS + (input.hasLoadError ? 0 : windowTasks.length),
        sessionRows: windowRows.length,
      };

  // Dimensione del terminale in CELLE (colonne×righe, mai pixel — un processo
  // dentro un terminale vede solo la griglia di caratteri) e versione. La
  // parte sinistra della testata riceve un budget derivato da questa stringa e
  // non da una lunghezza fissa: la risoluzione cambia a ogni resize, quindi
  // anche la larghezza che occupa.
  const headerRight = `${input.columns}×${input.rows} · v${VERSION}`;
  // T181 — il bottone sta a sinistra di `headerRight` nello stesso blocco
  // ancorato a destra, quindi la sua prima colonna si ricava per sottrazione
  // dal bordo, come per gli indicatori (`indicatorRow`).
  const headerButton = restoreButton(input.restoreCount, input.columns, headerRight);
  const headerBlock = headerButton ? headerButton + HEADER_BUTTON_SEP + headerRight : headerRight;
  const blockStart = FRAME_TEXT_COL + Math.max(0, (input.columns || 80) - 4) - termWidth(headerBlock);
  const headerRegions: Region[] = headerButton
    ? [{ key: RESTORE_KEY, start: blockStart, end: blockStart + termWidth(headerButton) - 1 }]
    : [];

  return {
    budget,
    taskWin,
    windowTasks,
    sessionWin,
    windowRows,
    listGeometry,
    headerRight,
    headerButton,
    headerBlock,
    headerRegions,
    launchLine,
  };
}

/** Il budget della testata sinistra, per sottrazione dal blocco destro. */
export function headlineWidth(columns: number, headerRight: string): number {
  return Math.max(HEADLINE_MIN, columns - 4 - termWidth(headerRight) - 1);
}

/**
 * La testata sinistra: il nome del progetto, e nient'altro.
 *
 * `name` arriva dal file config, cioè da testo arbitrario: un glifo discorde
 * allargherebbe la riga di una cella e manderebbe a capo la testata. Si
 * sanifica QUI e non in `loadIdentity`, perché lo stesso valore serve intatto
 * ai titoli delle tab, dove è la chiave di match di compass. Il taglio lo fa
 * `cut` e non `wrap` di Ink (invariante ③ di `width.ts`), sul budget che
 * `headlineWidth` lascia dopo il blocco di destra.
 */
export function headlineText(name: string, budget: number): string {
  return cut(sanitize(name), Math.max(HEADLINE_MIN, budget));
}

/**
 * T134 — il budget della legenda tasti, per sottrazione del blocco indicatori
 * che le sta a destra sulla stessa riga.
 *
 * La legenda cede per prima (D5 preflight): è già troncabile per costruzione e
 * ciò che perde si ricorda, mentre un contatore troncato mente. Pavimento a 4
 * come la testata — sotto quella soglia non resta comunque niente di leggibile,
 * e un budget negativo farebbe tornare `cut` una stringa vuota per il tramite
 * di un numero che nessuno ha scelto.
 */
export function legendWidth(columns: number, indicatorW: number): number {
  return Math.max(4, (columns || 80) - 4 - indicatorW - termWidth(INDICATOR_SEP));
}

export { HEADER_ROW, HINT_ROW, LAUNCH_ROW };
