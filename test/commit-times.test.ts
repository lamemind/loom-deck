// T136 — sorgente dei timestamp per la chiave di sort `commit`.
//
// Il parser gira su output FISSATO A MANO, non su un repo vero: l'unica cosa
// da collaudare è la lettura del formato. Un test che invocasse git davvero
// misurerebbe la storia di QUESTO repo, un valore che si muove a ogni commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  commitLogSpawnCount,
  commitTimes,
  headShaFromFs,
  headSpawnCount,
  parseCommitLog,
} from '../src/commit-times.js';

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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Repo REALE con UN commit che tocca `tasks/`: il gate T153 gira su
 *  `rev-parse HEAD`, che su un repo finto (senza `.git`) fallirebbe sempre e
 *  non proverebbe niente sul CACHE-HIT. */
async function withRealRepo(run: (repoRoot: string, tasksDir: string) => Promise<void>) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'deck-commits-repo-'));
  try {
    git(repoRoot, 'init', '-q');
    git(repoRoot, 'config', 'user.email', 'test@test.local');
    git(repoRoot, 'config', 'user.name', 'test');
    const tasksDir = join(repoRoot, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T1-uno.md'), '# T1\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-q', '-m', 'first');
    await run(repoRoot, tasksDir);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// T153/DLV6 — no-op del gate: a HEAD fermo lo spawn COSTOSO (`git log`) parte
// una volta sola, non a ogni chiamata; dopo un nuovo commit che tocca
// `tasksDir` riparte. Delta sul contatore, non valore assoluto: il modulo è
// condiviso da tutto il file di test, altre chiamate altrove lo avanzano.
test('commitTimes: a HEAD fermo il gate evita un secondo spawn di `git log`', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    const before = commitLogSpawnCount();
    const first = await commitTimes(tasksDir, repoRoot);
    assert.equal(commitLogSpawnCount(), before + 1, 'prima chiamata: cache vuota, un log spawnato');
    assert.ok(first.get('T1'), 'la mappa riflette il commit reale, non solo il conteggio spawn');

    const second = await commitTimes(tasksDir, repoRoot);
    assert.equal(commitLogSpawnCount(), before + 1, 'HEAD invariato: nessun secondo spawn');
    assert.strictEqual(second, first, 'HEAD invariato: stessa istanza di mappa, non ricostruita');

    writeFileSync(join(tasksDir, 'T2-due.md'), '# T2\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-q', '-m', 'second');

    const third = await commitTimes(tasksDir, repoRoot);
    assert.equal(commitLogSpawnCount(), before + 2, 'HEAD mosso: il log riparte');
    assert.notStrictEqual(third, first, 'HEAD mosso: nuova istanza');
    assert.ok(third.get('T2'), 'il nuovo commit compare nella mappa ricostruita');
    assert.equal(third.get('T1'), first.get('T1'), 'la voce vecchia resta, la mappa non è un cap sulla storia');
  });
});

// T191 — il gate legge lo sha di HEAD dal filesystem. Ogni test confronta lo
// sha letto con quello di `git rev-parse HEAD` sullo stesso albero: il gate non
// deve mai vedere un HEAD diverso da quello di git. `headSpawnCount` dice se il
// gate ha dovuto ripiegare su un processo. Delta sui contatori, come sopra.

function revParse(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
}

