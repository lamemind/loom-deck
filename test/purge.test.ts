import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketSurvivors,
  chunkPathspecs,
  folderField,
  foldersSurvivors,
  foldersSurvivorsAsync,
  folderSurvivors,
  purgeTargets,
  purgeTargetsAsync,
  splitTargets,
  toGitPath,
} from '../src/purge.js';

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

// ── T186: N folder da una chiamata git sola ────────────────────────────────
//
// Su Windows uno spawn di git costa quanto tutto il resto della misura: il
// nucleo lancia un git per tutte le folder e divide l'output da sé. Il rischio
// della divisione è contare 0 superstiti su una folder sporca — il deck la
// proporrebbe come eliminabile e il gate del plugin rifiuterebbe il bulk intero.

test('bucketSurvivors: due folder col prefisso in comune non si rubano i file', () => {
  // Un confronto di prefisso senza la `/` finale darebbe a `.26-01-01-a` anche
  // il file di `.26-01-01-ab`.
  const out = '.26-01-01-a/x.txt\0.26-01-01-ab/y.txt\0';
  assert.deepEqual(bucketSurvivors(['.26-01-01-a', '.26-01-01-ab'], out), [
    ['.26-01-01-a/x.txt'],
    ['.26-01-01-ab/y.txt'],
  ]);
});

test('bucketSurvivors: un file di una folder annidata conta per entrambe', () => {
  // Stessa semantica di quando ogni folder si misurava con una chiamata sua:
  // `git ls-files -o -- .a` vede anche i file di `.a/interna`.
  const out = '.a/interna/deep/z.bin\0.a/top.txt\0';
  assert.deepEqual(bucketSurvivors(['.a', '.a/interna'], out), [
    ['.a/interna/deep/z.bin', '.a/top.txt'],
    ['.a/interna/deep/z.bin'],
  ]);
});

test('bucketSurvivors: output vuoto, nessun superstite per nessuna folder', () => {
  assert.deepEqual(bucketSurvivors(['.a', '.b'], ''), [[], []]);
  assert.deepEqual(bucketSurvivors([], '.a/x\0'), []);
});

test('bucketSurvivors: un repo annidato (`dir/`) appartiene alla folder', () => {
  // `git ls-files -o` stampa un repo git non tracciato come directory, con la
  // `/` finale, invece dei suoi file.
  assert.deepEqual(bucketSurvivors(['.a', '.a/sub'], '.a/sub/\0'), [['.a/sub/'], ['.a/sub/']]);
});

test('bucketSurvivors: un path visto da due blocchi conta una volta', () => {
  // Due blocchi di pathspec con `.a` e `.a/interna` stampano entrambi il file
  // della folder interna: gli output concatenati lo ripetono.
  const out = '.a/interna/z\0' + '\0' + '.a/interna/z\0';
  assert.deepEqual(bucketSurvivors(['.a', '.a/interna'], out), [['.a/interna/z'], ['.a/interna/z']]);
});

test('bucketSurvivors: una folder condivisa da due task ha gli stessi superstiti', () => {
  assert.deepEqual(bucketSurvivors(['.c', '.c'], '.c/x\0'), [['.c/x'], ['.c/x']]);
});

test('toGitPath: il `\\` di relative() su win32 diventa la `/` che git stampa', () => {
  assert.equal(toGitPath('.a\\interna\\deep', '\\'), '.a/interna/deep');
  // Su POSIX `\` è un carattere lecito di un nome di file: resta.
  assert.equal(toGitPath('.a\\b', '/'), '.a\\b');
  assert.equal(toGitPath('.a/b', '/'), '.a/b');
});

test('chunkPathspecs: blocchi sotto il budget, nessun pathspec perso', () => {
  const rels = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];
  // Ogni pathspec costa 5 caratteri (spazio compreso): 10 ne tiene due.
  assert.deepEqual(chunkPathspecs(rels, 10), [['aaaa', 'bbbb'], ['cccc', 'dddd'], ['eeee']]);
  assert.deepEqual(chunkPathspecs(rels, 1000), [rels]);
  assert.deepEqual(chunkPathspecs([], 10), []);
  // Un pathspec più lungo del budget fa blocco da solo, non sparisce.
  assert.deepEqual(chunkPathspecs(['x'.repeat(50), 'y'], 10), [['x'.repeat(50)], ['y']]);
});

/** Il riferimento: `git ls-files -o -- <folder>` lanciato da solo, il comando di
 *  `lw_folder_survivors` nel plugin. */
function soloSurvivors(dir: string, rel: string): number {
  return execFileSync('git', ['ls-files', '-o', '--', rel], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean).length;
}

/** Un repo con le forme che la divisione può sbagliare: prefisso in comune,
 *  folder annidata, nome non ASCII, file ignorati, una folder pulita. */
