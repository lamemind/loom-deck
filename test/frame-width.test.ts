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

function capture(cols: number, rows: number, keys: string): string {
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
      env: { ...process.env, LOOM_DECK_DOCS_ROOT: 'runtime', LOOM_DECK_NO_SPAWN: '1' },
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
  //    `splitRegions`): confrontare le righe di un modale con la forma dei pane
  //    darebbe un falso positivo, perché il modale quella struttura la sostituisce.
  for (const region of splitRegions(lines)) assertBordersHold(region, label);
}

/** Un modale in flusso apre un box a PIENA LARGHEZZA dentro la cornice del deck
 *  (`│ ╭…╮ │` … `│ ╰…╯ │`): per quelle righe la struttura a due pane non esiste,
 *  le colonne di bordo sono le sue. Si separano quindi le regioni e ognuna viene
 *  confrontata con la propria forma ricorrente — dentro il modale il controllo
 *  resta pieno (una riga che ne mangia il bordo destro esce dalla forma comune),
 *  ma non lo si misura col metro dei pane.
 *
 *  L'angolo ROUND a profondità 1 è il discriminante: il pannello di dettaglio è
 *  anch'esso un box annidato, ma sta DENTRO un pane (`│ │ ┌`), conserva le
 *  colonne dei pane e va confrontato con loro. */
const MODAL_OPEN = /^│ ╭/;
const MODAL_CLOSE = /^│ ╰/;

function splitRegions(lines: string[]): Array<Array<{ line: string; i: number }>> {
  const main: Array<{ line: string; i: number }> = [];
  const modal: Array<{ line: string; i: number }> = [];
  let inModal = false;
  lines.forEach((line, i) => {
    if (MODAL_OPEN.test(line)) inModal = true;
    (inModal ? modal : main).push({ line, i });
    if (inModal && MODAL_CLOSE.test(line)) inModal = false;
  });
  return [main, modal].filter((r) => r.length > 0);
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

/** `[label, tasti, larghezze]` — le due schermate sostitutive (T52) si provano a
 *  una larghezza sola: il costo è un deck vero avviato per ogni combinazione. */
const SCENARIOS: Array<[string, string, number[]]> = [
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
];

for (const [label, keys, widths] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: !CAN_RUN }, () => {
      assertFrameFits(capture(cols, 38, keys), cols, `${label}@${cols}`);
    });
  }
}
