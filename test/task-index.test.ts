import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSessionRecord,
  appendTaskBinding,
  loadSessionIndex,
  taskIndexPath,
} from '../src/task-index.js';

const root = () => mkdtempSync(join(tmpdir(), 'loom-deck-idx-'));

test('indice vuoto: file assente → mappe vuote, nessun throw', () => {
  const { bindings, forkOf } = loadSessionIndex(root());
  assert.equal(bindings.size, 0);
  assert.equal(forkOf.size, 0);
});

test('binding task: append e rilettura', () => {
  const r = root();
  appendTaskBinding(r, 'sid-1', 'T28');
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('sid-1'), 'T28');
  assert.equal(forkOf.size, 0);
});

test('fork di sessione scoped: il ramo porta binding e lineage', () => {
  const r = root();
  appendTaskBinding(r, 'origine', 'T28');
  appendSessionRecord(r, { sessionId: 'ramo', taskId: 'T28', forkOf: 'origine' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('ramo'), 'T28', 'il ramo eredita la task dell’origine');
  assert.equal(forkOf.get('ramo'), 'origine');
  assert.equal(forkOf.has('origine'), false, 'l’origine non è un fork');
});

test('fork di sessione spot: lineage senza task', () => {
  const r = root();
  appendSessionRecord(r, { sessionId: 'ramo', forkOf: 'origine' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.has('ramo'), false, 'nessun taskId → resta spot');
  assert.equal(forkOf.get('ramo'), 'origine');
});

test('campi indipendenti: un record di solo forkOf non cancella il binding', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T28');
  appendSessionRecord(r, { sessionId: 'sid', forkOf: 'altra' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('sid'), 'T28');
  assert.equal(forkOf.get('sid'), 'altra');
});

test('last-wins per campo su re-pin dello stesso sessionId', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T01');
  appendTaskBinding(r, 'sid', 'T02');
  assert.equal(loadSessionIndex(r).bindings.get('sid'), 'T02');
});

test('retrocompat: i record pre-T28 (solo taskId) restano validi', () => {
  const r = root();
  const p = taskIndexPath(r);
  mkdirSync(join(r, '.claude', 'loom'), { recursive: true });
  writeFileSync(p, '{"sessionId":"vecchia","taskId":"T19","ts":"2026-07-01T00:00:00Z"}\n');
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('vecchia'), 'T19');
  assert.equal(forkOf.size, 0);
});

test('righe corrotte o senza sessionId: skippate senza affondare la lettura', () => {
  const r = root();
  appendTaskBinding(r, 'buona', 'T28');
  writeFileSync(taskIndexPath(r), '{non json}\n{"taskId":"T99"}\n\n', { flag: 'a' });
  appendSessionRecord(r, { sessionId: 'ramo', forkOf: 'buona' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('buona'), 'T28');
  assert.equal(forkOf.get('ramo'), 'buona');
  assert.equal(bindings.size, 1);
});