function commitTask(repo: string, tasksDir: string, name: string): void {
  writeFileSync(join(tasksDir, name), `# ${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', name);
}

test('gate T191: HEAD invariato → nessun processo git, né per il gate né per il log', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot));
    const first = await commitTimes(tasksDir, repoRoot);
    const heads = headSpawnCount();
    const logs = commitLogSpawnCount();
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(await commitTimes(tasksDir, repoRoot), first, `giro ${i}: stessa istanza`);
    }
    assert.equal(headSpawnCount(), heads, 'nessun rev-parse: lo sha viene dal filesystem');
    assert.equal(commitLogSpawnCount(), logs, 'nessun log: HEAD fermo');
  });
});

test('gate T191: HEAD cambiato → la mappa si aggiorna alla chiamata dopo, senza rev-parse', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    const first = await commitTimes(tasksDir, repoRoot);
    const heads = headSpawnCount();
    commitTask(repoRoot, tasksDir, 'T2-due.md');
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot));
    const next = await commitTimes(tasksDir, repoRoot);
    assert.notStrictEqual(next, first);
    assert.ok(next.get('T2'));
    assert.equal(headSpawnCount(), heads);
  });
});

test('gate T191: worktree di lane — `.git` è un file, il ref sta nella cartella comune', async () => {
  await withRealRepo(async (repoRoot) => {
    const wt = `${repoRoot}-lane`;
    try {
      git(repoRoot, 'worktree', 'add', '-q', '-b', 'feat/lane', wt);
      const wtTasks = join(wt, 'tasks');
      assert.equal(await headShaFromFs(wt), revParse(wt));
      const heads = headSpawnCount();
      const first = await commitTimes(wtTasks, wt);
      commitTask(wt, wtTasks, 'T3-lane.md');
      assert.equal(await headShaFromFs(wt), revParse(wt), 'commit nel worktree: lo sha nuovo si legge');
      assert.notEqual(revParse(wt), revParse(repoRoot), 'il worktree ha il suo HEAD, non quello del principale');
      const next = await commitTimes(wtTasks, wt);
      assert.notStrictEqual(next, first);
      assert.ok(next.get('T3'));
      assert.equal(headSpawnCount(), heads, 'nessun ripiego nel worktree');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

test('gate T191: ref solo in `packed-refs` — si legge, e un HEAD che si muove lì si vede', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    git(repoRoot, 'pack-refs', '--all');
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot), 'ref impacchettato');
    const heads = headSpawnCount();
    const first = await commitTimes(tasksDir, repoRoot);
    commitTask(repoRoot, tasksDir, 'T4-packed.md');
    git(repoRoot, 'pack-refs', '--all'); // il ref sciolto sparisce, packed-refs porta lo sha nuovo
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot), 'sha nuovo solo in packed-refs');
    const next = await commitTimes(tasksDir, repoRoot);
    assert.notStrictEqual(next, first);
    assert.ok(next.get('T4'));
    assert.equal(headSpawnCount(), heads);
  });
});

test('gate T191: un ref sciolto batte la sua copia vecchia in `packed-refs`', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    git(repoRoot, 'pack-refs', '--all');
    commitTask(repoRoot, tasksDir, 'T5-loose.md'); // ref sciolto nuovo, packed-refs fermo sul vecchio
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot));
  });
});

test('gate T191: HEAD staccato (sha nudo in HEAD)', async () => {
  await withRealRepo(async (repoRoot) => {
    git(repoRoot, 'checkout', '-q', '--detach');
    assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot));
  });
});

test('gate T191: file `.git` con gitdir relativo, risolto dalla cartella del file', async () => {
  await withRealRepo(async (repoRoot) => {
    const store = `${repoRoot}-store`;
    try {
      mkdirSync(store);
      renameSync(join(repoRoot, '.git'), join(store, 'repo.git'));
      writeFileSync(join(repoRoot, '.git'), `gitdir: ../${basename(store)}/repo.git\n`);
      assert.equal(await headShaFromFs(repoRoot), revParse(repoRoot));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

test('gate T191: da una sottocartella del repo si risale al `.git` come fa git', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    assert.equal(await headShaFromFs(tasksDir), revParse(repoRoot));
  });
});

test('git muto T191: branch senza commit → il filesystem non risolve, ripiego su git, mappa vuota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-commits-unborn-'));
  try {
    git(dir, 'init', '-q');
    assert.equal(await headShaFromFs(dir), null);
    const heads = headSpawnCount();
    const map = await commitTimes(dir, dir);
    assert.equal(map.size, 0);
    assert.equal(headSpawnCount(), heads + 1, 'il ripiego chiede a git, che decide come prima di T191');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git muto T191: path che non esiste → null dal filesystem, mappa vuota, nessun throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-commits-norepo-'));
  try {
    const missing = join(dir, 'non-esiste');
    assert.equal(await headShaFromFs(missing), null);
    assert.deepEqual(await commitTimes(missing, missing), new Map());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git muto T191: git non installato → sha dal filesystem, log in errore, mappa vuota, nessun throw', async () => {
  await withRealRepo(async (repoRoot, tasksDir) => {
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      // tasksDir diverso da quello già in cache: il log deve davvero partire e fallire.
      const map = await commitTimes(join(tasksDir, 'altro'), repoRoot);
      assert.equal(map.size, 0);
    } finally {
      process.env.PATH = path;
    }
  });
});

test('gate T191: GIT_DIR nell env → il filesystem si fa da parte, decide git', async () => {
  await withRealRepo(async (repoRoot) => {
    process.env.GIT_DIR = join(repoRoot, '.git');
    try {
      assert.equal(await headShaFromFs(repoRoot), null);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
