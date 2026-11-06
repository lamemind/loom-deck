// T194 — il CATALOGO delle combo del deck: quali voci il modale su `H` elenca e
// come le dispone a schermo.
//
// Modulo PURO — nessun React, nessuno stato: prende quel che il deck sa del
// progetto e restituisce le tre liste, poi le righe già composte. È quindi
// provabile a unità, e `test/combo-catalog.test.ts` confronta le voci con i rami
// di `onKey` letti dal sorgente: un tasto aggiunto al dispatch e non annunciato
// qui fa fallire la suite.
//
// Le tre liste non dipendono dal fuoco né dalla selezione: il modale è la mappa
// del deck, e una mappa che cambia a seconda di dove si è seduti non si impara.
import { LAUNCH_MAX } from './config.js';
import { TASK_MODE_LEGEND } from './input-modes.js';
import { pad, sanitize, termWidth } from './width.js';

/** T181 — la voce del restore: la portano il modale e la riga due. */
const RESTORE_VOICE = '^T restore';

export type ComboList = {
  /** Il nome della lista, scritto sopra le sue voci. */
  title: string;
  /** Una voce per tasto: il tasto, uno spazio, ciò che fa. */
  voices: string[];
};

export type DeckLegend = {
  /** Le azioni che non dipendono da un pane: la riga in alto del modale. */
  general: ComboList;
  /** Le azioni del pane sinistro: task, o albero doc in modo doc. */
  left: ComboList;
  /** Le azioni del pane destro: conversazioni, o coda inbox in modo doc. */
  right: ComboList;
};

/**
 * Le tre liste del modale su `H`.
 *
 * Una voce sparisce solo quando il suo tasto non può fare niente su questo
 * progetto o in questo modo del deck: `^U` senza submodule, `^T` senza il bottone
 * a schermo, le cifre senza voci `launch`, i tasti del mondo task in modo doc.
 * Fuori: `↑↓`, universale in qualunque TUI.
 */
export function deckLegend(state: {
  /** `CANC` sul pane task pota in blocco invece della sola selezionata. */
  purgeBulk: boolean;
  /** T160 — il deck è in modo doc (albero doc + coda inbox). */
  docMode: boolean;
  /** T155 — il progetto ha submodule: senza, `^U` non ha bersaglio. */
  gitlink: boolean;
  /** T181 — il bottone di restore è a schermo in testata: senza, `^T` non ha
   *  niente da riaprire. */
  restore: boolean;
  /** Quante voci `launch` dichiara il progetto. */
  launchCount: number;
}): DeckLegend {
  const reachable = Math.min(state.launchCount, LAUNCH_MAX);
  const general = [
    // T181/P5 — in TESTA, perché questa voce vale proprio nel momento in cui il
    // deck si è appena riaperto: è il primo gesto che si vuole fare, non uno fra
    // venti.
    ...(state.restore ? [RESTORE_VOICE] : []),
    'tab vista',
    '←→ pane',
    // T169 — il finder è la via d'accesso a ogni task, nascoste dai filtri
    // comprese. Vive in entrambi i modi, come `^F`, perché non legge la selezione
    // del pane task (P6).
    'T trova',
    '^F cerca',
    // T121 — le voci nominano il GESTO e non l'oggetto: «status» da solo sarebbe
    // indistinguibile dal recap della task su `^K`, che è un'altra cosa.
    '^G genera status',
    '^O apri status',
    '^W lista hard-wrap',
    '^E scan hard-wrap',
    // T155 — il GESTO, come sopra: «gitlink» da solo direbbe l'oggetto e non che
    // il tasto lo allinea con un commit.
    ...(state.gitlink ? ['^U bumpa gitlink'] : []),
    // T160 — la voce nomina il MODO che il tasto monta, non quello montato: `^B`
    // li scambia, e annunciare quello che si sta già guardando direbbe il
    // contrario di ciò che il tasto fa.
    state.docMode ? '^B task' : '^B doc',
    // T161 — l'OGGETTO e non il gesto, al contrario di `^G`/`^O`/`^U`: lì il tasto
    // fa qualcosa, qui apre una pagina e basta.
    '^S azioni',
    't terminale',
    'c claude',
    ...(reachable === 0
      ? []
      : [reachable === 1 ? '1 voce launch' : `1-${reachable} voci launch`]),
  ];

  // T160 — in modo doc i due pane sono altri e i tasti di task e conversazioni non
  // hanno un oggetto su cui agire: annunciarli descriverebbe un deck che non
  // esiste. Le colonne seguono quindi i pane montati, ognuna al lato del suo.
  if (state.docMode) {
    return {
      general: voiceList('generali', general),
      left: voiceList('albero doc', ['⏎ apri']),
      right: voiceList('coda inbox', ['⏎ apri']),
    };
  }

  return {
    general: voiceList('generali', general),
    left: voiceList('task', [
      '⏎ detail',
      '^K/^P/^R spawn',
      // T112 — la voce nomina il BERSAGLIO, che cambia di taglia senza che cambi il
      // tasto. Legge `purgeBulk`, la stessa condizione del ramo di apertura: una
      // voce che annunciasse «tutte» dove il tasto ne pota una sola sarebbe peggio
      // di nessuna voce.
      state.purgeBulk ? 'CANC elimina tutte' : 'CANC elimina',
      // T160 — queste vengono dall'ELENCO che governa anche il dispatch
      // (`input-modes.ts` §TASK_MODE_KEYS): due elenchi divergono al primo tasto
      // aggiunto.
      ...TASK_MODE_LEGEND,
    ]),
    right: voiceList('conversazioni', [
      '⏎ resume',
      'f fork',
      'm modello',
      'CANC elimina',
      'p pin',
      'a priorità',
      // T117 · D3 — «titolo» anche qui: è lo stesso valore che il detail chiede
      // allo spawn. Rename di sola ETICHETTA: il dato resta `note` nel sidecar e
      // `--title-note` in deck-run.
      'N titolo',
      'A assegna',
    ]),
  };
}

