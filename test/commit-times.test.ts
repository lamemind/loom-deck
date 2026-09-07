// T136 — sorgente dei timestamp per la chiave di sort `commit`.
//
// Il parser gira su output FISSATO A MANO, non su un repo vero: l'unica cosa
// da collaudare è la lettura del formato. Un test che invocasse git davvero
// misurerebbe la storia di QUESTO repo, un valore che si muove a ogni commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTimes, parseCommitLog } from '../src/commit-times.js';

// Forma reale di `git log --format=#%ct --name-only`: riga di formato, riga
// vuota (anche qui, non solo a fine blocco), i path, un'altra riga vuota prima
// del blocco successivo. git log esce in ordine cronologico DISCENDENTE.
const LOG = [
  '#1700000000',
  '',
  'runtime/tasks/T50-uno.md',
  'runtime/tasks/T51-due.md',
  '',
  '#1690000000',
  '',
  'runtime/tasks/T50-uno.md',
  '',
  '#1680000000',
  '',
].join('\n');

test('parseCommitLog: un commit con più path popola più id nello stesso blocco', () => {
  const map = parseCommitLog(LOG);
  assert.equal(map.get('T50'), 1700000000);
  assert.equal(map.get('T51'), 1700000000);
});

test('parseCommitLog: primo hit vince — è già il più recente per l ordine discendente', () => {
  const map = parseCommitLog(LOG);
  // T50 compare anche nel blocco successivo (1690000000): deve restare il primo.
  assert.equal(map.get('T50'), 1700000000);
});

test('parseCommitLog: un blocco senza path (merge senza -m) si salta da sé', () => {
  const map = parseCommitLog(LOG);
  assert.equal(map.size, 2, 'solo T50 e T51: il terzo blocco non aggiunge nulla');
});

test('parseCommitLog: path fuori forma (non T<N>-*.md) è ignorato', () => {
  const log = ['#1700000000', '', 'README.md', 'runtime/tasks.md', ''].join('\n');
  assert.equal(parseCommitLog(log).size, 0);
});

test('parseCommitLog: output vuoto → mappa vuota', () => {
  assert.equal(parseCommitLog('').size, 0);
});

test('parseCommitLog: un path di sole cifre non è la riga di formato — serve il prefisso `#`', () => {
  const log = ['#1700000000', '', '1234', ''].join('\n');
  assert.equal(parseCommitLog(log).size, 0, '"1234" non è un task file valido, ma non rompe il parser');
});

test('commitTimes: repo assente → mappa vuota, mai un throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-commits-'));
  try {
    const map = await commitTimes(dir, dir);
    assert.deepEqual(map, new Map());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
