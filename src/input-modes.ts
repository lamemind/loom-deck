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
export const SCROLLING_MODES = ['detail', 'status', 'inbox', 'reader'] as const;

export type ScrollingMode = (typeof SCROLLING_MODES)[number];

const SCROLLING = new Set<string>(SCROLLING_MODES);

/** `true` se la rotella scorre il contenuto del modo. */
export function scrolls(mode: Mode): mode is ScrollingMode {
  return SCROLLING.has(mode);
}
