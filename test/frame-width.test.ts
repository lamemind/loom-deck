// GATE di larghezza sul frame intero — il test che rende il fix definitivo.
//
// Gli unit di `width.test.ts` difendono le primitive; questo difende il
// RISULTATO: renderizza il deck vero in uno pseudo-terminale di larghezza nota
// e pretende che ogni riga emessa misuri esattamente `columns`, con ENTRAMBE le
// contabilità — quella di Ink (`string-width`) e quella del terminale
// (`termWidth`).
//
// Una riga più larga di `columns` va a capo: compare la riga vuota e tutto
// quello che sta sotto slitta giù di una. Una più stretta sposta a sinistra il
// bordo del pane. Sono i due sintomi che hanno riaperto il difetto due volte:
// qui falliscono come test, non come screenshot.
//
// Il deck ha bisogno di un TTY vero (Ink non renderizza altrimenti) e di una
// geometria imposta: da qui l'helper Python con `pty.openpty` + `TIOCSWINSZ`.
// Senza python3, o senza un progetto loom su cui girare, il gate si salta
// invece di fallire: è uno smoke-test d'ambiente, non un unit.
//
// T232 — i gate di larghezza stanno in più file `frame-width*.test.ts`, uno per
// gruppo di schermate: il runner esegue i file in parallelo e le catture di un
// file in serie. Le misure sul frame sono in `frame-kit.ts`, il lancio del deck
// in `pty-harness.ts`. Questo file tiene il banco del gate stesso, la lista task,
// i pane sessioni e le viste.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { SKIP } from './pty-harness.js';
import { ARCHIVABLE_ON, assertBordersHold, assertFrameFits, capture, lastFrame, mixedIdProject } from './frame-kit.js';

// ── il gate del gate ────────────────────────────────────────────────────────
// `assertBordersHold` è l'unico pezzo di questo file che decide da sé cosa sia
// «struttura», e la decisione è già stata sbagliata una volta: dedotta a voto
// di maggioranza sulle righe, prendeva per bordo il bracket delle epiche (T67)
// e bocciava l'header del pane. Un falso positivo così non si vede finché i
// DATI del progetto non lo scatenano — serve quindi un banco che non dipenda
// da tasks.md né dal pty, e che tenga i DUE lati: non deve bocciare una riga
// sana, deve bocciare una riga che il bordo lo mangia davvero.
const REG = (lines: string[]) => lines.map((line, i) => ({ line, i }));
const holds = (lines: string[]) => {
  try {
    assertBordersHold(REG(lines), 'banco');
    return true;
  } catch {
    return false;
  }
};

test('il gate legge la struttura dall’apertura, non a maggioranza', () => {
  // Il bracket epica (`┌ │ └` come CONTENUTO, colonna 18) sta sulla
  // maggioranza delle righe: la sua colonna NON deve entrare fra le attese, o
  // l'header del pane — che il bracket non ce l'ha — risulta col bordo
  // mangiato senza che niente sia fuori posto.
  const conBracket = [
    '│ ┌──────────────────────────┐ ┌──────────────┐ │',
    '│ │ Tasks (12/105) · 93 nasc │ │ Sessions (12)│ │',
    '│ │   T142  🔥  ┌ cappello   │ │   sessione 1 │ │',
    '│ │   T141  🔥  │ figlia uno │ │   sessione 2 │ │',
    '│ │   T140  ⚡  └ figlia due │ │   sessione 3 │ │',
    '│ └──────────────────────────┘ └──────────────┘ │',
  ];
  assert.equal(holds(conBracket), true, 'header bocciato dal bracket delle epiche');
});

test('il gate morde ancora: una riga che copre il bordo del pane fallisce', () => {
  // Stessa struttura, ma la riga lunga ha coperto la colonna del bordo destro
  // del primo pane: è esattamente il guasto che il gate esiste per prendere.
  const bordoMangiato = [
    '│ ┌──────────────────────────┐ ┌──────────────┐ │',
    '│ │ Tasks (12/105) · 93 nasc │ │ Sessions (12)│ │',
    '│ │ riga lunghissima che sfonda  │ │ sessione 1 │ │',
    '│ └──────────────────────────┘ └──────────────┘ │',
  ];
  assert.equal(holds(bordoMangiato), false, 'un bordo coperto non viene più rilevato');
});

