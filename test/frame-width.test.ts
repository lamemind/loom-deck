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
      env: { ...process.env, LOOM_DECK_DOCS_ROOT: 'runtime' },
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

  // ② Nessun bordo MANGIATO. Una riga più larga del suo pane non allunga la
  //    riga composta — Ink la scrive su una griglia a celle fisse — ma copre le
  //    celle del vicino, e la prima a sparire è la colonna del bordo. Il
  //    controllo di larghezza da solo non lo vede: serve confrontare le colonne
  //    dei bordi con quelle della struttura più ricorrente del frame.
  // Si guardano SOLO le righe interne ai due pane — quelle con bordi oltre i
  // due del box esterno. Header, riga di navigazione e cornici orizzontali
  // hanno una forma propria e non dicono nulla sull'allineamento.
  const inPanes = lines.map(borderColumns).filter((cols_) => cols_.length > 2);
  if (inPanes.length === 0) return;
  const byShape = new Map<string, number>();
  for (const cols_ of inPanes) byShape.set(cols_.join(','), (byShape.get(cols_.join(',')) ?? 0) + 1);
  const [common] = [...byShape.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const expected = common.split(',').map(Number);
  lines.forEach((line, i) => {
    const got = borderColumns(line);
    if (got.length <= 2) return;
    // Un box annidato (il pannello di dettaglio) aggiunge colonne: va bene
    // finché non ne PERDE. Perderne una significa che il testo ci è passato
    // sopra — cioè la riga era più larga del suo pane.
    const missing = expected.filter((c) => !got.includes(c));
    assert.deepEqual(
      missing,
      [],
      `${label} riga ${i}: bordo mangiato alle colonne ${missing.join(',')}\n${line}`,
    );
  });
}

const CTRL_F = String.fromCharCode(6);

/** `[label, tasti, larghezze]` — le due schermate sostitutive (T52) si provano a
 *  una larghezza sola: il costo è un deck vero avviato per ogni combinazione. */
const SCENARIOS: Array<[string, string, number[]]> = [
  ['lista task', 'DD', [100, 176]],
  ['pane sessioni + dettaglio', 'DRDD', [100, 176]],
  ['task done in vista (filtri)', 'DDDDDDDD', [100, 176]],
  ['ricerca full-text', `${CTRL_F}deck`, [176]],
  ['reader fullscreen', `${CTRL_F}deckD\r`, [176]],
];

for (const [label, keys, widths] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: !CAN_RUN }, () => {
      assertFrameFits(capture(cols, 38, keys), cols, `${label}@${cols}`);
    });
  }
}
