import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderField, folderSurvivors, purgeTargets, splitTargets } from '../src/purge.js';

// T112 — il deck replica il predicato del gate `--ignored-files` del plugin per
// scartare a monte i target non conformi. Se il predicato sbaglia, un bulk
// promette N task e ne pota N-k senza dirlo.

test('folderField prende il solo primo token del campo', () => {
  // Il campo ammette un'annotazione inline dopo il path; prenderla dentro
  // produrrebbe una directory inesistente, cioè una folder orfana su disco.
  assert.equal(
    folderField('- **Folder**: ./.26-06-16-cat (condivisa con T19)\n'),
    './.26-06-16-cat',
  );
  assert.equal(folderField('- **Folder**: .26-06-16-cat\n'), '.26-06-16-cat');
});

test('un campo Folder vuoto non ruba il token della riga successiva', () => {
  // `\s*` dopo i due punti mangerebbe l'a capo e catturerebbe `-` della riga
  // sotto: un path che non è mai stato scritto in quel campo.
  assert.equal(folderField('- **Folder**:\n- **Progress**: 🔵 Todo\n'), '');
  assert.equal(folderField('- **ID**: T112\n- **Progress**: 🔵 Todo\n'), '');
});

test('folderField è first-match-wins come il grep -m1 dello script', () => {
  assert.equal(folderField('- **Folder**: .primo\ntesto\n- **Folder**: .secondo\n'), '.primo');
});

// ── il predicato del gate, su un repo vero ─────────────────────────────────

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-purge-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('una folder tutta tracciata non ha superstiti', () => {
  const dir = repo();
  mkdirSync(join(dir, '.26-01-01-pulita'));
  writeFileSync(join(dir, '.26-01-01-pulita', 'nota.md'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  assert.deepEqual(folderSurvivors(dir, join(dir, '.26-01-01-pulita')), []);
});

test('un file untracked o ignorato è un superstite', () => {
  const dir = repo();
  mkdirSync(join(dir, '.26-01-01-sporca'));
  writeFileSync(join(dir, '.26-01-01-sporca', 'nota.md'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  // Untracked: `git rm` non lo tocca e resterebbe orfano su disco.
  writeFileSync(join(dir, '.26-01-01-sporca', 'scratch.txt'), 'y');
  // Ignorato: idem, ed è il caso che il .gitignore rende invisibile a un
  // `git status` nudo.
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  mkdirSync(join(dir, '.26-01-01-sporca', 'build'));
  writeFileSync(join(dir, '.26-01-01-sporca', 'build', 'out.bin'), 'z');
  const surv = folderSurvivors(dir, join(dir, '.26-01-01-sporca'));
  assert.ok(surv.includes('.26-01-01-sporca/scratch.txt'), `superstiti: ${surv.join(' ')}`);
  assert.ok(surv.length >= 2, `ignorati non contati: ${surv.join(' ')}`);
});

test('purgeTargets: senza folder dichiarata non c\'è nulla da guardare', () => {
  const dir = repo();
  const tasksDir = join(dir, 'runtime', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, 'T10-senza.md'), '# Task: senza\n\n- **Folder**:\n');
  const [t] = purgeTargets(['T10'], tasksDir, dir);
  assert.equal(t!.folder, null);
  assert.equal(t!.survivors, 0);
});

test('purgeTargets separa conformi e non conformi al gate', () => {
  const dir = repo();
  const tasksDir = join(dir, 'runtime', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(dir, '.26-01-01-a'));
  mkdirSync(join(dir, '.26-01-01-b'));
  writeFileSync(join(dir, '.26-01-01-a', 'nota.md'), 'x');
  writeFileSync(join(dir, '.26-01-01-b', 'nota.md'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  writeFileSync(join(dir, '.26-01-01-b', 'scratch.txt'), 'y');
  writeFileSync(join(tasksDir, 'T10-a.md'), '- **Folder**: ./.26-01-01-a\n');
  writeFileSync(join(tasksDir, 'T11-b.md'), '- **Folder**: ./.26-01-01-b\n');

  const { clean, dirty } = splitTargets(purgeTargets(['T10', 'T11'], tasksDir, dir));
  assert.deepEqual(clean.map((t) => t.id), ['T10']);
  assert.deepEqual(dirty.map((t) => t.id), ['T11']);
  assert.equal(dirty[0]!.survivors, 1);
});

test('una task senza task file resta un target conforme', () => {
  // Riga orfana in tasks.md: la skill la riconcilia con un commit dedicato, e
  // non ha nessuna folder da guardare. Escluderla qui la renderebbe impotabile
  // dal deck.
  const dir = repo();
  const tasksDir = join(dir, 'runtime', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const [t] = purgeTargets(['T99'], tasksDir, dir);
  assert.equal(t!.folder, null);
  assert.equal(t!.survivors, 0);
});
