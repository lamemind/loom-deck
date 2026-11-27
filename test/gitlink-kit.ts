// T178 — il cappello finto dei test del gitlink: un repo con un submodule
// clonato da un repo bare locale, che fa da suo `origin`.
//
// Non è un file di test (`*.test.ts`): il runner non lo esegue, lo importano
// `gitlink-script.test.ts` e `gitlink-gate.test.ts`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Identità e firma dei commit: valgono per i `git` del kit e, messe in
 *  `process.env` per la durata di un test, per il commit che il bump fa dentro
 *  lo script. Senza, il commit dipenderebbe dalla config git della macchina. */
export const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: 'ignore',
    windowsHide: true,
  });
}

export function commitFile(repo: string, name: string, message: string): void {
  writeFileSync(join(repo, name), `${message}\n`);
  git(repo, 'add', '--', name);
  git(repo, 'commit', '-q', '-m', message);
}

/**
 * Un cappello finto in `root/cappello`: un submodule `sub` clonato da
 * `root/sub.git`, e il file di progetto che ferma subito la ricerca della root
 * in `lw_find_project_root`.
 */
export function fakeCappello(root: string): string {
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
