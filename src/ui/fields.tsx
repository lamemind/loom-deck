// T117 — resa di un campo di testo dentro un'area di compilazione: finestra
// ancorata al caret, cursore inverso sulla cella REALE.
//
// Uno solo per le due schermate. Esisteva in due copie — `EditTextField` nel
// modale edit e `DetailTextField` nel detail — e la seconda si dichiarava
// «gemello del primo senza la label»: la label infatti non è del campo, è del
// LAYOUT che lo ospita, e i due layout la mettono in posti diversi (l'edit dopo
// il marker di riga, il detail dentro un prefisso incolonnato). Tolta di mezzo,
// dei due gemelli resta una cosa sola.
import { Text } from 'ink';
import { caretWindow, cutParts, sanitize } from '../width.js';
import { cpLen } from '../layout.js';
import { CARET, CARET_OFF } from '../glyphs.js';

/**
 * Fuori fuoco (`focused` falso) il caret non si disegna e la finestra si ancora
 * in fondo, che è la vista utile per un campo che non si sta scrivendo: `at` lì
 * è solo la cella virtuale di fine campo, e disegnarla aggiungerebbe al testo
 * uno spazio che non gli appartiene.
 */
export function FieldText({
  value,
  caret,
  focused,
  cols,
}: {
  value: string;
  caret: number;
  focused: boolean;
  cols: number;
}) {
  const win = caretWindow(value, focused ? caret : cpLen(value), cols);
  return (
    <>
      <Text>{sanitize(win.head)}</Text>
      {focused ? <Text inverse>{sanitize(win.at)}</Text> : null}
      <Text>{sanitize(win.tail)}</Text>
    </>
  );
}

/** Prefisso incolonnato delle righe a scelta/testo di un'area di compilazione:
 *  le etichette si leggono una sotto l'altra, quindi la larghezza è quella
 *  della più lunga fra le righe che la usano (T117 nel detail, T148 nella
 *  preview sessione). */
export const LABEL_W = 8;

/**
 * T117 — una riga a SCELTA di un'area di compilazione: bottoni affiancati,
 * voce attiva in video inverso.
 *
 * Due passate di `cutParts`: la seconda serve SOLO quando qualcosa cade, e
 * riserva le colonne del contatore. Riservarle sempre costerebbe 6 colonne su
 * ogni terminale largo per un avviso che lì non comparirà mai.
 *
 * `priority` sulla voce SELEZIONATA e non sulla prima: qui il troncamento
 * cancellerebbe l'unica informazione che la riga esiste per dare — quale valore
 * sta per essere usato.
 *
 * T148 — estratto dal detail della task perché un secondo chiamante (il
 * selettore modello della preview sessione) ne riusa la stessa resa a quadre,
 * non un componente gemello capace di divergere.
 */
export function ChoiceRow({
  label,
  values,
  index,
  focused,
  width,
  originIndex,
}: {
  label: string;
  values: readonly string[];
  index: number;
  focused: boolean;
  width: number;
  /** T148/P5 — indice del valore D'ORIGINE: sottolineato, mai un glifo — costa
   *  zero colonne su una riga ASCII il cui troncamento si regge su questo.
   *  `undefined` quando non c'è una provenienza da dichiarare (l'azione e il
   *  modello di un nuovo spawn nel detail). */
  originIndex?: number;
}) {
  const segs = values.map((v) => `[ ${v} ]`);
  const parts: string[] = [];
  segs.forEach((s, i) => {
    if (i > 0) parts.push('  ');
    parts.push(s);
  });
  const avail = Math.max(0, width - LABEL_W - CARET_OFF.length);
  let shown = cutParts(parts, avail, index * 2);
  const dropped = (v: string[]) => segs.filter((s, i) => v[i * 2] !== s).length;
  if (dropped(shown) > 0) shown = cutParts(parts, Math.max(0, avail - 6), index * 2);
  const cut = dropped(shown);
  return (
    <Text wrap="truncate-end">
      {focused ? CARET : CARET_OFF}
      <Text dimColor>{label.padEnd(LABEL_W)}</Text>
      {shown.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i}>{part}</Text>
        ) : (
          <Text
            key={i}
            inverse={i / 2 === index}
            underline={i / 2 === originIndex}
            color={i / 2 === index ? 'green' : 'gray'}
          >
            {part}
          </Text>
        ),
      )}
      {/* Troncamento mai silenzioso, come le liste: un bottone che sparisce su
          un terminale stretto non deve sembrare un valore che non esiste. */}
      {cut > 0 ? <Text color="yellow"> · +{cut}</Text> : null}
    </Text>
  );
}
