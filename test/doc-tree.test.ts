// T160 — il lettore dell'albero doc, provato senza pseudo-terminale.
//
// Il modulo è puro per costruzione (nessun import da ink/react), e questi test
// sono ciò che quella purezza serve a permettere: un TSV fisso entra, un albero
// e delle celle escono. Quello che NON si prova qui è lo spawn dello script —
// quello lo copre il gate pty, con una cache del plugin finta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { termWidth } from '../src/width.js';
import {
  DOC_FLAG_W,
  buildDocTree,
  countFlagged,
  dirListing,
  docRoot,
  docWords,
  flagCell,
  flagNames,
  flatDocRows,
  loadDocText,
  parseDocTsv,
} from '../src/doc-tree.js';

/**
 * Il TSV che `doc-metrics.sh --format tsv` emette nel modo principale: la
 * tabella dei file, una riga vuota, quella delle cartelle.
 *
 * `runtime/reference/loom-deck` è assente dalla tabella delle cartelle APPOSTA:
 * è una cartella intermedia senza `.md` propri, e lo script aggrega per
 * `dirname` dei file — l'albero la deve dedurre, o la sua figlia `sessions`
 * resterebbe irraggiungibile. È il caso che un parser scritto sulla sola tabella
 * romperebbe in silenzio.
 */
const TSV = [
  'PATH\tCHAR\tTLDR\tFLAGS',
  'runtime/reference/loom-deck/sessions/spawn.md\t19229\t420\tSPLIT',
  'runtime/project/plugin-dev.md\t16125\t0\tSPLIT NOTLDR ONLINE',
  'runtime/reference/assumed-knowledge.md\t537\t293\tTLDR-ORFANA CONFIG',
  'runtime/reference/INDEX.md\t12000\t0\tGEN',
  'runtime/reference/piccolo.md\t900\t80\tMERGE?',
  'runtime/tasks.md\t12019\t0\t-',
  '',
  'DIR\tFILES\tCHAR\tFLAGS',
  'runtime/reference\t3\t13437\tREGROUP',
  'runtime/reference/loom-deck/sessions\t1\t19229\t-',
  'runtime/project\t1\t16125\t-',
  'runtime\t1\t12019\t-',
  '',
].join('\n');

const DATA = parseDocTsv(TSV);

// ── parse ────────────────────────────────────────────────────────────────

test('parseDocTsv: legge le due tabelle dallo stesso stream', () => {
  assert.equal(DATA.files.length, 6);
  assert.equal(DATA.dirs.length, 4);
  assert.equal(DATA.hasDirs, true);
  assert.deepEqual(DATA.files[0], {
    path: 'runtime/reference/loom-deck/sessions/spawn.md',
    chars: 19229,
    tldr: 420,
    flags: ['SPLIT'],
  });
  assert.deepEqual(DATA.dirs[0], {
    path: 'runtime/reference',
    files: 3,
    chars: 13437,
    flags: ['REGROUP'],
  });
});

test('parseDocTsv: il discriminante è l\'header, non la posizione', () => {
  // Sotto override lo script apre con `# soglie: …`, e una riga vuota in più fra
  // le tabelle è legittima. Un parser che contasse le righe si romperebbe su
  // entrambe.
  const conRumore = parseDocTsv(
    ['# soglie: split=1000 merge=10 tldr=50 regroup=100 (OVERRIDE)', '', TSV].join('\n'),
  );
  assert.equal(conRumore.files.length, DATA.files.length);
  assert.equal(conRumore.dirs.length, DATA.dirs.length);
});

test('parseDocTsv: senza la tabella delle cartelle il parse degrada, non fallisce', () => {
  // Il deck esegue lo script dalla cache installata del plugin e può incontrare
  // una versione che emette la sola tabella dei file (P2). L'albero si costruisce
  // lo stesso: `hasDirs` è ciò che l'header mostra per non far leggere un
  // `REGROUP (0)` come «nessuna cartella da riorganizzare».
  const soloFile = parseDocTsv(TSV.slice(0, TSV.indexOf('\n\nDIR')));
  assert.equal(soloFile.hasDirs, false);
  assert.equal(soloFile.dirs.length, 0);
  assert.equal(soloFile.files.length, 6);
  assert.ok(buildDocTree(soloFile).length > 0, "l'albero deve reggere senza la seconda tabella");
});

