// T175 — la docs-root del deck: `LOOM_DECK_DOCS_ROOT` → `docsRoot` del file di
// progetto → `docs`.
//
// Il caso che la cascata esiste per coprire è il deck avviato a mano, senza env:
// prima di T175 cercava `docs/` anche su un progetto che dichiara `runtime`, e
// mostrava una lista vuota invece di un errore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DOCS_ROOT, docsRootName, parseDocsRoot } from '../src/config.js';
import { resolveTasksDir, resolveTasksPath } from '../src/tasks.js';

/** Un progetto temporaneo col file di config dato (`null` = nessun file). */
function project(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-docs-root-'));
  if (config !== null) {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'loom-works.json'), config);
  }
  return root;
}

/** Esegue `fn` con `LOOM_DECK_DOCS_ROOT` impostata (o tolta, con `undefined`). */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.LOOM_DECK_DOCS_ROOT;
  if (value === undefined) delete process.env.LOOM_DECK_DOCS_ROOT;
  else process.env.LOOM_DECK_DOCS_ROOT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOOM_DECK_DOCS_ROOT;
    else process.env.LOOM_DECK_DOCS_ROOT = prev;
  }
}

test('senza env il deck legge docsRoot dal file di progetto', () => {
  const root = project(JSON.stringify({ id: 'p', docsRoot: 'runtime' }));
  try {
    assert.equal(withEnv(undefined, () => docsRootName(root)), 'runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("l'env batte il campo del file", () => {
  const root = project(JSON.stringify({ id: 'p', docsRoot: 'runtime' }));
  try {
    assert.equal(withEnv('altrove', () => docsRootName(root)), 'altrove');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file assente, malformato o senza campo → docs', () => {
  for (const config of [null, '{ non è json', JSON.stringify({ id: 'p' }), JSON.stringify({ docsRoot: '  ' })]) {
    const root = project(config);
    try {
      assert.equal(withEnv(undefined, () => docsRootName(root)), DEFAULT_DOCS_ROOT, String(config));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('parseDocsRoot: solo una stringa non vuota, presa così com\'è', () => {
  assert.equal(parseDocsRoot({ docsRoot: 'runtime' }), 'runtime');
  assert.equal(parseDocsRoot({ docsRoot: '' }), null);
  assert.equal(parseDocsRoot({ docsRoot: 3 }), null);
  assert.equal(parseDocsRoot(null), null);
});

test('tasks.md e la cartella dei task file nascono dalla stessa docs-root', () => {
  assert.equal(resolveTasksPath('/p', 'runtime'), join('/p', 'runtime', 'tasks.md'));
  assert.equal(resolveTasksDir('/p', 'runtime'), join('/p', 'runtime', 'tasks'));
});
