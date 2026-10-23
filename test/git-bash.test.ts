// T175 — il bash di Git for Windows e l'env dei `claude` lanciati dal deck (P6
// preflight). Puri: filesystem e piattaforma sono parametri.
//
// Le tre posizioni di `git.exe` sono quelle misurate da T174 (verdetti 7 e 9)
// su un Git installato fuori da `C:\Program Files`: `Git\cmd\git.exe` nel `PATH`
// di Windows, `Git\mingw64\bin\git.exe` in testa al `PATH` di Git Bash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEnv, GIT_BASH_ENV, resolveGitBash } from '../src/git-bash.js';

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
  assert.equal(resolveGitBash({ [GIT_BASH_ENV]: 'E:\\bash.exe', PATH: `${GIT}\\cmd` }, exists), 'E:\\bash.exe');
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