function mixedRepo(): { dir: string; tasksDir: string; folders: string[]; rels: string[] } {
  const dir = repo();
  const tasksDir = join(dir, 'runtime', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const rels = [
    '.26-01-01-a',
    '.26-01-01-ab',
    '.26-01-01-a/interna',
    '.26-01-01-perché',
    '.26-01-01-pulita',
  ];
  for (const rel of rels) mkdirSync(join(dir, rel), { recursive: true });
  for (const rel of rels) writeFileSync(join(dir, rel, 'tracciato.md'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  writeFileSync(join(dir, '.26-01-01-a', 'scratch.txt'), 'y');
  writeFileSync(join(dir, '.26-01-01-a', 'interna', 'scratch.txt'), 'y');
  writeFileSync(join(dir, '.26-01-01-ab', 'uno.txt'), 'y');
  writeFileSync(join(dir, '.26-01-01-ab', 'due.txt'), 'y');
  writeFileSync(join(dir, '.26-01-01-perché', 'più.txt'), 'y');
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  mkdirSync(join(dir, '.26-01-01-perché', 'build'));
  writeFileSync(join(dir, '.26-01-01-perché', 'build', 'out.bin'), 'z');
  rels.forEach((rel, i) => writeFileSync(join(tasksDir, `T1${i}-x.md`), `- **Folder**: ./${rel}\n`));
  return { dir, tasksDir, folders: rels.map((rel) => join(dir, rel)), rels };
}

test('foldersSurvivors: per ogni folder lo stesso conteggio di git lanciato da solo', () => {
  const { dir, folders, rels } = mixedRepo();
  const counts = foldersSurvivors(dir, folders).map((list) => list.length);
  assert.deepEqual(
    counts,
    rels.map((rel) => soloSurvivors(dir, rel)),
  );
  // Il riferimento stesso deve vedere qualcosa, o il confronto non misura niente:
  // `.a` 2 (il suo + quello dell'interna), `.ab` 2, interna 1, perché 2
  // (non ASCII + ignorato), pulita 0.
  assert.deepEqual(counts, [2, 2, 1, 2, 0]);
});

test('foldersSurvivorsAsync: stesso esito della sincrona', async () => {
  const { dir, folders } = mixedRepo();
  assert.deepEqual(await foldersSurvivorsAsync(dir, folders), foldersSurvivors(dir, folders));
});

test('purgeTargetsAsync: stesso esito di purgeTargets, task senza folder comprese', async () => {
  const { dir, tasksDir } = mixedRepo();
  writeFileSync(join(tasksDir, 'T20-senza.md'), '- **Folder**:\n');
  const ids = ['T10', 'T11', 'T20', 'T12', 'T99', 'T13', 'T14'];
  const sync = purgeTargets(ids, tasksDir, dir);
  assert.deepEqual(await purgeTargetsAsync(ids, tasksDir, dir), sync);
  assert.deepEqual(
    sync.map((t) => t.survivors),
    [2, 2, 0, 1, 0, 2, 0],
  );
});

test('git muto: nessun superstite per nessuna folder, sync e async', async (t) => {
  // Una cartella fuori da ogni repo: git esce in errore, e il deck la legge come
  // "conforme" — il gate del plugin resta la rete.
  const dir = mkdtempSync(join(tmpdir(), 'loom-purge-norepo-'));
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
    t.skip('la cartella temporanea sta dentro un repo git');
    return;
  } catch {
    // atteso: nessun repo
  }
  mkdirSync(join(dir, '.a'));
  writeFileSync(join(dir, '.a', 'x.txt'), 'x');
  assert.deepEqual(foldersSurvivors(dir, [join(dir, '.a')]), [[]]);
  assert.deepEqual(await foldersSurvivorsAsync(dir, [join(dir, '.a')]), [[]]);
});

test('una folder fuori dal progetto non arriva a git', () => {
  const dir = repo();
  const fuori = mkdtempSync(join(tmpdir(), 'loom-purge-fuori-'));
  writeFileSync(join(fuori, 'x.txt'), 'x');
  assert.deepEqual(foldersSurvivors(dir, [fuori]), [[]]);
});

test('purgeTargets lancia un git solo per tutte le folder', () => {
  // La proprietà che toglie il blocco su Windows. Il contatore avvolge
  // `execFileSync` di child_process; `syncBuiltinESMExports` lo propaga al
  // binding che `purge.ts` importa.
  const { dir, tasksDir } = mixedRepo();
  const cp = createRequire(import.meta.url)('node:child_process');
  const original = cp.execFileSync;
  let gitCalls = 0;
  cp.execFileSync = (file: string, ...rest: unknown[]) => {
    if (file === 'git') gitCalls++;
    return original(file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    purgeTargets(['T10', 'T11', 'T12', 'T13', 'T14'], tasksDir, dir);
  } finally {
    cp.execFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(gitCalls, 1);
});
