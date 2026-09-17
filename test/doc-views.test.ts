// T160 — il catalogo delle viste del pane doc, provato senza pseudo-terminale.
//
// Le invarianti sotto misura sono le stesse dei tre cataloghi già in esercizio
// (task, sessioni, inbox), più una che nasce qui: su un pane ad ALBERO il
// contatore di `Tutti` conta anche le righe cartella, e le viste per flag sono
// piatte proprio per non rompere quel conto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocTsv } from '../src/doc-tree.js';
import {
  DOC_VIEWS,
  cycleDocView,
  docCounts,
  docView,
  flaggedTotal,
  selectDocRows,
  type DocViewId,
} from '../src/doc-views.js';

const DATA = parseDocTsv(
  [
    'PATH\tCHAR\tTLDR\tFLAGS',
    'runtime/reference/grande.md\t19229\t420\tSPLIT',
    'runtime/reference/piccolo.md\t900\t80\tMERGE?',
    'runtime/reference/senza-tldr.md\t5000\t0\tNOTLDR',
    'runtime/reference/orfana.md\t5000\t300\tTLDR-ORFANA',
    'runtime/reference/lungo.md\t5000\t900\tTLDR>CAP',
    'runtime/reference/sano.md\t5000\t120\t-',
    '',
    'DIR\tFILES\tCHAR\tFLAGS',
    'runtime/reference\t6\t40129\tREGROUP',
    'runtime\t0\t0\t-',
  ].join('\n'),
);

const COUNTS = docCounts(DATA);

test('il catalogo è FISSO: cinque voci, sempre le stesse', () => {
  // Un catalogo che si accorcia a contatore 0 sposta le voci sotto le dita di
  // chi le ha imparate — la ragione per cui gli altri tre sono fissi.
  assert.deepEqual(
    DOC_VIEWS.map((v) => v.id),
    ['all', 'split', 'merge', 'tldr', 'regroup'],
  );
});

test('il contatore di una voce coincide col numero di righe che mostra', () => {
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
  // Sei file più due cartelle: su un pane ad albero le righe strutturali sono
  // righe a tutti gli effetti, e lasciarle fuori dal conto lo farebbe divergere
  // dalla lista.
  assert.equal(COUNTS.total, 8);
});

test('la vista TLDR somma i tre difetti della riga 3', () => {
  // Tre difetti diversi — troppo lunga, assente, con un'ancora che nel corpo non
  // c'è — ma un rimedio solo (`write-tldr` sul file): tre voci si guarderebbero
  // e si eseguirebbero comunque insieme.
  assert.equal(COUNTS.tldr, 3);
  // Il nome di una riga piatta è il path meno la sola RADICE: in una lista senza
  // gerarchia due `spawn.md` di cartelle diverse sarebbero altrimenti la stessa
  // riga a occhio.
  const nomi = selectDocRows('tldr', DATA).map((r) => r.name);
  assert.deepEqual(
    [...nomi].sort(),
    ['reference/lungo.md', 'reference/orfana.md', 'reference/senza-tldr.md'],
  );
});

test('la vista REGROUP elenca cartelle, le altre file', () => {
  assert.ok(selectDocRows('regroup', DATA).every((r) => r.kind === 'dir'));
  for (const id of ['split', 'merge', 'tldr'] as DocViewId[]) {
    assert.ok(
      selectDocRows(id, DATA).every((r) => r.kind === 'file'),
      `la vista ${id} ha portato una cartella`,
    );
  }
});

test('`Tutti` si grigia su quanto c\'è DA FARE, non sulle proprie righe', () => {
  // L'albero ha righe finché la doc ha file, quindi il proprio contatore non
  // direbbe mai niente. Quello che il pane deve dire è se vale la pena lanciare
  // qualcosa: stessa scelta del catalogo inbox, dove `Tutti` si grigia sulla
  // somma delle tre nature.
  assert.equal(docView('all').dim(COUNTS), false, 'con sei flag la voce non si grigia');
  const equilibrio = { total: 12, split: 0, merge: 0, tldr: 0, regroup: 0 };
  assert.equal(flaggedTotal(equilibrio), 0);
  assert.equal(
    docView('all').dim(equilibrio),
    true,
    'una doc in equilibrio si guarda lo stesso, ma non chiede niente',
  );
});

test('ogni vista vuota DICE perché è vuota', () => {
  for (const v of DOC_VIEWS) assert.ok(v.empty.length > 0, `la voce ${v.id} non ha una nota`);
});

test('la navigazione è ciclica in entrambi i versi', () => {
  assert.equal(cycleDocView('regroup', 1), 'all');
  assert.equal(cycleDocView('all', -1), 'regroup');
  // Id ignoto → prima voce, mai un indice negativo.
  assert.equal(cycleDocView('boh' as DocViewId, 1), 'all');
});