function voiceList(title: string, voices: string[]): ComboList {
  return { title, voices: voices.map((voce) => sanitize(voce)) };
}

/**
 * T194 — la legenda di RIGA DUE in modalità normale: la voce che apre il modale
 * delle combo e, col bottone di restore a schermo, `^T restore`.
 *
 * `^T` resta qui anche se il modale lo elenca: il bottone in testata non porta la
 * combo nel testo (P5 di T181), e vale appena il deck si è riaperto, cioè quando
 * nessuno ha ancora motivo di aprire un modale per scoprirla.
 *
 * `H combo` sta in testa perché la riga tronca dalla coda: è la voce da cui si
 * raggiungono tutte le altre, compresa quella che il taglio toglierebbe.
 */
export function hintLegend(state: { restore: boolean }): string {
  return ['H combo', ...(state.restore ? [RESTORE_VOICE] : [])].join(' · ');
}

export type ComboRow = {
  /** Il tasto, così come la voce lo annuncia: `^K/^P/^R`, `CANC`, `T`. */
  key: string;
  /** Ciò che il tasto fa: `spawn`, `elimina tutte`, `trova`. */
  label: string;
};

/**
 * Le voci come coppie tasto + effetto. Ogni voce apre col tasto che annuncia e lo
 * separa con uno spazio (`input-modes.test.ts` lo fissa per le voci di
 * `TASK_MODE_LEGEND`), quindi il taglio sta sul primo spazio.
 */
export function comboRows(voices: readonly string[]): ComboRow[] {
  return voices.map((voce) => {
    const at = voce.indexOf(' ');
    return at < 0
      ? { key: voce, label: '' }
      : { key: voce.slice(0, at), label: voce.slice(at + 1) };
  });
}

export type ComboSpan = { text: string; style: 'title' | 'key' | 'label' | 'separator' };

/** Una riga del modale: i pezzi nell'ordine in cui si disegnano. */
export type ComboLine = ComboSpan[];

const VOICE_SEPARATOR = ' · ';
const KEY_GAP = '  ';
const COLUMN_GUTTER = '  ';
const BLANK_LINE: ComboLine = [{ text: ' ', style: 'label' }];

