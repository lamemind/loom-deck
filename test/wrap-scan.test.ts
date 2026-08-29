// T134 — il lettore dello scan hard-wrap.
//
// Lo scanner vero è `scripts/docs/md-wrap.py` del plugin e resta lì per intero:
// le tre euristiche che riconoscono il wrap (la colonna è una banda con
// tolleranza, si stima sul 90° percentile, lo srotolamento itera a colonna
// ferma) sono tarate su un collaudo, e replicarle qui darebbe due misure
// destinate a divergere in silenzio. Quello che si prova qui è il LETTORE: che
// legga il TSV per nome di campo, che conti i soli `WRAP`, e che il prompt
// dell'azione resti quello cablato.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mixedCount,
  parseWrapTsv,
  wrapCacheFile,
  wrapCount,
  wrapPrompt,
  WRAP_DEFAULT_PATH,
} from '../src/wrap-scan.js';

const TSV = [
  'WRAP\truntime/reference/doc-system/doc-system-topology.md\tcol=93\tratio=0.82\tbreaks=41\tprose=50',
  'misto\truntime/inbox/note-una-riga-per-pensiero.md\tcol=70\tratio=0.31\tbreaks=2\tprose=7',
  'WRAP\tCLAUDE.md\tcol=80\tratio=0.70\tbreaks=9\tprose=13',
  '',
].join('\n');

const files = parseWrapTsv(TSV);

test('parseWrapTsv: una riga per file, i due verdetti riconosciuti', () => {
  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map((f) => f.verdict),
    ['WRAP', 'WRAP', 'misto'],
  );
});

test('i campi si leggono per NOME, non per posizione', () => {
  // Una colonna aggiunta in fondo dallo scanner deve restare un campo ignorato,
  // non trasformare i numeri di quelli prima in valori sbagliati.
  const [f] = parseWrapTsv(
    'WRAP\tx.md\tcol=42\tratio=0.9\tbreaks=7\tprose=9\tnuovo=qualcosa',
  );
  assert.equal(f!.column, 42);
  assert.equal(f!.breaks, 7);
  assert.equal(f!.prose, 9);
});

test('campo col assente o vuoto → null, mai uno zero che si legge come misura', () => {
  // Lo scanner oggi emette sempre un `col=` numerico, `misto` compreso: questo
  // difende dal campo che NON arriva. `Number('')` vale 0 e non NaN, quindi
  // senza guardia una colonna mancante comparirebbe in lista come `col=0` —
  // una misura che non esiste travestita da misura.
  assert.equal(parseWrapTsv('WRAP\tx.md\tcol=\tratio=0.3\tbreaks=2\tprose=7')[0]!.column, null);
  assert.equal(parseWrapTsv('WRAP\tx.md\tratio=0.3\tbreaks=2\tprose=7')[0]!.column, null);
});

test('righe fuori grammatica scartate: verdetto ignoto, path mancante', () => {
  assert.deepEqual(parseWrapTsv('libero\tx.md\tcol=1'), []);
  assert.deepEqual(parseWrapTsv('WRAP\t\tcol=1'), []);
  assert.deepEqual(parseWrapTsv(''), []);
});

test('ordine: i WRAP prima, poi per numero di giunzioni', () => {
  // Chi apre la lista srotola dall'alto, quindi in cima devono stare i file su
  // cui l'operazione ha più effetto.
  assert.equal(files[0]!.breaks, 41);
  assert.equal(files[1]!.breaks, 9);
  assert.equal(files[2]!.verdict, 'misto');
});

test('D4 — il contatore conta i soli WRAP, `misto` resta fuori', () => {
  assert.equal(wrapCount(files), 2);
  assert.equal(mixedCount(files), 1);
  // I due insiemi coprono la lista: `misto` è in lista, solo non nel numero.
  assert.equal(wrapCount(files) + mixedCount(files), files.length);
});

test('wrapPrompt: testo cablato, col path sostituito', () => {
  const p = wrapPrompt('runtime/reference');
  assert.match(p, /^lancia md-wrap modo apply su runtime\/reference e backup in cartella tmp/);
  assert.match(p, /verifica risultato e fai rapporto/);
  assert.match(p, /se le modifiche sono tutte chiaramente safe, puoi committare direttamente$/);
});

test('wrapPrompt: campo vuoto → project root intera, non un comando monco', () => {
  assert.equal(wrapPrompt(''), wrapPrompt(WRAP_DEFAULT_PATH));
  assert.equal(wrapPrompt('   '), wrapPrompt(WRAP_DEFAULT_PATH));
});

test('la cache è per-progetto e sotto una cartella per-utente', () => {
  const previous = process.env.LOOM_DECK_WRAP_FILE;
  delete process.env.LOOM_DECK_WRAP_FILE;
  try {
    const a = wrapCacheFile('/home/x/uno');
    const b = wrapCacheFile('/home/x/due');
    assert.notEqual(a, b, 'due progetti condividono lo stesso file di cache');
    assert.match(a, /loom-deck-wrap-\d+/);
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_WRAP_FILE;
    else process.env.LOOM_DECK_WRAP_FILE = previous;
  }
});

test('l\'env override vince, per i test e la verifica a mano', () => {
  const previous = process.env.LOOM_DECK_WRAP_FILE;
  process.env.LOOM_DECK_WRAP_FILE = '/tmp/scan-scelto.tsv';
  try {
    assert.equal(wrapCacheFile('/qualsiasi/progetto'), '/tmp/scan-scelto.tsv');
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_WRAP_FILE;
    else process.env.LOOM_DECK_WRAP_FILE = previous;
  }
});
