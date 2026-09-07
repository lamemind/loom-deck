// T67 — lettura filesystem della parentela epica: gemello di
// `commit-times.test.ts` ma sui task file invece che su `git log`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
