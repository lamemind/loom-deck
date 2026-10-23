// T175 — i confronti di path sulla root del progetto, per piattaforma. Puri:
// la piattaforma è un parametro, quindi i casi di Windows girano anche su Linux.
//
// Le grafie dei casi win32 sono quelle misurate da T174 (verdetto 1): la cwd
// di VS Code con la lettera del drive minuscola, quella di Windows Terminal
// maiuscola, e la forma MSYS di Git Bash nei record `cwd` dei transcript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparablePath, isWithin, matchingDirNames, projectBaseName } from '../src/project-path.js';

const ROOT = 'C:\\Users\\enrico_ballardini\\loom-works\\loom-works';

test('win32: la lettera del drive e le maiuscole non contano', () => {
  assert.equal(isWithin('c:\\users\\Enrico_Ballardini\\loom-works\\loom-works', ROOT, 'win32'), true);
});

test('win32: `/` e `\\` sono lo stesso separatore', () => {
  assert.equal(isWithin('C:/Users/enrico_ballardini/loom-works/loom-works', ROOT, 'win32'), true);
});

test('win32: la forma MSYS `/c/…` è la stessa cartella', () => {
  assert.equal(isWithin('/c/Users/enrico_ballardini/loom-works/loom-works', ROOT, 'win32'), true);
  assert.equal(comparablePath('/c/Users/x', 'win32'), 'c:\\users\\x');
});

test('win32: una sottocartella sta dentro, un nome che inizia uguale no', () => {
  assert.equal(isWithin(`${ROOT}\\loom-deck`, ROOT, 'win32'), true);
  assert.equal(isWithin(`${ROOT}-altro`, ROOT, 'win32'), false);
  assert.equal(isWithin('C:\\Users\\enrico_ballardini\\loom-works', ROOT, 'win32'), false);
});

test('win32: il separatore in coda non conta, la radice del drive resta una radice', () => {
  assert.equal(isWithin(`${ROOT}\\`, ROOT, 'win32'), true);
  assert.equal(comparablePath('C:\\', 'win32'), 'c:\\');
  assert.equal(comparablePath('C:', 'win32'), 'c:\\');
  assert.equal(isWithin('C:\\coface', 'c:\\', 'win32'), true);
});

test('win32: un UNC non viene scambiato per la forma MSYS', () => {
  assert.equal(comparablePath('\\\\server\\share\\p', 'win32'), '\\\\server\\share\\p');
});

test('linux: il confronto resta quello di prima, case-sensitive', () => {
  assert.equal(isWithin('/home/u/loom-works', '/home/u/loom-works', 'linux'), true);
  assert.equal(isWithin('/home/u/loom-works/loom-deck', '/home/u/loom-works', 'linux'), true);
  assert.equal(isWithin('/home/u/Loom-Works', '/home/u/loom-works', 'linux'), false);
  assert.equal(isWithin('/home/u/loom-works-altro', '/home/u/loom-works', 'linux'), false);
  assert.equal(isWithin('/home/u/loom-works/', '/home/u/loom-works', 'linux'), true);
});

test('il nome del progetto è l\'ultimo segmento, coi separatori della piattaforma', () => {
  assert.equal(projectBaseName(ROOT, 'win32'), 'loom-works');
  assert.equal(projectBaseName('C:/coface/coface-hub', 'win32'), 'coface-hub');
  assert.equal(projectBaseName('/home/u/loom-works', 'linux'), 'loom-works');
  assert.equal(projectBaseName('/', 'linux'), '/');
});

test('win32: entrambe le cartelle di transcript della stessa root, `C--…` e `c--…`', () => {
  const entries = [
    'C--Users-x-proj',
    'c--Users-x-proj',
    'C--Users-x-proj-sub',
    'C--Users-x',
  ];
  assert.deepEqual(matchingDirNames(entries, 'C--Users-x-proj', 'win32'), ['C--Users-x-proj', 'c--Users-x-proj']);
});

test('linux: una cartella sola, il nome esatto', () => {
  assert.deepEqual(matchingDirNames(['-home-u-p', '-Home-u-p'], '-home-u-p', 'linux'), ['-home-u-p']);
});
