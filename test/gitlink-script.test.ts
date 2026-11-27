// T178 — il vero `bump-gitlink.sh` eseguito dal deck (P7 preflight).
//
// Il test puro di `scriptCommand` prova la forma del comando, non che lo script
// giri: un separatore `\` nel path dello script, un `lib.sh` non trovato o un
// bash che non è quello di Git passerebbero il test puro e darebbero un
// sensore muto. Qui il vero `scanGitlink` lancia lo script — su Linux con lo
// shebang, su Windows col bash di Git — su un cappello finto con un submodule,
// e il test legge due stati: `allineato` e `avanti`.
//
// Il plugin arriva dal sorgente del submodule fratello attraverso una cache
// finta in `LOOM_DECK_PLUGIN_CACHE_ROOT`. Un deck clonato da solo non ha quel
// sorgente, e il test salta col motivo.
//
// Su Windows un giro di `--dry-run` dura secondi e non centesimi: ogni
// sottoprocesso di Git Bash costa intorno ai 150 ms (T188).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBash } from '../src/git-bash.js';
import { GITLINK_SCRIPT, scanGitlink } from '../src/gitlink.js';
import { resetPluginCache } from '../src/plugin-cache.js';

const PLUGIN_SRC = fileURLToPath(new URL('../../loom-works-plugin/', import.meta.url));

/** Il motivo per cui il test non gira qui, o `false`. */
function skipReason(): string | false {
  if (!existsSync(join(PLUGIN_SRC, GITLINK_SCRIPT))) {
    return 'sorgente del plugin assente accanto al deck: il deck è clonato da solo';
  }
  if (process.platform === 'win32' && !gitBash()) return 'bash di Git non trovato su questa macchina';
  return false;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function commitFile(repo: string, name: string, message: string): void {
  writeFileSync(join(repo, name), `${message}\n`);
  git(repo, 'add', '--', name);
  git(repo, 'commit', '-q', '-m', message);
}

/**
 * Un cappello finto: un submodule `sub` clonato da un repo bare locale, che fa
 * da suo `origin`, e il file di progetto che ferma subito la ricerca della root
 * in `lw_find_project_root`.
 */
function fakeCappello(root: string): string {
  const work = join(root, 'sub-work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  commitFile(work, 'a.txt', 'primo commit del membro');
  const bare = join(root, 'sub.git');
  git(root, 'clone', '-q', '--bare', work, bare);

  const cappello = join(root, 'cappello');
  mkdirSync(join(cappello, '.claude'), { recursive: true });
  git(cappello, 'init', '-q', '-b', 'main');
  writeFileSync(join(cappello, '.claude', 'loom-works.json'), '{"id":"cappello-finto"}\n');
  git(cappello, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bare, 'sub');
  git(cappello, 'add', '--', '.claude/loom-works.json');
  git(cappello, 'commit', '-q', '-m', 'cappello con un submodule');
  return cappello;
}

test('il deck esegue il vero bump-gitlink.sh: allineato, poi avanti dopo un commit pushato nel membro', { skip: skipReason() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-gitlink-'));
  // La cache finta: una versione sola, giunzione al sorgente del plugin
  // (`junction` vale su Windows senza privilegi, su Linux è un symlink).
  const cache = join(root, 'cache');
  mkdirSync(cache);
  symlinkSync(PLUGIN_SRC, join(cache, '99.0.0'), 'junction');

  const prevCache = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  // `PROJECT_ROOT` batte la cartella di lavoro in `lw_find_project_root`: una
  // conversazione che la porta farebbe misurare allo script il suo progetto, non
  // il cappello finto.
  const prevRoot = process.env.PROJECT_ROOT;
  process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = cache;
  delete process.env.PROJECT_ROOT;
  resetPluginCache();
  try {
    const cappello = fakeCappello(root);

    const aligned = await scanGitlink(cappello);
    assert.equal(aligned.ok, true, 'lo script non è uscito bene');
    assert.deepEqual(
      aligned.members.map((m) => [m.path, m.state]),
      [['sub', 'allineato']],
    );

    // Un commit nel membro, pushato sul suo origin: passa la guardia sul verso
    // e quella sul remote, quindi il dry-run lo dice bumpabile.
    const sub = join(cappello, 'sub');
    commitFile(sub, 'b.txt', 'secondo commit del membro');
    git(sub, 'push', '-q', 'origin', 'HEAD:main');

    const ahead = await scanGitlink(cappello);
    assert.equal(ahead.ok, true, 'lo script non è uscito bene');
    assert.equal(ahead.members.length, 1);
    assert.equal(ahead.members[0]!.state, 'avanti');
    assert.match(ahead.members[0]!.detail, /→.* secondo commit del membro$/);
  } finally {
    if (prevCache === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = prevCache;
    if (prevRoot !== undefined) process.env.PROJECT_ROOT = prevRoot;
    resetPluginCache();
  }
});
