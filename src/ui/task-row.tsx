// La riga di lista di UNA task, condivisa fra il pane task e la schermata di
// assegnazione (T124).
//
// Prima viveva solo nel pane, e la schermata di assegnazione ne teneva una copia
// ricomposta a mano: id non paddato alla colonna, coda non ancorata al bordo,
// marker dirty assente, contatore scritto in proprio. Nessuna di quelle
// differenze produceva un errore — la schermata rendeva righe valide, solo
// diverse — quindi nessun test le vedeva e ogni evoluzione della lista si
// fermava al suo confine. Un componente solo è ciò che toglie il gemello.
//
// Le due sedi differiscono per tre cose sole, tutte parametri: la larghezza
// utile, il concetto di fuoco (la schermata di assegnazione è sempre a fuoco) e
// la finestra di righe che il chiamante ha già ritagliato.
import { Text } from 'ink';
import { cut, pad, sanitize, termWidth } from '../width.js';
import { isDone } from '../layout.js';
import {
  CARET,
  CARET_OFF,
  LIVE_BUSY,
  LIVE_IDLE,
  LIVE_NONE,
  displayProg,
  taskTail,
} from '../glyphs.js';
import { padId, type TaskRowData } from '../view.js';
import type { Task } from '../tasks.js';

export function TaskRow({
  task,
  sel,
  focused,
  width,
  idW,
  tailW,
  data,
}: {
  task: Task;
  sel: boolean;
  /** Il pane cede il fuoco all'altro pane; una schermata sostitutiva no. */
  focused: boolean;
  /** Colonne utili della sede — `paneTextWidth` di là, `assignTextWidth` di qua. */
  width: number;
  /** T118 — larghezze misurate sulla popolazione COMPLETA della vista, mai sulla
   *  finestra: derivarle dalle righe a schermo sposta le colonne a ogni scroll.
   *  `tailW` include già il proprio gutter; `0` = colonna spenta. */
  idW: number;
  tailW: number;
  data: TaskRowData;
}) {
  // T124 — il predicato è UNO e si valuta qui una volta sola: da lui dipendono
  // tutte e tre le evidenze (id in grassetto+colore, glifo, numeratore in coda).
  // Tre condizioni scritte in tre siti divergono alla prima modifica, e la riga
  // finirebbe per dire due cose diverse su sé stessa.
  const live = data.live.get(task.id) ?? null;
  // Stessa resa dell'hash conversazione del pane sessioni, perché è lo stesso
  // stato: `◍` giallo di là e `◍` nero di qua sarebbero due grafie di una cosa
  // sola.
  const color = live ? (live.status === 'busy' ? 'yellow' : 'green') : undefined;
  // Attaccato all'id, non staccato: il glifo qualifica QUELL'id, e uno spazio in
  // mezzo lo farebbe leggere come una colonna a sé. Consuma il primo dei due
  // spazi verso Pri, quindi la riga non si allarga di una cella quando si
  // accende — `LIVE_NONE` è uno spazio, e tutti e tre sono larghi 1.
  const glyph = live ? (live.status === 'busy' ? LIVE_BUSY : LIVE_IDLE) : LIVE_NONE;
  const tail = taskTail(live?.count ?? 0, data.childCount.get(task.id) ?? 0, data.dirty.has(task.id));
  const id = padId(task.id, idW);
  // Invariante ③: la descrizione è l'unico pezzo a lunghezza libera, e si taglia
  // QUI sul budget che resta dopo le colonne fisse. Lasciarlo fare a
  // `truncate-end` significa passare da `cli-truncate`, che restituisce una riga
  // più larga del pane (una colonna per emoji) e quindi scrive sopra il bordo.
  // Le parti fisse si misurano con `termWidth`: i due glifi Pri/Prog valgono 2
  // ciascuno.
  const head = `${CARET_OFF}${id}${glyph} ${sanitize(task.pri)}  ${displayProg(task.prog)}  `;
  // T118 — la colonna della coda si riserva PRIMA di tagliare la descrizione, e
  // per la stessa larghezza su ogni riga: appesa dopo, entrava nel budget solo
  // dove c'era qualcosa da scrivere, e la descrizione si tagliava a una colonna
  // diversa riga per riga.
  //
  // Pavimento `0` su tutte e tre le misure e non un minimo di cortesia: il
  // budget è un TETTO. Un pavimento sopra lo spazio reale fa uscire la riga dal
  // pane e le mangia il bordo. `reserve` si clampa su ciò che avanza, così
  // `head + desc + coda` sta sempre dentro la sede.
  const avail = Math.max(0, width - termWidth(head));
  const reserve = Math.min(tailW, avail);
  const descW = avail - reserve;
  const desc = cut(task.desc, descW);
  return (
    <Text
      inverse={sel && focused}
      bold={sel && !focused}
      dimColor={!sel && isDone(task.prog)}
      wrap="truncate-end"
    >
      {sel ? CARET : CARET_OFF}
      <Text bold={Boolean(live)} color={color}>
        {id}
        {glyph}
      </Text>
      {` ${sanitize(task.pri)}  ${displayProg(task.prog)}  ${desc}`}
      {' '.repeat(Math.max(0, descW - termWidth(desc)))}
      {pad(tail, reserve, 'right')}
    </Text>
  );
}
