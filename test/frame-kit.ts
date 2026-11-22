// T232 — gli strumenti comuni dei gate di LARGHEZZA (`frame-width*.test.ts`):
// la cattura a geometria variabile, la lettura del frame riga per riga, le due
// misure che il gate pretende su ogni riga — la larghezza esatta e i bordi
// intatti — e le fixture che più file usano.
//
// Non è un file di test (`*.test.ts`): il runner non lo esegue, lo importano.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { PROJECT, runDeck } from './pty-harness.js';
import { termWidth } from '../src/width.js';
import { SPAWN_ACTIONS } from '../src/spawn-catalog.js';

/** Il verdetto di vitalità che `pty-frame.py` appende (`<<PROC …>>`): qui va
 *  POTATO. Questo gate misura ogni riga catturata contro la larghezza del
 *  terminale, e una riga di servizio larga quindici colonne farebbe fallire
 *  ogni scenario per un difetto che non esiste. Lo legge invece il gate dei
 *  modi, dove l'uscita del processo è l'esito sotto misura. */
const PROC_VERDICT = /\n<<PROC [^>]*>>\n?$/;

export function capture(
  cols: number,
  rows: number,
  keys: string,
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = PROJECT,
): string {
  return runDeck({ cols, rows, keys, cwd, env: extraEnv }).replace(PROC_VERDICT, '');
}

const ESC = String.fromCharCode(27);
/** Toglie le sequenze CSI (colori, cursore): resta il testo che occupa colonne. */
export function strip(line: string): string {
  return line
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, '')))
    .join('');
}

/**
 * Ultimo frame INTERO emesso: dall'ultima riga che apre il box esterno alla sua
 * chiusura. Le righe si riconoscono dall'inizio — i box annidati (schermata di
 * ricerca, modali in flusso) portano gli stessi angoli ma preceduti da `│ `,
 * quindi un `lastIndexOf` sul carattere farebbe partire il frame da metà.
 *
 * La chiusura non è un dettaglio: il deck ridisegna anche mentre la cattura si
 * sta chiudendo (il poll, e durante una generazione il tick da 1s del
 * contatore), quindi l'ultima apertura nel buffer può appartenere a un redraw
 * scritto a metà. Misurare quello fa fallire il gate su righe che il terminale
 * non ha ancora finito di ricevere — un guasto della CATTURA che si presenta
 * come un difetto di larghezza, e che compare solo quando la macchina è carica.
 */
