// T117 — la grammatica di un'AREA DI COMPILAZIONE: più campi eterogenei su una
// schermata sola, con un fuoco che si sposta fra le righe.
//
// Nasce nel modale edit (T41/T54) e vale ovunque una schermata raccolga
// parametri prima di un'azione: righe focusabili, `↑↓` cambia riga, `←→` cambia
// valore o muove il caret secondo il TIPO di riga, e i campi testuali ricevono i
// caratteri solo quando sono in fuoco. Prima di questo file esisteva due volte —
// per intero dentro `onEditKey`, in forma mutila dentro il detail — e i commenti
// lo dichiaravano («gemello di EditTextField senza la label»). Due copie di una
// grammatica di input si tengono allineate a mano a ogni tasto aggiunto, e la
// seconda è sempre quella che resta indietro.
//
// Logica pura, zero React: il chiamante possiede lo stato e passa le due
// funzioni con cui si legge e si scrive. Ne discende che i VALORI restano
// tipizzati dove vivono (`PriName` nell'edit, `ModelKind` nel detail) invece di
// essere schiacciati in un record generico — il modulo governa la grammatica,
// non il modello dati.
import type { Key } from 'ink';
import { cpLen, insertAt, removeAt } from './layout.js';
import { sanitizeTyped } from './glyphs.js';

/**
 * Una riga dell'area: o un campo di testo, o una scelta fra `count` voci.
 *
 * `hotkeys` (lettera → indice) dà alla riga a scelta una selezione DIRETTA
 * accanto a `←→`. Vive solo qui e non nelle righe di testo per una ragione
 * strutturale, non di gusto: su un campo libero ogni lettera è già testo, quindi
 * una lettera-acceleratore o sarebbe indigitabile o ruberebbe un carattere.
 */
export type FieldSpec =
  | { kind: 'text' }
  | { kind: 'choice'; count: number; hotkeys?: Readonly<Record<string, number>> };

/** Riga in fuoco + caret DENTRO la riga di testo attiva, contato per code point.
 *  Uno solo per tutta l'area: una riga di testo alla volta è editabile, e tenerne
 *  uno per campo vorrebbe dire allinearli a mano. */
export interface FieldsCursor {
  row: number;
  caret: number;
}

/** L'accesso ai valori, che restano del chiamante. `text`/`setText` valgono
 *  sulle righe `text`, `choice`/`setChoice` su quelle `choice`; il modulo non
 *  chiama mai l'una su una riga dell'altro tipo. */
export interface FieldsIO {
  text(row: number): string;
  setText(row: number, next: string): void;
  choice(row: number): number;
  setChoice(row: number, index: number): void;
}

/** La riga `row` è un campo di testo (e quindi mangia le lettere). */
export function isTextField(specs: readonly FieldSpec[], row: number): boolean {
  return specs[row]?.kind === 'text';
}

/** Caret in CODA al campo della riga `row`: la posizione da cui si continua a
 *  scrivere, e l'unica che non dipende da dove stava il cursore prima. Su una
 *  riga a scelta il caret non ha significato e vale 0. */
export function caretAtEnd(specs: readonly FieldSpec[], row: number, io: FieldsIO): number {
  return isTextField(specs, row) ? cpLen(io.text(row)) : 0;
}

/**
 * Un tasto dell'area di compilazione. Ritorna `true` se lo ha consumato.
 *
 * Il chiamante gestisce PRIMA i tasti che sono suoi e non dell'area (`esc`,
 * `⏎`, `^F`, `PgUp`/`PgDn`), poi delega qui; ciò che torna `false` è inerte, e
 * lasciarlo cadere è la scelta giusta dentro un modo capturing.
 *
 * Il ramo CTRL è ANTEPOSTO a quelli su carattere, come in modalità normale: `^A`
 * e `a` arrivano con lo stesso `input`, e `key.ctrl` è l'unico discriminante —
 * senza la precedenza il `^A` finirebbe dentro il testo.
 */
