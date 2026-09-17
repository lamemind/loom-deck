// La PRECEDENZA fra i modi dell'handler input, dichiarata come dato.
//
// Prima di questo file la precedenza era l'ordine testuale di dieci `if` dentro
// un `useInput` da 850 righe: un'informazione portante che nessun tipo esprimeva
// e nessun test fissava. Ha già prodotto una correzione non ovvia — il ramo
// `detail` anteposto a quello `key.ctrl` per rendere inerti gli acceleratori
// dentro il detail, con `^F` come deroga *dentro* quel ramo.
//
// Il custode è `MODE_KEYS` in `input.ts`: un `Record<CapturingMode, Handler>`
// che non compila se un modo nuovo resta senza handler. Il `Record` però non
// impedisce all'handler di vivere DENTRO il dispatch invece che in un overlay,
// ed è il buco che `test/input-wiring.test.ts` chiude leggendo il sorgente come
// testo. Il test gemello di questo file fissa l'insieme e la deroga.

import type { Mode } from './model.js';

/**
 * I modi che CATTURANO l'input per intero.
 *
 * Mentre uno di questi è attivo sono inerti: gli acceleratori globali
 * (`^K`/`^P`/`^R`/`^F`), i tasti nudi della lista, `tab`, `←→` e `q`. Il modo
 * risponde di ogni tasto che riceve — anche solo per ignorarlo.
 *
 * `normal` è l'unico modo NON capturing, ed è il complemento esatto di questo
 * insieme: è lì che vivono gli acceleratori.
 */
export const CAPTURING_MODES = [
  'detail',
  'status',
  'inbox',
  'doc',
  'wrap',
  'spawn',
  'reader',
  'search',
  'assign',
  'create',
  'note',
  'sort',
  'filter',
  'edit',
  'purge',
] as const;

export type CapturingMode = (typeof CAPTURING_MODES)[number];

// Custode a compile-time: se `Mode` guadagna un valore e nessuno lo classifica,
// questo tipo diventa `never` e l'assegnamento non compila. È ciò che rende
// impossibile aggiungere un modo dimenticandone la precedenza.
type Exhaustive = Exclude<Mode, 'normal'> extends CapturingMode ? true : never;
const _MODES_ARE_EXHAUSTIVE: Exhaustive = true;
void _MODES_ARE_EXHAUSTIVE;

const CAPTURING = new Set<string>(CAPTURING_MODES);

/** `true` se il modo intercetta l'input prima degli acceleratori globali. */
export function captures(mode: Mode): mode is CapturingMode {
  return CAPTURING.has(mode);
}

/**
 * Le DEROGHE: combinazioni `ctrl` che restano vive dentro un modo capturing,
 * con un significato proprio.
 *
 * Oggi ce n'è una sola — `^F` dentro `detail`, che apre la ricerca nel testo
 * invece di quella sulle conversazioni. Non è l'acceleratore globale che
 * sopravvive: è un tasto diverso che porta lo stesso nome, e il modo se lo
 * gestisce da sé. Sta scritto qui perché è l'eccezione a una regola dichiarata,
 * e un'eccezione che vive solo dentro un `if` annidato è come non averla.
 *
 * `purge` (T112) non ne ha e non può averne: è una domanda binaria, e dentro
 * una domanda non c'è nessun acceleratore da salvare.
 */
export const CTRL_DEROGATIONS: Partial<Record<CapturingMode, readonly string[]>> = {
  detail: ['f'],
};

/**
 * T160 — i tasti del MONDO TASK: quelli che agiscono su una task selezionata o
 * sulla sua lista, e che in modo doc non hanno un oggetto su cui agire.
 *
 * L'insieme è un DATO e non due elenchi, perché ha due lettori — il dispatch che
 * li rende inerti (`onKey`) e la legenda che smette di annunciarli
 * (`deckLegend`) — e due elenchi scritti a mano divergono al primo tasto
 * aggiunto: il tasto nuovo resterebbe annunciato e inerte, oppure gated e
 * invisibile, e nessuno dei due guasti produce un errore.
 *
 * **L'inerzia si dice.** Un ramo che non fa niente in silenzio è
 * indistinguibile da un tasto rotto; uno che scrive «^K → solo in modo task
 * (^B)» dice anche come tornare dove il tasto funziona. È la terza forma di
 * inerzia del deck, dopo quella per modo (gli acceleratori dentro il detail) e
 * quella per vista (`F` fuori dalla vista principale del pane task), e la sola
 * che tocca anche la legenda: le prime due vivono in una schermata transitoria,
 * un modo del deck è lo stato in cui si sta — e una legenda che annunciasse `^R
 * spawn` mentre a sinistra c'è un albero di file doc descriverebbe un deck che
 * non esiste.
 *
 * COSA NON ENTRA, e perché:
 *  - la riga launch (`t`, `c`, le voci `1-9`) — apre comandi a project root, non
 *    azioni sulla selezione, quindi vale in entrambi i modi (D2 preflight);
 *  - `f`/`p`/`a`/`N`/`A` — agiscono sulla lista conversazioni e sono GIÀ inerti
 *    per focus (`focus !== 'sessions'`), con la propria nota. Aggiungerli qui
 *    darebbe due guardie per lo stesso tasto;
 *  - `^F`, `^G`/`^O`, `^W`/`^E`, `^U`, `^S`, `^B` — non dipendono dalla
 *    selezione task: cercano nelle conversazioni, misurano il progetto, aprono
 *    pagine. `^W` resta vivo mentre `w` è gated, e sono due tasti diversi.
 */
