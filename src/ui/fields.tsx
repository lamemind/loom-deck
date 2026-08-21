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
import { caretWindow, sanitize } from '../width.js';
import { cpLen } from '../layout.js';

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
