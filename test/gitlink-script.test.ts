// T178 — il vero `bump-gitlink.sh` eseguito dal deck (P7 preflight).
//
// Il test puro di `scriptCommand` prova la forma del comando, non che lo script
// giri: un separatore `\` nel path dello script, un `lib.sh` non trovato o un
// bash che non è quello di Git passerebbero il test puro e darebbero un
// sensore muto. Qui il vero `scanGitlink` lancia lo script — su Linux con lo
// shebang, su Windows col bash di Git — su un cappello finto con un submodule,
// e il test legge due stati, `allineato` e `avanti`, poi esegue il bump.
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
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBash } from '../src/git-bash.js';
import { bumpGitlink, GITLINK_SCRIPT, scanGitlink } from '../src/gitlink.js';
import { resetPluginCache } from '../src/plugin-cache.js';
import { commitFile, fakeCappello, git, GIT_IDENTITY } from './gitlink-kit.js';

const PLUGIN_SRC = fileURLToPath(new URL('../../loom-works-plugin/', import.meta.url));

/** Il motivo per cui il test non gira qui, o `false`. */
function skipReason(): string | false {
  if (!existsSync(join(PLUGIN_SRC, GITLINK_SCRIPT))) {
    return 'sorgente del plugin assente accanto al deck: il deck è clonato da solo';
  }
  if (process.platform === 'win32' && !gitBash()) return 'bash di Git non trovato su questa macchina';
  return false;
}

test('il deck esegue il vero bump-gitlink.sh: allineato, avanti dopo un commit pushato nel membro, poi il bump — col PROJECT_ROOT ereditato su un\'esca', { skip: skipReason() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-gitlink-'));
  // La cache finta: una versione sola, giunzione al sorgente del plugin
  // (`junction` vale su Windows senza privilegi, su Linux è un symlink).
  const cache = join(root, 'cache');
  mkdirSync(cache);
  symlinkSync(PLUGIN_SRC, join(cache, '99.0.0'), 'junction');

  const prevCache = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  // `PROJECT_ROOT` batte la cartella di lavoro in `lw_find_project_root`. Qui
  // punta a un'ESCA senza `.gitmodules`: se la variabile ereditata vincesse,
  // lo script misurerebbe l'esca e uscirebbe senza righe, e il bump
  // committerebbe là. Il deck la imposta sulla propria root (`gitlinkEnv`).
  const prevRoot = process.env.PROJECT_ROOT;
  const decoy = join(root, 'esca');
  mkdirSync(decoy);
  const prevIdentity = Object.fromEntries(Object.keys(GIT_IDENTITY).map((k) => [k, process.env[k]]));
  process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = cache;
  process.env.PROJECT_ROOT = decoy;
  Object.assign(process.env, GIT_IDENTITY);
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

    // Il bump vero: commit nel cappello finto, mai nell'esca.
    const bumped = await bumpGitlink(cappello);
    assert.equal(bumped.ok, true, 'il bump non è uscito bene');
    assert.deepEqual(
      bumped.members.map((m) => [m.path, m.state]),
      [['sub', 'bumpato']],
    );
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: cappello, windowsHide: true })
      .toString()
      .trim();
    assert.equal(subject, 'chore(sub): gitlink — secondo commit del membro');
  } finally {
    if (prevCache === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = prevCache;
    if (prevRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = prevRoot;
    for (const [k, v] of Object.entries(prevIdentity)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetPluginCache();
  }
});