export type Chord =
  | { kind: 'ctrl'; input: string }
  | { kind: 'plain'; input: string }
  /** `CANC` e Backspace collassano su `key.delete` con `input` vuoto (T112/D1):
   *  a valle non resta niente da cui distinguerli, quindi il chord è il tasto
   *  speciale e non una lettera. */
  | { kind: 'delete' };

export interface TaskModeKey {
  chord: Chord;
  /** Come il tasto si NOMINA nella riga di stato quando dichiara la propria
   *  inerzia. */
  label: string;
  /**
   * La voce di legenda che questo tasto porta, o `null` quando la voce è già
   * condizionata dal focus e quindi sparisce da sé in modo doc.
   *
   * I quattro a `null` sono `^K`/`^P`/`^R` (una voce sola per tre tasti, emessa
   * solo con una task selezionata) e `CANC`, che ha due forme a seconda del
   * bersaglio. Scriverli qui obbligherebbe questo elenco a conoscere il focus e
   * il bulk, cioè a diventare una seconda copia della logica della legenda.
   */
  legend: string | null;
}

export const TASK_MODE_KEYS: readonly TaskModeKey[] = [
  { chord: { kind: 'ctrl', input: 'k' }, label: '^K', legend: null },
  { chord: { kind: 'ctrl', input: 'p' }, label: '^P', legend: null },
  { chord: { kind: 'ctrl', input: 'r' }, label: '^R', legend: null },
  { chord: { kind: 'delete' }, label: 'CANC', legend: null },
  { chord: { kind: 'plain', input: 'C' }, label: 'C', legend: 'C nuova' },
  { chord: { kind: 'plain', input: 'E' }, label: 'E', legend: 'E edit' },
  { chord: { kind: 'plain', input: 'S' }, label: 'S', legend: 'S sort' },
  { chord: { kind: 'plain', input: 'F' }, label: 'F', legend: 'F filtri' },
  { chord: { kind: 'plain', input: 'w' }, label: 'w', legend: 'w salva' },
];

/** Le voci di legenda dei tasti del mondo task, nell'ordine dell'elenco: è ciò
 *  che `deckLegend` emette in modo task e omette in modo doc. */
export const TASK_MODE_LEGEND: readonly string[] = TASK_MODE_KEYS.map((k) => k.legend).filter(
  (v): v is string => v !== null,
);

/**
 * Il nome del tasto del mondo task appena premuto, o `null` se non è uno di
 * loro.
 *
 * I tre booleani arrivano dal chiamante invece del `Key` di Ink: questo modulo
 * è un catalogo di dati e resta provabile senza montare nulla — la stessa
 * ragione per cui `CAPTURING_MODES` è un array e non una proprietà di un hook.
 */
export function taskModeKey(input: string, ctrl: boolean, del: boolean): string | null {
  for (const k of TASK_MODE_KEYS) {
    const c = k.chord;
    if (c.kind === 'delete' ? del : c.kind === 'ctrl' ? ctrl && c.input === input : !ctrl && !del && c.input === input) {
      return k.label;
    }
  }
  return null;
}

/** La riga di stato di un tasto inerte: nomina il tasto, il modo in cui vive e
 *  come tornarci. */
export function inertNote(label: string): string {
  return `${label} → solo in modo task (^B)`;
}

/**
 * T21 (mandata 2) — i modi che SCORRONO un contenuto lungo, cioè gli unici in
 * cui la rotella del mouse fa qualcosa.
 *
 * La rotella scorre il TESTO, mai la selezione di una lista (D5): nelle liste
 * la selezione è un'intenzione — la riga su cui si preme `⏎` — e una rotella
 * che la muovesse trasformerebbe ogni sfioramento in una scelta. Nei tre modi
 * qui sotto lo scroll non sceglie niente, è solo posizione di lettura. Non
 * coincide con «ha un documento a schermo»: `search` mostra un'anteprima, ma
 * il fuoco lì è sulla lista dei risultati, che è una selezione.
 *
 * Il custode è `MODE_WHEEL` in `input.ts`, un `Record<ScrollingMode, …>` che non
 * compila se un modo entra qui senza uno scroll da chiamare.
 */
export const SCROLLING_MODES = ['detail', 'status', 'inbox', 'doc', 'wrap', 'reader'] as const;

export type ScrollingMode = (typeof SCROLLING_MODES)[number];

const SCROLLING = new Set<string>(SCROLLING_MODES);

/** `true` se la rotella scorre il contenuto del modo. */
export function scrolls(mode: Mode): mode is ScrollingMode {
  return SCROLLING.has(mode);
}
