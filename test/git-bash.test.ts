// T175 — il bash di Git for Windows e l'env dei `claude` lanciati dal deck (P6
// preflight). T178 — il comando che esegue uno script `.sh` del plugin (P2
// preflight). Puri: filesystem e piattaforma sono parametri.
//
// Le tre posizioni di `git.exe` sono quelle misurate da T174 (verdetti 7 e 9)
// su un Git installato fuori da `C:\Program Files`: `Git\cmd\git.exe` nel `PATH`
// di Windows, `Git\mingw64\bin\git.exe` in testa al `PATH` di Git Bash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnv, GIT_BASH_ENV, resolveGitBash, scriptCommand } from '../src/git-bash.js';
import { gitlinkIndicator } from '../src/frame.js';
import { isAvailable, offNote, OFF_MARK } from '../src/platform.js';

const GIT = 'C:\\Dev\\Tools\\Git';
const BASH = `${GIT}\\bin\\bash.exe`;
const FILES = new Set([
  `${GIT}\\cmd\\git.exe`,
  `${GIT}\\mingw64\\bin\\git.exe`,
  `${GIT}\\bin\\git.exe`,
  BASH,
  `${GIT}\\usr\\bin\\bash.exe`,
]);
const exists = (p: string) => FILES.has(p);

test('la variabile impostata vince, senza guardare il PATH', () => {
  const withExplicit = (p: string) => p === 'E:\\bash.exe' || exists(p);
  assert.equal(resolveGitBash({ [GIT_BASH_ENV]: 'E:\\bash.exe', PATH: `${GIT}\\cmd` }, withExplicit), 'E:\\bash.exe');
});

test('T178 — la variabile verso un file che non esiste non vale: la cascata prosegue sul PATH', () => {
  assert.equal(resolveGitBash({ [GIT_BASH_ENV]: 'E:\\nessun\\bash.exe', PATH: `${GIT}\\cmd` }, exists), BASH);
});

test('T178 — variabile verso un file che non esiste e nessun git.exe nel PATH: nessun bash, e la testata dice n/d con la causa', () => {
  const none = resolveGitBash({ [GIT_BASH_ENV]: 'E:\\nessun\\bash.exe', PATH: 'C:\\Windows\\System32' }, exists);
  assert.equal(none, null);
  const tools = { gitBash: () => none };
  assert.equal(isAvailable('pluginScripts', 'win32', tools), false);
  assert.equal(
    gitlinkIndicator({ count: 0, attention: 0, scanned: false, ok: true, failed: false, available: isAvailable('pluginScripts', 'win32', tools) }),
    `gitlink ${OFF_MARK}`,
  );
  assert.equal(
    offNote('^U', 'pluginScripts', 'bump del gitlink', 'win32', tools),
    '⚠ ^U → bump del gitlink n/d su Windows: bash di Git non trovato',
  );
});

test('PATH di Windows: da Git\\cmd\\git.exe a Git\\bin\\bash.exe', () => {
  assert.equal(resolveGitBash({ PATH: `C:\\Windows;${GIT}\\cmd` }, exists), BASH);
});

test('PATH di Git Bash: da Git\\mingw64\\bin\\git.exe, dove accanto non c\'è bash, a Git\\bin\\bash.exe', () => {
  assert.equal(resolveGitBash({ PATH: `${GIT}\\mingw64\\bin;${GIT}\\usr\\bin` }, exists), BASH);
});

test('nessun git.exe nel PATH → nessun bash, mai il bash del PATH', () => {
  assert.equal(resolveGitBash({ PATH: `${GIT}\\usr\\bin;C:\\Windows\\System32` }, exists), null);
});

test('claudeEnv: su Linux nessun cambio', () => {
  assert.equal(claudeEnv('linux', { PATH: '/usr/bin' }, () => BASH), undefined);
});

test('claudeEnv: su win32 aggiunge il bash trovato, tenendo il resto dell\'env', () => {
  const env = claudeEnv('win32', { PATH: 'x', LOOM_TASK: 'T1' }, () => BASH);
  assert.equal(env?.[GIT_BASH_ENV], BASH);
  assert.equal(env?.LOOM_TASK, 'T1');
});

test("claudeEnv: su win32 non tocca una variabile già impostata, e senza bash lascia l'env del deck", () => {
  assert.equal(claudeEnv('win32', { [GIT_BASH_ENV]: 'E:\\bash.exe' }, () => BASH), undefined);
  assert.equal(claudeEnv('win32', { PATH: 'x' }, () => null), undefined);
});

const SCRIPT_WIN = 'C:\\Users\\u\\.claude\\plugins\\cache\\lamemind\\loom-works\\16.0.0\\scripts\\utils\\bump-gitlink.sh';

test('scriptCommand: su Linux lo script parte da sé, con lo shebang, come prima di T178', () => {
  // Il bash non si chiede nemmeno: su Linux nessuna risoluzione deve poter
  // cambiare l'interprete che lo shebang sceglie.
  const bash = () => {
    throw new Error('su Linux il bash di Git non si cerca');
  };
  assert.deepEqual(scriptCommand('/plugin/scripts/utils/bump-gitlink.sh', ['--dry-run'], 'linux', bash), {
    cmd: '/plugin/scripts/utils/bump-gitlink.sh',
    args: ['--dry-run'],
  });
});

test('scriptCommand: su win32 il bash di Git, con lo script per primo argomento e le barre /', () => {
  assert.deepEqual(scriptCommand(SCRIPT_WIN, ['--dry-run'], 'win32', () => BASH), {
    cmd: BASH,
    args: ['C:/Users/u/.claude/plugins/cache/lamemind/loom-works/16.0.0/scripts/utils/bump-gitlink.sh', '--dry-run'],
  });
});

test('scriptCommand: su win32 senza bash di Git lo script non si esegue', () => {
  assert.equal(scriptCommand(SCRIPT_WIN, [], 'win32', () => null), null);
});

test('scriptCommand: gli argomenti sono una copia, non il vettore del chiamante', () => {
  const args = ['--dry-run'];
  const out = scriptCommand('/s.sh', args, 'linux');
  out!.args.push('x');
  assert.deepEqual(args, ['--dry-run']);
});
