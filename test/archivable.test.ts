// T61 — il criterio d'età del contatore archiviabili.
//
// Il punto delicato non è il conteggio ma il CONFINE: la regola vive in due
// implementazioni (qui e in `cleanup-done-tasks.sh`, vedi D1 del preflight) e
// due implementazioni che non concordano su "30 giorni netti" darebbero numeri
// diversi sulla stessa task list. Da qui i test sul giorno esatto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ageDays, countArchivable, DEFAULT_ARCHIVABLE_DAYS } from '../src/archivable.js';
import { parseArchivableDays } from '../src/config.js';

/** Riferimento fisso: senza, i test cambierebbero esito col passare dei giorni. */
const NOW = new Date(2026, 7, 3, 12, 0, 0).getTime(); // 2026-08-03 12:00 locale

function taskFile(progress: string, extra = ''): string {
  return `# Task: sintetica\n\n- **ID**: T99\n- **Progress**: ${progress}\n${extra}\n## Description\n\ncorpo\n`;
}

// `await fn(dir)` e non `return fn(dir)`: senza l'await il `finally` cancella la
// dir nell'istante in cui il callback cede il controllo al primo await, cioè
// prima che lo scan abbia letto i file — e i test passerebbero o fallirebbero
// per la ragione sbagliata.
async function withTasksDir(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'deck-arch-'));
  const dir = join(root, 'tasks');
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  try {
    await fn(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('ageDays: data nuda ancorata alla mezzanotte LOCALE', () => {
  // Mezzanotte UTC darebbe 32 su un fuso a est di Greenwich: è lo scarto che
  // sposta di 1 il conteggio proprio sul confine.
  assert.equal(ageDays('2026-07-01', NOW), 33);
  assert.equal(ageDays('2026-08-03', NOW), 0);
});

test('ageDays: timestamp git completo passa dall offset', () => {
  assert.equal(ageDays('2026-07-20T10:00:00+02:00', NOW), 14);
});

test('ageDays: data non parsabile → null', () => {
  assert.equal(ageDays('non-una-data', NOW), null);
});

test('confine: N giorni netti sono DENTRO (>=), come lo script', async () => {
  await withTasksDir({ 'T01-x.md': taskFile('✔️ Done at 2026-07-04') }, async (dir) => {
    const opts = { tasksDir: dir, projectRoot: dir, now: NOW };
    assert.equal(ageDays('2026-07-04', NOW), 30);
    assert.equal(await countArchivable(['T01'], { ...opts, days: 30 }), 1, '30gg netti: dentro');
    assert.equal(await countArchivable(['T01'], { ...opts, days: 31 }), 0, '31gg: fuori');
  });
});

test('Done recente non è archiviabile, Done vecchia sì', async () => {
  await withTasksDir(
    {
      'T01-recente.md': taskFile('✔️ Done at 2026-08-01'),
      'T02-vecchia.md': taskFile('✔️ Done at 2026-05-01'),
    },
    async (dir) => {
      const n = await countArchivable(['T01', 'T02'], {
        tasksDir: dir,
        projectRoot: dir,
        days: 30,
        now: NOW,
      });
      assert.equal(n, 1);
    },
  );
});

test('Done senza data determinabile è ESCLUSA, mai contata come vecchia', async () => {
  // Nessun `Done at`, nessun `Last tracked commit`, e la dir non è un repo git
  // → tutti e tre i gradini muti. La task esce dal conteggio invece di entrarci.
  await withTasksDir({ 'T01-nuda.md': taskFile('✔️ Done') }, async (dir) => {
    const n = await countArchivable(['T01'], {
      tasksDir: dir,
      projectRoot: dir,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 0);
  });
});

test('la forma `Done YYYY-MM-DD` senza "at" NON è agganciata dal gradino ①', async () => {
  // Divergenza voluta: il pattern è quello dello script. Una task così cade sui
  // fallback git — se anche quelli sono muti, resta esclusa.
  await withTasksDir({ 'T01-senza-at.md': taskFile('✔️ Done 2026-05-01') }, async (dir) => {
    const n = await countArchivable(['T01'], {
      tasksDir: dir,
      projectRoot: dir,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 0);
  });
});

test('riga Done senza task file (orfana) non entra nel conteggio', async () => {
  await withTasksDir({}, async (dir) => {
    const n = await countArchivable(['T99'], {
      tasksDir: dir,
      projectRoot: dir,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 0);
  });
});

test('Progress ripetuto nel body: vince quello dell header (first-match-wins)', async () => {
  const content =
    taskFile('✔️ Done at 2026-08-01') + '\n- **Progress**: ✔️ Done at 2020-01-01\n';
  await withTasksDir({ 'T01-doppio.md': content }, async (dir) => {
    const n = await countArchivable(['T01'], {
      tasksDir: dir,
      projectRoot: dir,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 0, 'la riga del body (2020) non deve vincere sulla header (2026-08-01)');
  });
});

// ---- Cascata git: gradini ② e ③ ---------------------------------------------

function gitRepo(): string | null {
  try {
    const root = mkdtempSync(join(tmpdir(), 'deck-arch-git-'));
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'test']);
    mkdirSync(join(root, 'tasks'));
    return root;
  } catch {
    return null;
  }
}

test('gradino ③: senza `Done at`, la data viene dall ultimo commit sul task file', async () => {
  const root = gitRepo();
  if (!root) return; // git assente: lo scan degrada, non è questo il test
  try {
    const dir = join(root, 'tasks');
    writeFileSync(join(dir, 'T01-nuda.md'), taskFile('✔️ Done'));
    const old = '2026-05-01T10:00:00+02:00';
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'x'], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    const n = await countArchivable(['T01'], {
      tasksDir: dir,
      projectRoot: root,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 1, 'il commit di maggio deve rendere la task archiviabile a 30gg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gradino ②: `Last tracked commit` batte il commit del file', async () => {
  const root = gitRepo();
  if (!root) return;
  try {
    const dir = join(root, 'tasks');
    // Commit vecchio, poi il file viene riscritto e ricommittato OGGI: il
    // gradino ③ direbbe "recente", il ② tiene la data vera della chiusura.
    writeFileSync(join(dir, 'T01-sha.md'), 'seed');
    const old = '2026-05-01T10:00:00+02:00';
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'chiusura'], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(
      join(dir, 'T01-sha.md'),
      taskFile('✔️ Done', `- **Last tracked commit**: ${sha}\n`),
    );
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'ritocco'], { cwd: root, stdio: 'ignore' });

    const n = await countArchivable(['T01'], {
      tasksDir: dir,
      projectRoot: root,
      days: 30,
      now: NOW,
    });
    assert.equal(n, 1, 'deve vincere la data dello sha, non quella del ritocco di oggi');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Soglia dal file config --------------------------------------------------

test('parseArchivableDays accetta solo interi positivi', () => {
  assert.equal(parseArchivableDays({ archivableDays: 45 }), 45);
  assert.equal(parseArchivableDays({ archivableDays: 0 }), null, '0 spegnerebbe la soglia');
  assert.equal(parseArchivableDays({ archivableDays: -5 }), null);
  assert.equal(parseArchivableDays({ archivableDays: 30.5 }), null);
  assert.equal(parseArchivableDays({ archivableDays: '30' }), null, 'stringa: non è il tipo');
  assert.equal(parseArchivableDays({}), null, 'campo assente → default del chiamante');
  assert.equal(parseArchivableDays(null), null);
});

test('il default è metà della policy di purge (60) dello script', () => {
  assert.equal(DEFAULT_ARCHIVABLE_DAYS, 30);
});
