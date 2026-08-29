// La GEOMETRIA di un frame del deck: cosa entra a schermo, dove, e quali righe
// sono cliccabili.
//
// Modulo PURO — nessun React, nessuno stato, nessun effetto. Prende le misure
// del terminale e le liste intere, restituisce il budget d'altezza, le finestre
// di rendering e la mappa dell'hit-test. Ne discende che è testabile a unità,
// che è la ragione principale per cui è uscito da `cli.tsx`: qui vivono due
// invarianti che prima erano affidate a un commento — la legenda che non deve
// mentire sul bersaglio di `CANC`, e le righe cliccabili che devono essere
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
import { sanitize, termWidth } from './width.js';
import { META_ROWS, type Focus, type Mode } from './model.js';
import type { SessionViewCounts, SessionViewId, TaskViewCounts, TaskViewId } from './pane-views.js';
import { rowIndexOf, type SessionRow } from './session-list.js';
import type { Task } from './tasks.js';
import { VERSION } from './version.js';

// Le due surface built-in del cappello, in testa alla riga launch. Non stanno
// fra i tasti perché hanno la stessa natura delle voci `launch` — fire-once,
// cwd = project root, nessuno stato — e la differenza è solo che sono
// universali (nessun progetto le dichiara) invece che custom. Emoji del menu
// compass: 🤖 = nuova sessione claude. Per il terminale compass usa 🖥️, che nel
// frame Ink NON passa — `sanitize` lo sostituisce (VTE lo disegna largo 1,
// string-width dice 2: discordante, invariante ① di width.ts) e resterebbe un
// `·` muto. 💻 è il gemello concorde; il `sanitize` qui rende il vincolo
// automatico invece che da ricordare.
//
// T21 — `key` è il tasto che la superficie rappresenta: un click su di essa
// entra nell'handler di tastiera con quel tasto, invece di chiamare l'azione
// per conto proprio. È ciò che tiene click e tasto per costruzione allineati.
export const SURFACE_SEGMENTS: readonly Segment[] = [
  { key: 't', text: sanitize('t 💻') },
  { key: 'c', text: sanitize('c 🤖') },
];

/**
 * La legenda della modalità normale. Elenca SOLO i tasti che fanno qualcosa qui
 * e ora: le voci contestuali compaiono quando il pane a fuoco le rende possibili
 * e altrimenti spariscono, invece di annunciarsi inerti con un `—`.
 *
 * Fuori: la navigazione (`↑↓` `←→`), universale in qualunque TUI, e
 * l'indicatore `focus:` — il pane a fuoco si vede già dall'evidenziazione, e
 * ridirlo a parole costava colonne su una riga che tronca in silenzio.
 * Nessuna voce di uscita: non esiste più un tasto che chiuda il deck.
 */
export function deckLegend(state: {
  focus: Focus;
  /** Una task vera è selezionata (non una riga meta). */
  hasTask: boolean;
  /** La riga sessioni selezionata ha un transcript (non è un pin stale). */
  hasSession: boolean;
  /** C'è una riga sessioni selezionata, stale compresa. */
  hasSessionId: boolean;
  /** `CANC` pota in blocco invece della sola selezionata. */
  purgeBulk: boolean;
}): string {
  const canSpawn = state.focus === 'tasks' && state.hasTask;
  const canResume = state.focus === 'sessions' && state.hasSession;
  // T50 — il pin agisce su qualunque riga selezionata (anche stale, per
  // spinnarla); basta il focus sul pane e una selezione.
  const canPin = state.focus === 'sessions' && state.hasSessionId;
  return sanitize(
    [
      ...(canSpawn ? ['⏎ detail', '^K/^P/^R spawn'] : canResume ? ['⏎ resume'] : []),
      // T112 — la voce nomina il BERSAGLIO, che cambia di taglia senza che
      // cambi il tasto. Legge `purgeBulk`, la stessa condizione del ramo di
      // apertura: una legenda che annunciasse «tutte» dove il tasto ne pota una
      // sola sarebbe peggio di nessuna legenda.
      ...(state.focus === 'tasks' ? [state.purgeBulk ? 'CANC elimina tutte' : 'CANC elimina'] : []),
      ...(canResume ? ['f fork'] : []),
      // T117 · D3 — «titolo» anche qui: è lo stesso valore che il detail chiede
      // allo spawn, e due nomi per una cosa sola li paga chi legge le due
      // schermate. Rename di sola ETICHETTA: il dato resta `note` nel sidecar e
      // `--title-note` in deck-run, dove rinominarlo sarebbe un breaking.
      ...(canPin ? ['p pin', 'N titolo', 'A assegna'] : []),
      // T121 — le due voci nominano il GESTO e non l'oggetto: «status» da solo
      // sarebbe indistinguibile dal recap della task su `^K`, che è un'altra
      // cosa e sta a due voci di distanza.
      '^G genera status',
      '^O apri status',
      '^F cerca',
      'C nuova',
      'E edit',
      'S sort',
      'F filtri',
      'w salva',
    ].join(' · '),
  );
}

export type LaunchRow = {
  /** I segmenti nell'ordine in cui si disegnano: le due surface, poi le voci. */
  segments: Segment[];
  /** Le colonne cliccabili degli stessi segmenti, per l'hit-test. */
  regions: Region[];
  /** Voci che non entrano nella riga. */
  overflow: number;
  /** Voci oltre la nona, quindi senza un tasto-cifra che le raggiunga. */
  unreachable: number;
};

/**
 * T21 — la riga launch come DATO, non come stringa: gli stessi segmenti
 * compongono il testo renderizzato e le colonne dell'hit-test. Derivare le
 * seconde ri-splittando il primo sarebbe un conto parallelo, che diverge alla
 * prima label che contenga il separatore.
 *
 * Le celle delle surface (più il ` · ` che le separa dalle voci) sono già spese
 * sulla riga → vanno riservate, o le voci launch la sfonderebbero di quel tanto.
 */
export function launchRow(launch: LaunchEntry[], columns: number): LaunchRow {
  const surfaceLegend = SURFACE_SEGMENTS.map((s) => s.text).join(LAUNCH_SEP);
  const legend = launchLegend(launch, columns, cellWidth(surfaceLegend) + cellWidth(LAUNCH_SEP));
  const segments: Segment[] = [
    ...SURFACE_SEGMENTS,
    ...legend.taken.map((text, i) => ({ key: String(i + 1), text })),
  ];
  return {
    segments,
    regions: rowRegions(segments, LAUNCH_SEP, FRAME_TEXT_COL),
    overflow: legend.overflow,
    unreachable: legend.unreachable,
  };
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

  return {
    budget,
    taskWin,
    windowTasks,
    sessionWin,
    windowRows,
    listGeometry,
    // Dimensione del terminale in CELLE (colonne×righe, mai pixel — un processo
    // dentro un terminale vede solo la griglia di caratteri) e versione. La
    // parte sinistra della testata riceve un budget derivato da questa stringa e
    // non da una lunghezza fissa: la risoluzione cambia a ogni resize, quindi
    // anche la larghezza che occupa.
    headerRight: `${input.columns}×${input.rows} · v${VERSION}`,
    launchLine,
  };
}

/** Il budget della testata sinistra, per sottrazione dal segmento destro. */
export function headlineWidth(columns: number, headerRight: string): number {
  return Math.max(4, columns - 4 - termWidth(headerRight) - 1);
}

export { LAUNCH_ROW };
