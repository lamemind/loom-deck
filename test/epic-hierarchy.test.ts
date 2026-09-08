// T67 — lettura filesystem della parentela epica: gemello di
// `commit-times.test.ts` ma sui task file invece che su `git log`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanEpicHierarchy } from '../src/epic-hierarchy.js';

function withTaskFiles(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'deck-epic-'));
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scanEpicHierarchy: legge Size ed epicOf da tutti i task file della cartella', () => {
  withTaskFiles(
    {
      'T1-cappello.md': '# Task: Cappello\n\n- **ID**: T1\n- **Size**: Epic\n',
      'T2-figlia.md': '# Task: Figlia\n\n- **ID**: T2\n- **Parent Task**: T1 (cappello)\n',
      'T3-normale.md': '# Task: Normale\n\n- **ID**: T3\n',
    },
    (dir) => {
      const { epicOf, epics } = scanEpicHierarchy(dir);
      assert.deepEqual([...epics], ['T1']);
      assert.equal(epicOf.get('T2'), 'T1');
      assert.equal(epicOf.has('T3'), false);
      assert.equal(epicOf.has('T1'), false);
    },
  );
});

test('scanEpicHierarchy: file fuori forma (non T<N>-*.md) è ignorato', () => {
  withTaskFiles(
    { 'README.md': '# Non è una task', 'tasks.md': '# Tasks' },
    (dir) => {
      const { epicOf, epics } = scanEpicHierarchy(dir);
      assert.equal(epicOf.size, 0);
      assert.equal(epics.size, 0);
    },
  );
});

test('scanEpicHierarchy: cartella assente → mappa vuota, mai un throw', () => {
  const missing = join(tmpdir(), 'deck-epic-missing-non-esiste');
  assert.doesNotThrow(() => scanEpicHierarchy(missing));
  const { epicOf, epics } = scanEpicHierarchy(missing);
  assert.equal(epicOf.size, 0);
  assert.equal(epics.size, 0);
});

// T153/DLV6 — no-op del gate: mtime massima invariata → stessa istanza, il
// read+parse non riparte. Poi un edit A MANO dentro un file già in tabella
// (nessun file aggiunto/tolto) deve restare visibile: è il caso che una firma
// sui soli id non coprirebbe, ed è la ragione per cui il gate è sulla mtime.
test('scanEpicHierarchy: mtime invariata → stessa istanza; edit a mano su file esistente resta visibile', () => {
  withTaskFiles(
    {
      'T1-cappello.md': '# Task: Cappello\n\n- **ID**: T1\n- **Size**: Epic\n',
      'T2-figlia.md': '# Task: Figlia\n\n- **ID**: T2\n',
    },
    (dir) => {
      const first = scanEpicHierarchy(dir);
      assert.equal(first.epicOf.has('T2'), false, 'T2 non ha ancora un Parent Task');

      const second = scanEpicHierarchy(dir);
      assert.strictEqual(second, first, 'mtime invariata: stessa istanza, nessun re-scan');

      // utimesSync con una data futura: la risoluzione della mtime su alcuni
      // filesystem è troppo grossolana per distinguere una write immediata
      // dalla precedente entro lo stesso test.
      const path2 = join(dir, 'T2-figlia.md');
      writeFileSync(path2, '# Task: Figlia\n\n- **ID**: T2\n- **Parent Task**: T1 (cappello)\n');
      const future = Date.now() / 1000 + 5;
      utimesSync(path2, future, future);

      const third = scanEpicHierarchy(dir);
      assert.notStrictEqual(third, first, 'mtime cambiata: nuova istanza, non la cache');
      assert.equal(third.epicOf.get('T2'), 'T1', 'edit a mano visibile: il gate è sulla mtime, non sugli id');
    },
  );
});
