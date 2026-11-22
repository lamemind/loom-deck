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
  DOC_FLAGS,
  buildDocTree,
  dirListing,
  flagCell,
  flagNames,
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
  'runtime/reference/loom-deck/sessions/spawn.md\t19229\t420\t-',
  'runtime/project/plugin-dev.md\t16125\t0\tONLINE',
  'runtime/reference/assumed-knowledge.md\t537\t293\t-',
  'runtime/reference/INDEX.md\t12000\t0\tGEN',
  'runtime/reference/piccolo.md\t900\t80\t-',
  'runtime/inbox/T160-x.md\t700\t0\tINBOX ONLINE',
  'runtime/tasks.md\t12019\t0\t-',
  '',
  'DIR\tFILES\tCHAR\tFLAGS',
  'runtime/reference\t3\t13437\t-',
  'runtime/reference/loom-deck/sessions\t1\t19229\t-',
  'runtime/project\t1\t16125\t-',
  'runtime/inbox\t1\t700\t-',
  'runtime\t1\t12019\t-',
  '',
].join('\n');

const DATA = parseDocTsv(TSV);

// ── parse ────────────────────────────────────────────────────────────────

test('parseDocTsv: legge le due tabelle dallo stesso stream', () => {
  assert.equal(DATA.files.length, 7);
  assert.equal(DATA.dirs.length, 5);
  assert.equal(DATA.hasDirs, true);
  assert.deepEqual(DATA.files[1], {
    path: 'runtime/project/plugin-dev.md',
    chars: 16125,
    tldr: 0,
    flags: ['ONLINE'],
  });
  assert.deepEqual(DATA.dirs[0], {
    path: 'runtime/reference',
    files: 3,
    chars: 13437,
    flags: [],
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
  // lo stesso: `hasDirs` è ciò che l'header mostra per non far leggere una
  // cartella a `0 file` come vuota.
  const soloFile = parseDocTsv(TSV.slice(0, TSV.indexOf('\n\nDIR')));
  assert.equal(soloFile.hasDirs, false);
  assert.equal(soloFile.dirs.length, 0);
  assert.equal(soloFile.files.length, 7);
  assert.ok(buildDocTree(soloFile).length > 0, "l'albero deve reggere senza la seconda tabella");
});

test('parseDocTsv: un flag che il deck non conosce si scarta', () => {
  // La sua short non esisterebbe, e la cella uscirebbe di larghezza — cioè il
  // bordo del pane sparirebbe (invariante ③ di width.ts).
  const d = parseDocTsv(['PATH\tCHAR\tTLDR\tFLAGS', 'a/b.md\t10\t0\tONLINE FUTURO'].join('\n'));
  assert.deepEqual(d.files[0]!.flags, ['ONLINE']);
});

test('parseDocTsv: i flag di un plugin più vecchio si scartano, la colonna resta vuota', () => {
  // Deck e plugin di versioni diverse convivono: un `doc-metrics.sh` che emette
  // ancora i flag di topologia e di TLDR non rompe il pane, lascia la colonna
  // vuota su quei file e tiene i flag descrittivi che il deck conosce.
  const d = parseDocTsv(
    [
      'PATH\tCHAR\tTLDR\tFLAGS',
      'a/b.md\t10\t0\tSPLIT NOTLDR',
      'a/c.md\t10\t0\tMERGE? TLDR>CAP ONLINE',
      '',
      'DIR\tFILES\tCHAR\tFLAGS',
      'a\t2\t20\tREGROUP',
    ].join('\n'),
  );
  assert.deepEqual(d.files[0]!.flags, []);
  assert.deepEqual(d.files[1]!.flags, ['ONLINE']);
  assert.deepEqual(d.dirs[0]!.flags, []);
});

test('DOC_FLAGS: i tre flag descrittivi che doc-metrics.sh emette, e nessun altro', () => {
  assert.deepEqual([...DOC_FLAGS], ['ONLINE', 'INBOX', 'GEN']);
});

// ── la cella dei flag ────────────────────────────────────────────────────

test('flagCell: larghezza COSTANTE, qualunque sia il numero di flag', () => {
  for (const flags of [[], ['GEN'], ['INBOX', 'ONLINE'], ['ONLINE', 'INBOX', 'GEN']] as const) {
    assert.equal(flagCell([...flags]).length, DOC_FLAG_W, `larghezza rotta su ${flags.join(',')}`);
  }
});

test('flagCell: le short nell\'ordine di lettura, non in quello di emissione', () => {
  const cella = flagCell(['INBOX', 'ONLINE']);
  assert.equal(cella.length, DOC_FLAG_W);
  assert.ok(cella.startsWith('ONL INB'), `ordine di lettura non rispettato: "${cella}"`);
  assert.ok(!cella.includes('+'), `nessun overflow con due flag: "${cella}"`);
});

test('flagNames: i nomi interi, nello stesso ordine delle short', () => {
  assert.deepEqual(flagNames(['GEN', 'INBOX', 'ONLINE']), ['ONLINE', 'INBOX', 'GEN']);
  assert.deepEqual(flagNames([]), []);
});

// ── l'albero ─────────────────────────────────────────────────────────────

test('buildDocTree: pre-ordine, cartelle prima dei file, radice sola', () => {
  const rows = buildDocTree(DATA);
  const forma = rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.kind === 'dir' ? '/' : ''}`);
  assert.deepEqual(forma, [
    'runtime/',
    '  inbox/',
    '    T160-x.md',
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
  assert.deepEqual(
    rows.filter((r) => r.depth === 0).map((r) => r.path),
    ['runtime'],
    'la radice deve restare una sola',
  );
});

test('buildDocTree: la riga porta il path come chiave e l\'ultimo segmento come nome', () => {
  // La selezione è keyed sul path (la lista si riordina a ogni scan), il nome è
  // solo ciò che si disegna: confonderli aprirebbe il file sbagliato.
  const riga = buildDocTree(DATA).find((r) => r.name === 'spawn.md')!;
  assert.equal(riga.path, 'runtime/reference/loom-deck/sessions/spawn.md');
  assert.equal(riga.chars, 19229);
  assert.equal(riga.tldr, 420);
});

// ── lo sheet di una cartella ─────────────────────────────────────────────

test('dirListing: elenca i file DIRETTI, coi loro flag', () => {
  const testo = dirListing(DATA, 'runtime/reference');
  assert.ok(testo.startsWith('# runtime/reference'), 'manca il titolo');
  assert.ok(testo.includes('3 file'), 'manca il conteggio della cartella');
  assert.ok(testo.includes('piccolo.md'), 'manca un file diretto');
  assert.ok(testo.includes('INDEX.md` · 12000 char · TLDR assente — GEN'), 'manca il flag di un file diretto');
  assert.ok(
    !testo.includes('spawn.md'),
    'un file di una SOTTOcartella non è diretto: l\'elenco è di questo livello',
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
