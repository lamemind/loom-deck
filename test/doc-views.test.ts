// T160 — il catalogo delle viste del pane doc, provato senza pseudo-terminale.
//
// Una vista sola, `Tutti`: `doc-metrics.sh` emette tre flag descrittivi e
// nessuno chiede un'operazione, quindi non esistono viste per flag. Restano in
// misura le invarianti dei tre cataloghi già in esercizio (task, sessioni,
// inbox), più una che nasce qui: su un pane ad ALBERO il contatore di `Tutti`
// conta anche le righe cartella.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocTsv } from '../src/doc-tree.js';
import {
  DOC_VIEWS,
  cycleDocView,
  docCounts,
  docView,
  selectDocRows,
  type DocViewId,
} from '../src/doc-views.js';

const DATA = parseDocTsv(
  [
    'PATH\tCHAR\tTLDR\tFLAGS',
    'runtime/reference/grande.md\t19229\t420\t-',
    'runtime/reference/INDEX.md\t900\t0\tGEN',
    'runtime/project/regole.md\t5000\t0\tONLINE',
    'runtime/reference/sano.md\t5000\t120\t-',
    '',
    'DIR\tFILES\tCHAR\tFLAGS',
    'runtime/reference\t3\t25129\t-',
    'runtime/project\t1\t5000\t-',
    'runtime\t0\t0\t-',
  ].join('\n'),
);

const COUNTS = docCounts(DATA);

test('il catalogo ha una voce sola, l\'albero', () => {
  assert.deepEqual(
    DOC_VIEWS.map((v) => v.id),
    ['all'],
  );
});

test('il contatore della voce coincide col numero di righe che mostra', () => {
  // L'invariante condivisa coi tre cataloghi storici, e la sola che un utente
  // non può verificare da sé: un header che dice un numero e una lista che ne
  // mostra un altro non ha nessuna schermata che lo segnali.
  for (const v of DOC_VIEWS) {
    assert.equal(
      v.count(COUNTS),
      selectDocRows(v.id, DATA).length,
      `la voce ${v.id} promette ${v.count(COUNTS)} righe`,
    );
  }
});

test('`Tutti` conta anche le righe CARTELLA, perché le mostra', () => {
  // Quattro file più tre cartelle: su un pane ad albero le righe strutturali
  // sono righe a tutti gli effetti, e lasciarle fuori dal conto lo farebbe
  // divergere dalla lista.
  assert.equal(COUNTS.total, 7);
});

test('`Tutti` si grigia solo su un albero vuoto', () => {
  // Nessun flag chiede un'operazione, quindi l'unico fatto che la voce può dire
  // è se c'è qualcosa da guardare.
  assert.equal(docView('all').dim(COUNTS), false);
  assert.equal(docView('all').dim({ total: 0 }), true);
});

test('la vista vuota DICE perché è vuota', () => {
  for (const v of DOC_VIEWS) assert.ok(v.empty.length > 0, `la voce ${v.id} non ha una nota`);
});

test('la navigazione ciclica resta sulla voce sola', () => {
  assert.equal(cycleDocView('all', 1), 'all');
  assert.equal(cycleDocView('all', -1), 'all');
  // Id ignoto → prima voce, mai un indice negativo: è il caso di una vista per
  // flag salvata da un deck più vecchio.
  assert.equal(cycleDocView('split' as DocViewId, 1), 'all');
  assert.equal(docView('regroup' as DocViewId).id, 'all');
});
