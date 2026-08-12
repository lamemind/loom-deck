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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import { termWidth } from '../src/width.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
/** Progetto su cui girare: il cappello che contiene il deck come submodule. */
const PROJECT = dirname(PKG);
const TASKS = join(PROJECT, 'runtime', 'tasks.md');

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = hasPython() && existsSync(TASKS);

function capture(cols: number, rows: number, keys: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    'python3',
    [
      join(HERE, 'pty-frame.py'),
      String(cols),
      String(rows),
      PROJECT,
      join(PKG, 'node_modules', '.bin', 'tsx'),
      '--tsconfig',
      join(PKG, 'tsconfig.json'),
      join(PKG, 'src', 'cli.tsx'),
      '--keys',
      keys,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // NO_SPAWN: il gate manda tasti a un deck VERO, e qui un tasto è
      // un'azione — `⏎` apre una tab Ptyxis, `t` un terminale, `⏎` nel modale
      // edit committa. Senza freno ogni run dei test apriva finestre reali
      // (vedi `spawnOut` in cli.tsx).
      env: {
        ...process.env,
        LOOM_DECK_DOCS_ROOT: 'runtime',
        LOOM_DECK_NO_SPAWN: '1',
        ...extraEnv,
      },
    },
  );
}

const ESC = String.fromCharCode(27);
/** Toglie le sequenze CSI (colori, cursore): resta il testo che occupa colonne. */
function strip(line: string): string {
  return line
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, '')))
    .join('');
}

/**
 * Ultimo frame emesso: parte dall'ultima riga che INIZIA con l'angolo del box
 * esterno. Cercare l'ultimo `╭` nel buffer non basta — la schermata di ricerca
 * ha box annidati con lo stesso angolo, e il frame partirebbe da metà.
 */
function lastFrame(raw: string): string[] {
  const rows = raw.split(/\r?\n/).map(strip);
  const start = rows.findLastIndex((l) => l.startsWith('╭'));
  assert.ok(start >= 0, 'nessun frame catturato: il deck non ha renderizzato');
  return rows.slice(start);
}

/** Colonne in cui cade un bordo verticale su questa riga. */
function borderColumns(line: string): number[] {
  const out: number[] = [];
  let col = 0;
  for (const ch of line) {
    if (ch === '│') out.push(col);
    col += termWidth(ch);
  }
  return out;
}

function assertFrameFits(raw: string, cols: number, label: string) {
  const lines = lastFrame(raw).filter((l) => l !== '');
  assert.ok(lines.length > 3, `${label}: frame troppo corto (${lines.length} righe)`);

  // ① La riga occupa ESATTAMENTE le colonne del terminale, per entrambe le
  //    contabilità. Più larga → il terminale va a capo (riga vuota + tutto
  //    slittato in giù); più stretta → bordo e pane vicino slittano a sinistra.
  lines.forEach((line, i) => {
    const ink = stringWidth(line);
    const term = termWidth(line);
    assert.equal(ink, cols, `${label} riga ${i}: Ink la misura ${ink} invece di ${cols}\n${line}`);
    assert.equal(
      term,
      cols,
      `${label} riga ${i}: il terminale la disegna ${term} invece di ${cols}\n${line}`,
    );
  });

  // ② Nessun bordo MANGIATO — controllato SEPARATAMENTE per regione (vedi
  //    `splitRegions`): confrontare le righe di un box a piena larghezza con la
  //    forma dei pane darebbe un falso positivo, perché quel box la struttura a
  //    due pane la sostituisce.
  for (const region of splitRegions(lines)) assertBordersHold(region, label);
}