export function lastFrame(raw: string): string[] {
  const rows = raw.split(/\r?\n/).map(strip);
  const end = rows.findLastIndex((l) => l.startsWith('╰'));
  const start = end >= 0 ? rows.slice(0, end).findLastIndex((l) => l.startsWith('╭')) : -1;
  assert.ok(start >= 0, 'nessun frame intero catturato: il deck non ha renderizzato');
  return rows.slice(start, end + 1);
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

export function assertFrameFits(raw: string, cols: number, label: string) {
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

/** Colonne della STRUTTURA su una riga d'apertura o chiusura di box: i bordi
 *  verticali della cornice più gli angoli, che cadono esattamente sulle stesse
 *  colonne dei `│` delle righe interne. */
function structuralColumns(line: string): number[] {
  const out: number[] = [];
  let col = 0;
  for (const ch of line) {
    if ('│┌┐└┘╭╮╰╯├┤'.includes(ch)) out.push(col);
    col += termWidth(ch);
  }
  return out;
}

/** La riga che DICHIARA la struttura della regione: la sua apertura, cioè la
 *  prima riga che porta un angolo subito dopo la cornice esterna (`│ ┌`, `│ ╭`).
 *  L'ancora `^│ [┌╭]` è ciò che la distingue da una riga di CONTENUTO che porta
 *  gli stessi glifi in mezzo al testo. */
function openerColumns(region: Array<{ line: string; i: number }>): number[] | null {
  const opener = region.find((r) => /^│ [┌╭]/.test(r.line));
  return opener ? structuralColumns(opener.line) : null;
}

/**
 * Una riga più larga del suo box non allunga la riga composta — Ink la scrive su
 * una griglia a celle fisse — ma copre le celle del vicino, e la prima a sparire
 * è la colonna del bordo. Il controllo di larghezza da solo non lo vede: serve
 * confrontare le colonne dei bordi con quelle della struttura della regione.
 *
 * La struttura si legge dalla riga di APERTURA della regione, non da un voto di
 * maggioranza sulle righe interne. Il voto sembra equivalente e non lo è: i
 * glifi di raggruppamento delle epiche (`┌ │ └` che legano un cappello alle sue
 * figlie, T67) sono CONTENUTO di una riga task, ma restano `│` come i bordi —
 * quando un'epica con molte figlie riempie il pane, quelle righe diventano la
 * maggioranza e la loro colonna di bracket entra nella forma attesa. Da lì ogni
 * riga che il bracket non ce l'ha — l'header del pane, una task senza cappello —
 * risulta col «bordo mangiato» senza che niente sia fuori posto. È un falso
 * positivo che dipende dai DATI del progetto su cui gira il gate, quindi compare
 * e sparisce da solo al variare della lista task.
 *
 * Si guardano SOLO le righe interne ai box — quelle con bordi oltre i due della
 * cornice esterna. Header, riga di navigazione e cornici orizzontali hanno una
 * forma propria e non dicono nulla sull'allineamento.
 */
export function assertBordersHold(region: Array<{ line: string; i: number }>, label: string) {
  const expected = openerColumns(region);
  // Nessuna apertura nella regione (cattura parziale, regione di sole righe
  // piatte): non c'è una struttura dichiarata contro cui misurare.
  if (!expected || expected.length <= 2) return;
  for (const { line, i } of region) {
    const got = borderColumns(line);
    if (got.length <= 2) continue;
    // Un box annidato (il pannello di dettaglio) aggiunge colonne: va bene
    // finché non ne PERDE. Perderne una significa che il testo ci è passato
    // sopra — cioè la riga era più larga del suo box.
    const missing: number[] = expected.filter((c) => !got.includes(c));
    assert.deepEqual(
      missing,
      [],
      `${label} riga ${i}: bordo mangiato alle colonne ${missing.join(',')}\n${line}`,
    );
  }
}

/** T203 — i `D` che dalla prima riga della pagina azioni portano sulla riga
 *  `id`. Derivati dal catalogo e non contati a mano: una riga aggiunta in mezzo
 *  (la `regia` di T203, prima di `bare`) spostava di uno gli scenari sotto, che
 *  restavano verdi misurando la riga accanto a quella del loro nome. */
export function toSpawnRow(id: string): string {
  const at = SPAWN_ACTIONS.findIndex((a) => a.id === id);
  if (at < 0) throw new Error(`riga ${id} assente dal catalogo di spawn`);
  return 'D'.repeat(at);
}

/** T61 — con la soglia reale (30gg) il contatore archiviabili è 0 su un progetto
 *  giovane, quindi il segmento non renderizza e lo scenario non proverebbe
 *  nulla. A 1 giorno entrano quasi tutte le Done: header al massimo della sua
 *  lunghezza, che è il caso che deve stare dentro il pane. */
export const ARCHIVABLE_ON = { LOOM_DECK_ARCHIVABLE_DAYS: '1' };

/**
 * T118 — progetto SINTETICO su cui provare la lista task a id di larghezza
 * mista, con le colonne piene.
 *
 * Il cappello vero non serve allo scopo e non basterebbe: i suoi id sono quelli
 * che ha oggi, quindi uno scenario tarato su di loro è un calco che scade al
 * primo `create-task`. Qui la popolazione è scritta dal test — `T9` accanto a
 * `T1024` sono i tre livelli di padding insieme, cioè il caso che il cappello
 * non produrrà mai.
 *
 * `HOME` è dirottato con la cwd: la lista sessioni si legge da
 * `~/.claude/projects/<hash della cwd>`, quindi un HOME finto è ciò che rende
 * il contatore `(N)` un dato del test invece che di chi lo lancia.
 */
export function mixedIdProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'deck-mixed-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'runtime', 'tasks'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'loom'), { recursive: true });

  // T121 — un `name` più largo del budget della testata: è l'unico pezzo di
  // lunghezza libera di quella riga, quindi l'unico che può spingerla dentro la
  // versione ancorata a destra. Su un progetto vero il nome è corto per caso, e
  // uno scenario tarato su quello non proverebbe il taglio.
  writeFileSync(
    join(proj, '.claude', 'loom-works.json'),
    JSON.stringify({
      id: 'proj',
      emoji: '🧵',
      name: 'progetto-dal-nome-molto-lungo-che-non-entra-in-una-testata-stretta',
    }),
  );

  const rows = [
    // Una descrizione più larga del pane e una molto corta: la prima prova il
    // taglio contro la colonna riservata, la seconda il riempimento fra la fine
    // del testo e il bordo destro.
    ['T9', '🔥', '🟡', 'descrizione lunghissima che deve tagliarsi ben prima del contatore ' + 'x'.repeat(80)],
    ['T90', '⚡', '🔵', 'corta'],
    ['T102', '🔹', '✔️', 'media, con un glifo largo 🧵 in mezzo al testo'],
    ['T1024', '⚡', '🔵', 'la task con l’id più largo della lista'],
  ];
  writeFileSync(
    join(proj, 'runtime', 'tasks.md'),
    ['# Tasks', '', '## Tasks Overview', '', '| ID | Pri | Prog | Task |', '| --- | --- | --- | --- |']
      .concat(rows.map((r) => `| ${r.join(' | ')} |`))
      .join('\n') + '\n',
  );

  const projects = join(root, 'home', '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  // Contatori a una e a due cifre nella stessa lista: è la coppia che sposta il
  // bordo sinistro della colonna e lascia fermo quello destro.
  const bind: Array<[string, string | null]> = [
    ['1111', 'T9'],
    ['2222', 'T102'],
    ['3333', 'T102'],
    ['4444', null],
  ];
  const sidecar: string[] = [];
  bind.forEach(([sid, taskId], i) => {
    writeFileSync(
      join(projects, `${sid}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId: sid,
        cwd: proj,
        message: { role: 'user', content: `prompt della conversazione ${i}` },
      }) + '\n',
    );
    if (taskId) sidecar.push(JSON.stringify({ sessionId: sid, taskId }));
  });
  writeFileSync(join(proj, '.claude', 'loom', 'session-tasks.jsonl'), sidecar.join('\n') + '\n');

  return proj;
}