/** `[label, tasti, larghezze, env?]` — le due schermate sostitutive (T52) si
 *  provano a una larghezza sola: il costo è un deck vero avviato per ogni
 *  combinazione. */
const SCENARIOS: Array<[string, string, number[], NodeJS.ProcessEnv?]> = [
  ['lista task', 'DD', [100, 176]],
  ['pane sessioni + dettaglio', 'DRDD', [100, 176]],
  // T59 — il pane sessioni della riga `≡ tutte` (dove il deck atterra, quindi
  // nessun `D` prima di `R`). È l'unica vista che aggiunge il task id inline
  // sulla riga: colonne sottratte al titolo che le altre non pagano, cioè
  // esattamente il tipo di taglio che sfonda il pane se sbagliato.
  ['pane sessioni · vista tutte', 'RDD', [100, 176]],
  // T110 — la stessa vista su un pane STRETTO: è dove la colonna modello (3 +
  // gutter) compete davvero con la cella titolo, l'unica elastica. Se il termine
  // manca nella sottrazione di `titleW`, la riga esce dal pane proprio qui.
  ['pane sessioni · colonna modello', 'RDD', [80]],
  ['task done in vista (filtri)', 'DDDDDDDD', [100, 176]],
  // T61 — il quarto segmento dell'header del pane task, provato CON i contatori
  // di finestra già a schermo (gli 8 `D` scrollano la lista → `↑↓`): da solo il
  // segmento starebbe ovunque, è la somma a riempire la riga. Niente modale
  // filtri per arrivarci — aprirlo e confermarlo PERSISTE la vista su disco, e un
  // gate di larghezza non deve lasciare dietro di sé la configurazione di chi lo
  // lancia.
  ['archiviabili · header pieno', 'DDDDDDDD', [100, 176], ARCHIVABLE_ON],
  // T100 — col catalogo fisso l'header porta SEMPRE tutte le voci, non più solo
  // quelle a contatore non-zero: è la riga più lunga che i due pane abbiano mai
  // avuto, e la voce attiva ci sta dentro in video inverso. Gli 8 `D` dopo il
  // cambio vista rimettono a schermo anche i contatori `↑↓`, che il reset di
  // selezione aveva tolto — da sola nessuna voce sfonda, è la somma a farlo.
  ['viste task · nascoste attiva', 'TDDDDDDDD', [100, 176], ARCHIVABLE_ON],
  ['viste task · archiviabili attiva', 'TTDDDDDDDD', [100], ARCHIVABLE_ON],
  // La voce attiva in CODA al catalogo sessioni (`+N più vecchie`) su un pane
  // stretto: è il caso di D6 — il budget la serve per prima, le voci che la
  // precedono cadono, e ciò che resta a schermo non apre con un separatore
  // orfano.
  ['viste sessioni · vive attiva', 'RT', [100]],
  ['viste sessioni · più vecchie attiva', 'RTTT', [100, 176]],
  // T134/T194 — la riga due divide il budget con gli indicatori ancorati a
  // destra, e la legenda è ridotta a `H combo`: lo spazio fra le due metà lo
  // riempie `space-between`. Se il budget fosse sbagliato di una colonna, il
  // bordo sparirebbe proprio qui.
  ['legenda con indicatori', 'W', [80, 100, 176]],
];

for (const [label, keys, widths, extraEnv] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      assertFrameFits(capture(cols, 38, keys, extraEnv), cols, `${label}@${cols}`);
    });
  }
}

// Il pane STRETTO è il caso che conta: è lì che la colonna riservata compete
// davvero con la descrizione, l'unica cella elastica della riga.
for (const cols of [80, 100, 176]) {
  test(`gate larghezza · lista task a id misti @ ${cols} colonne`, { skip: SKIP }, () => {
    const proj = mixedIdProject();
    const raw = capture(cols, 38, 'DD', { HOME: join(dirname(proj), 'home') }, proj);
    assertFrameFits(raw, cols, `id misti@${cols}`);
    // La riga deve portare l'id PADDATO: senza, `T9` resterebbe nudo e le
    // colonne a valle slitterebbero — cioè il gate passerebbe la larghezza e
    // mancherebbe proprio ciò che T118 ha cambiato.
    const frame = lastFrame(raw).join('\n');
    assert.ok(frame.includes('T   9'), 'id a una cifra non paddato a cinque colonne');
    assert.ok(frame.includes('T 102'), 'id a tre cifre non paddato a cinque colonne');
  });
}