/** Due cose aprono un box a PIENA LARGHEZZA dentro la cornice del deck: un
 *  modale in flusso (`│ ╭…╮ │`, angoli round) e il blocco preview sotto le due
 *  liste (`│ ┌…┐ │`, angoli single — T70). Per quelle righe la struttura a due
 *  pane non esiste, le colonne di bordo sono le loro. Si separano quindi le
 *  regioni e ognuna viene confrontata con la propria forma ricorrente — dentro
 *  il box il controllo resta pieno (una riga che ne mangia il bordo destro esce
 *  dalla forma comune), ma non lo si misura col metro dei pane.
 *
 *  Il discriminante è il NUMERO di angoli sulla riga d'apertura, non lo stile né
 *  la profondità: i due pane stanno affiancati, quindi si aprono e si chiudono
 *  con DUE angoli sulla stessa riga (`│ ┌…┐ ┌…┐ │`); un box a piena larghezza ne
 *  ha uno solo. Contarli è ciò che tiene la coppia di pane fuori dalla regione
 *  full-width — altrimenti ci finirebbe dentro e la forma dei pane, che è la
 *  maggioranza, farebbe risultare "mangiato" il bordo di ogni riga di preview.
 *
 *  I due box a piena larghezza condividono le stesse colonne di bordo, quindi
 *  stanno nella stessa regione anche quando compaiono insieme. */
const countCorners = (line: string, chars: string) =>
  [...line].filter((ch) => chars.includes(ch)).length;

const isFullOpen = (line: string) => /^│ [╭┌]/.test(line) && countCorners(line, '╭┌') === 1;
const isFullClose = (line: string) => /^│ [╰└]/.test(line) && countCorners(line, '╰└') === 1;

function splitRegions(lines: string[]): Array<Array<{ line: string; i: number }>> {
  const main: Array<{ line: string; i: number }> = [];
  const full: Array<{ line: string; i: number }> = [];
  let inFull = false;
  lines.forEach((line, i) => {
    if (isFullOpen(line)) inFull = true;
    (inFull ? full : main).push({ line, i });
    if (inFull && isFullClose(line)) inFull = false;
  });
  return [main, full].filter((r) => r.length > 0);
}

/**
 * Una riga più larga del suo box non allunga la riga composta — Ink la scrive su
 * una griglia a celle fisse — ma copre le celle del vicino, e la prima a sparire
 * è la colonna del bordo. Il controllo di larghezza da solo non lo vede: serve
 * confrontare le colonne dei bordi con quelle della struttura più ricorrente
 * della regione.
 *
 * Si guardano SOLO le righe interne ai box — quelle con bordi oltre i due della
 * cornice esterna. Header, riga di navigazione e cornici orizzontali hanno una
 * forma propria e non dicono nulla sull'allineamento.
 */