test('parseDocTsv: un flag che il deck non conosce si scarta', () => {
  // La sua short non esisterebbe, e la cella uscirebbe di larghezza — cioè il
  // bordo del pane sparirebbe (invariante ③ di width.ts).
  const d = parseDocTsv(['PATH\tCHAR\tTLDR\tFLAGS', 'a/b.md\t10\t0\tSPLIT FUTURO'].join('\n'));
  assert.deepEqual(d.files[0]!.flags, ['SPLIT']);
});

// ── la cella dei flag ────────────────────────────────────────────────────

test('flagCell: larghezza COSTANTE, qualunque sia il numero di flag', () => {
  for (const flags of [[], ['SPLIT'], ['SPLIT', 'NOTLDR'], ['SPLIT', 'NOTLDR', 'ONLINE']] as const) {
    assert.equal(flagCell([...flags]).length, DOC_FLAG_W, `larghezza rotta su ${flags.join(',')}`);
  }
});

test('flagCell: il quarto flag diventa un `+`, e a cedere sono i descrittivi', () => {
  // L'ordine di lettura mette in testa i flag che chiamano un'operazione: a
  // restare fuori dalle tre short deve essere sempre l'informazione che non
  // produce un'azione.
  const cella = flagCell(['ONLINE', 'CONFIG', 'SPLIT', 'TLDR-ORFANA']);
  assert.equal(cella.length, DOC_FLAG_W);
  assert.ok(cella.startsWith('SPL ORF ONL'), `ordine di lettura non rispettato: "${cella}"`);
  assert.ok(cella.endsWith('+'), `overflow non segnalato: "${cella}"`);
});

test('flagNames: i nomi interi, nello stesso ordine delle short', () => {
  assert.deepEqual(flagNames(['CONFIG', 'SPLIT', 'NOTLDR']), ['SPLIT', 'NOTLDR', 'CONFIG']);
  assert.deepEqual(flagNames([]), []);
});

// ── l'albero ─────────────────────────────────────────────────────────────

