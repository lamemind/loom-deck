import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropSessionFiles, sessionArtifacts } from '../src/session-drop.js';

// Il pezzo puro dell'eliminazione di una conversazione: cosa tocca e cosa no,
// su una project dir di CC ricostruita in temporanea.

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-drop-'));
  writeFileSync(join(dir, 'aaaa.jsonl'), '{"type":"user","cwd":"/p"}\n');
  mkdirSync(join(dir, 'aaaa'));
  writeFileSync(join(dir, 'aaaa', 'agent-1.jsonl'), '{}\n');
  writeFileSync(join(dir, 'bbbb.jsonl'), '{"type":"user","cwd":"/p"}\n');
  return dir;
}

test('artefatti: transcript + cartella omonima quando c\'è, solo il transcript altrimenti', () => {
  const dir = projectDir();
  assert.deepEqual(sessionArtifacts(join(dir, 'aaaa.jsonl')), [join(dir, 'aaaa.jsonl'), join(dir, 'aaaa')]);
  assert.deepEqual(sessionArtifacts(join(dir, 'bbbb.jsonl')), [join(dir, 'bbbb.jsonl')]);
});

test('artefatti: un path che non è un transcript viene rifiutato, mai rimosso', () => {
  const dir = projectDir();
  assert.throws(() => sessionArtifacts(dir), /non è un transcript/);
  assert.throws(() => dropSessionFiles(join(dir, 'aaaa')), /non è un transcript/);
  assert.ok(existsSync(join(dir, 'aaaa')), 'la cartella deve restare');
});

test('drop: rimuove transcript e cartella della sola conversazione, le altre restano', () => {
  const dir = projectDir();
  const touched = dropSessionFiles(join(dir, 'aaaa.jsonl'));
  assert.equal(touched.length, 2);
  assert.ok(!existsSync(join(dir, 'aaaa.jsonl')));
  assert.ok(!existsSync(join(dir, 'aaaa')));
  assert.ok(existsSync(join(dir, 'bbbb.jsonl')), 'l\'altra conversazione non si tocca');
});

test('drop: un transcript già assente non è un errore', () => {
  const dir = projectDir();
  assert.doesNotThrow(() => dropSessionFiles(join(dir, 'cccc.jsonl')));
});