export function fieldsKey(
  input: string,
  key: Key,
  specs: readonly FieldSpec[],
  cursor: FieldsCursor,
  setCursor: (next: FieldsCursor) => void,
  io: FieldsIO,
): boolean {
  const spec = specs[cursor.row];
  if (!spec) return false;

  if (key.upArrow || key.downArrow) {
    // Ciclico: le aree sono di 4 righe, arrivare in fondo e ripartire costa meno
    // che invertire direzione.
    const d = key.upArrow ? -1 : 1;
    const row = (cursor.row + specs.length + d) % specs.length;
    setCursor({ row, caret: caretAtEnd(specs, row, io) });
    return true;
  }

  if (spec.kind === 'choice') {
    if (key.leftArrow || key.rightArrow) {
      const d = key.leftArrow ? -1 : 1;
      io.setChoice(cursor.row, (io.choice(cursor.row) + spec.count + d) % spec.count);
      return true;
    }
    // Le lettere di selezione diretta arrivano nude: un `key.ctrl` con lo stesso
    // carattere è un acceleratore, non una scelta.
    if (input && !key.ctrl && !key.meta && spec.hotkeys) {
      const at = spec.hotkeys[input];
      if (at !== undefined && at < spec.count) {
        io.setChoice(cursor.row, at);
        return true;
      }
    }
    return false;
  }

  const value = io.text(cursor.row);
  if (key.ctrl) {
    // `^A`/`^E` (convenzione readline) perché `Home`/`End` NON sono esposte da
    // `useInput`: misurate su otto sequenze diverse (`\x1b[H`, `\x1bOH`,
    // `\x1b[1~`, `\x1b[7~` e i gemelli End), arrivano tutte come `input` vuoto
    // senza nessun flag alzato — indistinguibili fra loro e da qualunque altro
    // tasto senza nome.
    //
    // `^D` è il delete-forward, e anche lì il motivo è un limite di Ink: il
    // Backspace fisico manda `\x7f` e il Canc manda `\x1b[3~`, ma
    // `parseKeypress` li battezza ENTRAMBI `delete` — a valle sono lo stesso
    // evento. `key.delete` va quindi al backspace (il tasto che si usa davvero)
    // e la cancellazione in avanti prende il suo tasto readline.
    //
    // `^U` svuota il campo in fuoco. Non è comodità: il backspace tenuto premuto
    // cancella UN carattere per CHUNK letto da stdin, non per pressione, quindi
    // svuotare un campo lungo a colpi di backspace è di fatto non eseguibile.
    if (input === 'a') setCursor({ ...cursor, caret: 0 });
    else if (input === 'e') setCursor({ ...cursor, caret: cpLen(value) });
    else if (input === 'd') io.setText(cursor.row, removeAt(value, cursor.caret));
    else if (input === 'u') {
      io.setText(cursor.row, '');
      setCursor({ ...cursor, caret: 0 });
    } else return false;
    return true;
  }

  if (key.leftArrow || key.rightArrow) {
    // CLAMP agli estremi, non wrap: a inizio campo `←` non deve saltare in
    // fondo. Le righe a scelta ciclano perché sono 3-5 voci; un testo no — il
    // salto sarebbe indistinguibile da uno sfarfallio.
    const d = key.leftArrow ? -1 : 1;
    setCursor({ ...cursor, caret: Math.max(0, Math.min(cpLen(value), cursor.caret + d)) });
    return true;
  }

  if (key.backspace || key.delete) {
    io.setText(cursor.row, removeAt(value, cursor.caret - 1));
    setCursor({ ...cursor, caret: Math.max(0, cursor.caret - 1) });
    return true;
  }

  if (input && !key.meta) {
    // `sanitizeTyped`: `useInput` consegna il CHUNK di stdin, quindi un
    // incollaggio porta dentro newline e byte di controllo — invisibili nel
    // campo ma contati da Ink nella larghezza della riga. Ed è per lo stesso
    // motivo che il caret avanza della LUNGHEZZA del chunk, non di uno.
    const ins = sanitizeTyped(input);
    io.setText(cursor.row, insertAt(value, cursor.caret, ins));
    setCursor({ ...cursor, caret: cursor.caret + cpLen(ins) });
    return true;
  }

  return false;
}