test('buildDocTree: pre-ordine, cartelle prima dei file, radice sola', () => {
  const rows = buildDocTree(DATA);
  const forma = rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.kind === 'dir' ? '/' : ''}`);
  assert.deepEqual(forma, [
    'runtime/',
    '  project/',
    '    plugin-dev.md',
    '  reference/',
    '    loom-deck/',
    '      sessions/',
    '        spawn.md',
    '    INDEX.md',
    '    assumed-knowledge.md',
    '    piccolo.md',
    '  tasks.md',
  ]);
});

test('buildDocTree: una cartella intermedia assente dalla misura è una riga di struttura', () => {
  // `runtime/reference/loom-deck` non ha `.md` propri, quindi lo script non la
  // emette: l'albero la deduce e la mostra a zero file e zero char. Senza,
  // `sessions/` non avrebbe un padre e finirebbe fra le radici.
  const rows = buildDocTree(DATA);
  const intermedia = rows.find((r) => r.path === 'runtime/reference/loom-deck')!;
  assert.ok(intermedia, 'la cartella intermedia non è nell\'albero');
  assert.equal(intermedia.kind, 'dir');
  assert.equal(intermedia.files, 0);
  assert.equal(intermedia.chars, 0);
  assert.deepEqual(intermedia.flags, []);
  assert.equal(docRoot(DATA), 'runtime', 'la radice deve restare una sola');
});

test('buildDocTree: la riga porta il path come chiave e l\'ultimo segmento come nome', () => {
  // La selezione è keyed sul path (la lista si riordina a ogni scan), il nome è
  // solo ciò che si disegna: confonderli spawnerebbe sul bersaglio sbagliato.
  const riga = buildDocTree(DATA).find((r) => r.name === 'spawn.md')!;
  assert.equal(riga.path, 'runtime/reference/loom-deck/sessions/spawn.md');
  assert.equal(riga.chars, 19229);
  assert.equal(riga.tldr, 420);
});

// ── le viste piatte ──────────────────────────────────────────────────────

test('flatDocRows: nessuna cartella antenata, e il nome perde la radice', () => {
  const split = flatDocRows(DATA, ['SPLIT']);
  assert.deepEqual(
    split.map((r) => r.name),
    ['reference/loom-deck/sessions/spawn.md', 'project/plugin-dev.md'],
  );
  assert.ok(
    split.every((r) => r.kind === 'file'),
    'una vista per flag di file non deve portare cartelle',
  );
});

test('flatDocRows: ordine char decrescente — il più grosso si guarda per primo', () => {
  const chars = flatDocRows(DATA, ['SPLIT', 'MERGE?']).map((r) => r.chars);
  assert.deepEqual(chars, [...chars].sort((a, b) => b - a));
});

test('flatDocRows: la vista REGROUP elenca cartelle, e porta il loro conteggio file', () => {
  const regroup = flatDocRows(DATA, ['REGROUP']);
  assert.equal(regroup.length, 1);
  assert.equal(regroup[0]!.kind, 'dir');
  assert.equal(regroup[0]!.path, 'runtime/reference');
  assert.equal(regroup[0]!.files, 3);
});

test('countFlagged coincide con le righe che la vista mostra', () => {
  // L'invariante del catalogo: un header che dice un numero e una lista che ne
  // mostra un altro è un contatore che mente, e non c'è schermata che lo dica.
  for (const flags of [['SPLIT'], ['MERGE?'], ['REGROUP'], ['TLDR>CAP', 'NOTLDR', 'TLDR-ORFANA']]) {
    assert.equal(
      countFlagged(DATA, flags as never),
      flatDocRows(DATA, flags as never).length,
      `contatore e lista divergono su ${flags.join('+')}`,
    );
  }
});

// ── i due buchi del titolo e del prompt ──────────────────────────────────

test('docWords: il path reso a parole, per il titolo della tab', () => {
  // L'alfabeto di `_sane_note` non ha né `/` né `.`: lasciandoceli cadere le
  // parole si salderebbero, e la tab mostrerebbe un nome diverso da quello che
  // la lista del deck legge dal sidecar.
  assert.equal(docWords('runtime/reference/doc-system'), 'runtime reference doc-system');
  assert.equal(docWords('runtime/project/plugin-dev.md'), 'runtime project plugin-dev');
});

// ── lo sheet di una cartella ─────────────────────────────────────────────

test('dirListing: elenca i file DIRETTI, coi loro flag', () => {
  const testo = dirListing(DATA, 'runtime/reference');
  assert.ok(testo.startsWith('# runtime/reference'), 'manca il titolo');
  assert.ok(testo.includes('3 file'), 'manca il conteggio della cartella');
  assert.ok(testo.includes('REGROUP'), 'manca il flag della cartella');
  assert.ok(testo.includes('piccolo.md'), 'manca un file diretto');
  assert.ok(testo.includes('MERGE?'), 'manca il flag di un file diretto');
  assert.ok(
    !testo.includes('spawn.md'),
    'un file di una SOTTOcartella non è diretto: il regroup si decide su questo livello',
  );
});

// ── il confine di caricamento ────────────────────────────────────────────

test('loadDocText sanifica al confine, o il wrap conta meno colonne di quante Ink ne disegna', () => {
  // La catena dichiarata in `markdown.ts` è `sanitize → parseMarkdown →
  // wrapWithOffsets`, e la prima non conserva la lunghezza: applicarla più a
  // valle sposterebbe gli offset degli span. Il difetto che questo test blocca è
  // stato trovato dal gate pty su un `.md` vero — `↔` in una testata e `⚡`/`✔️`
  // in una tabella facevano uscire la riga dal box di una colonna, mangiandone
  // il bordo.
  const dir = mkdtempSync(join(tmpdir(), 'doc-tree-'));
  writeFileSync(join(dir, 'x.md'), '# Mapping sorgente ↔ cache\n\n| ⚡ | ✔️ |\n');
  const testo = loadDocText(dir, 'x.md')!;
  assert.ok(testo, 'il file non è stato letto');
  // `\n` e `\t` restano fuori dall'insieme di rischio di `sanitize` per scelta
  // (li normalizzano i chiamanti del wrap), e sulle due conte divergono: vanno
  // esclusi qui, o il test misurerebbe proprio l'eccezione dichiarata.
  for (const ch of [...testo].filter((c) => !/\s/.test(c))) {
    assert.equal(
      stringWidth(ch),
      termWidth(ch),
      `glifo discorde sopravvissuto al confine: ${JSON.stringify(ch)}`,
    );
  }
  assert.equal(loadDocText(dir, 'non-esiste.md'), null, 'un file assente deve dare null');
});

test('dirListing: una cartella di sole sottocartelle lo dice', () => {
  const testo = dirListing(DATA, 'runtime/reference/loom-deck');
  assert.ok(
    testo.includes('sottocartelle'),
    `un corpo vuoto si legge come uno sheet rotto: ${testo}`,
  );
});