function assertBordersHold(region: Array<{ line: string; i: number }>, label: string) {
  const inner = region.map((r) => borderColumns(r.line)).filter((cols_) => cols_.length > 2);
  if (inner.length === 0) return;
  const byShape = new Map<string, number>();
  for (const cols_ of inner) byShape.set(cols_.join(','), (byShape.get(cols_.join(',')) ?? 0) + 1);
  const [common] = [...byShape.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const expected = common.split(',').map(Number);
  for (const { line, i } of region) {
    const got = borderColumns(line);
    if (got.length <= 2) continue;
    // Un box annidato (il pannello di dettaglio) aggiunge colonne: va bene
    // finché non ne PERDE. Perderne una significa che il testo ci è passato
    // sopra — cioè la riga era più larga del suo box.
    const missing = expected.filter((c) => !got.includes(c));
    assert.deepEqual(
      missing,
      [],
      `${label} riga ${i}: bordo mangiato alle colonne ${missing.join(',')}\n${line}`,
    );
  }
}

const CTRL_F = String.fromCharCode(6);
const CTRL_A = String.fromCharCode(1);

/** Modale edit aperto sulla riga titolo (3 `D` dopo `E`), con due incollaggi da
 *  60 caratteri in coda: è il campo che porta dentro il box un testo di lunghezza
 *  arbitraria, cioè l'unico che può sfondarlo, e a 120 caratteri sfora il budget
 *  a entrambe le larghezze provate. */
const EDIT_TITOLO = 'DEDDDXX';

/** T61 — con la soglia reale (30gg) il contatore archiviabili è 0 su un progetto
 *  giovane, quindi il segmento non renderizza e lo scenario non proverebbe
 *  nulla. A 1 giorno entrano quasi tutte le Done: header al massimo della sua
 *  lunghezza, che è il caso che deve stare dentro il pane. */
const ARCHIVABLE_ON = { LOOM_DECK_ARCHIVABLE_DAYS: '1' };

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
  ['task done in vista (filtri)', 'DDDDDDDD', [100, 176]],
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
  // T66 — il detail: `DD` porta la selezione sulla prima task (il deck atterra
  // su `≡ tutte`), `\r` apre l'overlay. Le righe del task file sono l'unico
  // testo a lunghezza libera lì dentro, e la riga bottoni l'unica riga fissa
  // aggiunta — cioè i due modi in cui l'overlay può sfondare.
  ['detail task', 'DD\r', [100, 176]],
  // Fondo del testo (`G`): l'ultima schermata è quella con meno righe di
  // contenuto, dove uno scroll non clampato lascerebbe righe vuote e il box si
  // accorcerebbe sotto il budget.
  ['detail · fondo del testo', 'DD\rG', [100]],
  // Quattro `→` portano sull'ultima azione (`checkpoint`, l'etichetta più
  // lunga): il bottone selezionato è reso `inverse`, ed è la cella che deve
  // restare dentro il frame anche in coda alla riga.
  ['detail · ultima azione', 'DD\rRRRR', [100, 176]],
  // T91 — la ricerca dentro il detail: modale dentro modale. Il campo è l'unico
  // testo a lunghezza libera della riga che lo ospita, e la riga stessa è la
  // seconda riga FISSA aggiunta dentro l'overlay.
  ['detail · ricerca aperta', `DD\r${CTRL_F}task`, [100, 176]],
  // `D` dopo la query muove fra le occorrenze (non scrolla): il contatore `n/N`
  // cambia e con esso la larghezza della coda della riga.
  ['detail · ricerca · seconda occorrenza', `DD\r${CTRL_F}taskD`, [100]],
  // Zero occorrenze: la riga porta un avviso invece del contatore, ed è più
  // lunga di quello — il caso che sfonda se il budget è tarato sul contatore.
  ['detail · ricerca senza occorrenze', `DD\r${CTRL_F}zzqqww`, [100]],
  // Query più larga del campo: la finestra si ancora al caret, come nel modale
  // edit, e il testo non deve uscire dal box.
  ['detail · ricerca · query lunga', `DD\r${CTRL_F}X`, [100]],
  // T61 — il quarto segmento dell'header del pane task, provato CON i contatori
  // di finestra già a schermo (gli 8 `D` scrollano la lista → `↑↓`): da solo il
  // segmento starebbe ovunque, è la somma a riempire la riga. Niente modale
  // filtri per arrivarci — aprirlo e confermarlo PERSISTE la vista su disco, e un
  // gate di larghezza non deve lasciare dietro di sé la configurazione di chi lo
  // lancia.
  ['archiviabili · header pieno', 'DDDDDDDD', [100, 176], ARCHIVABLE_ON],
];

for (const [label, keys, widths, extraEnv] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: !CAN_RUN }, () => {
      assertFrameFits(capture(cols, 38, keys, extraEnv), cols, `${label}@${cols}`);
    });
  }
}

// T91 — il budget d'ALTEZZA, che gli scenari sopra non provano: girano tutti a
// 38 righe, dove due righe in più non si notano. Il campo di ricerca è la riga
// fissa che, non scalata dalla cornice, fa sfondare `rows` su un terminale basso
// — e Ink che sfonda cade nel ramo `clearTerminal`, che su VTE versa un frame
// nello scrollback a ogni tick del poll.
for (const rows of [16, 20]) {
  test(`altezza · detail con ricerca @ ${rows} righe`, { skip: !CAN_RUN }, () => {
    const raw = capture(100, rows, `DD\r${CTRL_F}task`);
    const frame = lastFrame(raw).filter((l) => l !== '');
    assert.ok(
      frame.length <= rows,
      `frame di ${frame.length} righe in un terminale di ${rows}`,
    );
  });
}