/**
 * Le righe del modale, già composte per la larghezza: le azioni generali in alto,
 * poi le due colonne.
 *
 * Le generali vanno a capo fra una voce e l'altra, mai dentro una voce. Le colonne
 * stanno affiancate finché entrano, a metà larghezza come i due pane della vista
 * normale; sotto quella soglia si impilano. Nessuna voce si tronca, e le righe in
 * eccesso rispetto al terminale si raggiungono scorrendo.
 */
export function comboLines(legend: DeckLegend, width: number): ComboLine[] {
  return [
    titleLine(legend.general.title),
    ...generalLines(comboRows(legend.general.voices), width),
    BLANK_LINE,
    ...columnLines(legend.left, legend.right, width),
  ];
}

function titleLine(title: string): ComboLine {
  return [{ text: title, style: 'title' }];
}

function generalLines(rows: ComboRow[], width: number): ComboLine[] {
  const lines: ComboLine[] = [];
  let line: ComboLine = [];
  let used = 0;
  for (const row of rows) {
    const voiceWidth = termWidth(`${row.key} ${row.label}`);
    const separatorWidth = line.length > 0 ? termWidth(VOICE_SEPARATOR) : 0;
    if (line.length > 0 && used + separatorWidth + voiceWidth > width) {
      lines.push(line);
      line = [];
      used = 0;
    } else if (line.length > 0) {
      line.push({ text: VOICE_SEPARATOR, style: 'separator' });
      used += separatorWidth;
    }
    line.push({ text: row.key, style: 'key' }, { text: ` ${row.label}`, style: 'label' });
    used += voiceWidth;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

type ColumnShape = {
  title: string;
  rows: ComboRow[];
  /** Larghezza della colonna dei tasti, misurata su tutte le voci della lista. */
  keyWidth: number;
  /** Larghezza minima della lista: la voce più larga, o il titolo. */
  width: number;
};

function columnShape(list: ComboList): ColumnShape {
  const rows = comboRows(list.voices);
  const keyWidth = Math.max(0, ...rows.map((row) => termWidth(row.key)));
  const labelWidth = Math.max(0, ...rows.map((row) => termWidth(row.label)));
  const width = Math.max(termWidth(list.title), keyWidth + termWidth(KEY_GAP) + labelWidth);
  return { title: list.title, rows, keyWidth, width };
}

function columnLines(leftList: ComboList, rightList: ComboList, width: number): ComboLine[] {
  const left = columnShape(leftList);
  const right = columnShape(rightList);
  const gutterWidth = termWidth(COLUMN_GUTTER);
  const leftWidth = Math.max(left.width, Math.floor((width - gutterWidth) / 2));

  if (leftWidth + gutterWidth + right.width > width) {
    return [
      titleLine(left.title),
      ...left.rows.map((row) => voiceCell(row, left.keyWidth)),
      BLANK_LINE,
      titleLine(right.title),
      ...right.rows.map((row) => voiceCell(row, right.keyWidth)),
    ];
  }

  const gutter: ComboSpan = { text: COLUMN_GUTTER, style: 'label' };
  const lines: ComboLine[] = [
    [{ text: pad(left.title, leftWidth), style: 'title' }, gutter, { text: right.title, style: 'title' }],
  ];
  for (let i = 0; i < Math.max(left.rows.length, right.rows.length); i++) {
    const leftRow = left.rows[i];
    const rightRow = right.rows[i];
    lines.push([
      ...(leftRow ? voiceCell(leftRow, left.keyWidth, leftWidth) : [{ text: ' '.repeat(leftWidth), style: 'label' as const }]),
      gutter,
      ...(rightRow ? voiceCell(rightRow, right.keyWidth) : []),
    ]);
  }
  return lines;
}

/** Una voce di colonna: il tasto incolonnato e l'effetto, riempito fino a
 *  `cellWidth` quando dopo la cella viene altro. */
function voiceCell(row: ComboRow, keyWidth: number, cellWidth?: number): ComboSpan[] {
  const head = pad(row.key, keyWidth) + KEY_GAP;
  const label =
    cellWidth === undefined ? row.label : pad(row.label, cellWidth - termWidth(head));
  return [
    { text: pad(row.key, keyWidth), style: 'key' },
    { text: KEY_GAP + label, style: 'label' },
  ];
}
