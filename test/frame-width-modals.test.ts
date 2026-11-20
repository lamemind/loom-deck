// T232 — gate di larghezza (vedi `frame-width.test.ts`): la ricerca, il modale
// edit, l'assegnazione, il finder, la conferma di eliminazione e il modale delle
// combo.

import { test } from 'node:test';
import { CTRL_A, CTRL_F, SKIP } from './pty-harness.js';
import { ARCHIVABLE_ON, assertFrameFits, capture } from './frame-kit.js';

/** Modale edit aperto sulla riga titolo (3 `D` dopo `E`), con due incollaggi da
 *  60 caratteri in coda: è il campo che porta dentro il box un testo di lunghezza
 *  arbitraria, cioè l'unico che può sfondarlo, e a 120 caratteri sfora il budget
 *  a entrambe le larghezze provate. */
const EDIT_TITOLO = 'DEDDDXX';

/** `[label, tasti, larghezze, env?]` — le due schermate sostitutive (T52) si
 *  provano a una larghezza sola: il costo è un deck vero avviato per ogni
 *  combinazione. */
const SCENARIOS: Array<[string, string, number[], NodeJS.ProcessEnv?]> = [
  ['ricerca full-text', `${CTRL_F}deck`, [176]],
  ['reader fullscreen', `${CTRL_F}deckD\r`, [176]],
  // T54 — le tre posizioni del caret in un titolo più lungo del budget. Non sono
  // lo stesso frame: la finestra è ancorata al cursore, quindi in coda taglia in
  // testa, a inizio campo taglia in coda, e in mezzo taglia da entrambi i lati —
  // ed è lì che il cursore cade dentro la riga invece che al suo bordo.
  ['edit titolo lungo', EDIT_TITOLO, [100, 176]],
  ['edit caret a inizio (^A)', `${EDIT_TITOLO}${CTRL_A}`, [100, 176]],
  ['edit caret in mezzo', `${EDIT_TITOLO}${'L'.repeat(30)}`, [100]],
  // T57 — `R` porta il focus sul pane sessioni, `A` apre la schermata di
  // assegnazione: righe task a piena larghezza, più il titolo che ripete la
  // conversazione (hash + nota/etichetta, l'unico pezzo di lunghezza libera lì
  // sopra). `X` incolla 60 caratteri nel campo filtro — è il campo di testo
  // della schermata, cioè l'unico che può sfondarne il box.
  ['assegna sessione a task', 'RA', [100, 176]],
  ['assegna · filtro lungo', 'RAX', [100]],
  // T169 — il finder: la stessa riga task dell'assegnazione, più la preview
  // riservata sotto la lista. Il backtick manda la `T` letterale (nel driver
  // pty `T` è il tab). A campo vuoto la lista è intera, cioè il caso più alto;
  // `deck` accende l'evidenza del testo, che spezza la descrizione in segmenti;
  // `X` incolla 60 caratteri nel campo, l'unico testo libero della schermata.
  ['finder · lista intera', '`T', [100, 176]],
  ['finder · testo evidenziato', '`Tdeck', [100, 176]],
  ['finder · campo lungo', '`TX', [100]],
  // T112 — la conferma di eliminazione sulla singola task: box a piena
  // larghezza in flusso, con dentro la riga dell'effetto (testo fisso, la più
  // lunga) e l'elenco degli ID. `K` = CANC nella mappa di `pty-frame.py`.
  ['conferma · singola task', 'DDK', [80, 100, 176]],
  // Il bulk: l'elenco ID cresce con l'insieme, ed è il pezzo che sfonda se il
  // troncamento `+N` non lo tiene. La soglia a 1 giorno riempie la vista.
  ['conferma · bulk archiviabili', 'TTK', [80, 100, 176], ARCHIVABLE_ON],
  // T194 — il modale delle combo: le generali vanno a capo fra le voci e le colonne
  // si dividono la riga, dentro due box annidati.
  ['modale combo', 'H', [80, 100, 176]],
];

for (const [label, keys, widths, extraEnv] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      assertFrameFits(capture(cols, 38, keys, extraEnv), cols, `${label}@${cols}`);
    });
  }
}
