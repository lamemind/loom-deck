// T175 — come il deck lancia `claude` senza shell (P5 preflight). Puri: il
// filesystem è una coppia di funzioni, la piattaforma un parametro, quindi i
// casi di Windows girano anche su Linux.
//
// Lo shim npm del caso principale è copiato da uno generato da npm 11 sulla
// macchina Windows di T174 (`%APPDATA%\npm\loom-deck.cmd`), col solo bersaglio
// sostituito. Il caso `.cmd` non è collaudabile su quella macchina, che ha il
// solo `claude.exe` (verdetto 6): questo test è la sua unica misura.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCmdShim, resolveClaude, type ClaudeFs } from '../src/claude-cmd.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_DIR = 'C:\\Users\\u\\AppData\\Roaming\\npm';

const SHIM_NPM11 = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

// La forma di cmd-shim prima della v4: `%~dp0`, e il bersaglio su due righe.
const SHIM_OLD = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
)
`;

const CLI_JS = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

/** Un filesystem finto: i file che esistono, col loro contenuto. */
function fakeFs(files: Record<string, string>): ClaudeFs {
  return {
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
  };
}

test('shim di npm 11: il bersaglio .js parte col node del deck', () => {
  assert.deepEqual(parseCmdShim(SHIM_NPM11, `${NPM_DIR}\\claude.cmd`, NODE), {
    cmd: NODE,
    prefix: [CLI_JS],
  });
});

test('shim nella forma vecchia (%~dp0): stesso bersaglio', () => {
  assert.deepEqual(parseCmdShim(SHIM_OLD, `${NPM_DIR}\\claude.cmd`, NODE), {
    cmd: NODE,
    prefix: [CLI_JS],
  });
});

test('shim con un .exe come bersaglio: parte da sé, senza node', () => {
  const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  assert.deepEqual(parseCmdShim(shim, `${NPM_DIR}\\claude.cmd`, NODE), {
    cmd: `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    prefix: [],
  });
});

test('shim di uno script sh, o testo che non è uno shim: nessun bersaglio', () => {
  const sh = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\x\\run.sh" %*\r\n';
  assert.equal(parseCmdShim(sh, `${NPM_DIR}\\x.cmd`, NODE), null);
  assert.equal(parseCmdShim('echo ciao', `${NPM_DIR}\\x.cmd`, NODE), null);
});

test("l'override vince su tutto, e su Linux resta il comando così com'è", () => {
  const fs = fakeFs({});
  assert.deepEqual(resolveClaude({ LOOM_DECK_CLAUDE_CMD: '/opt/claude' }, 'linux', NODE, fs), {
    cmd: '/opt/claude',
    prefix: [],
  });
  assert.deepEqual(resolveClaude({ PATH: '/usr/bin' }, 'linux', NODE, fs), { cmd: 'claude', prefix: [] });
});

test("win32: claude.exe nel PATH → claude così com'è, anche con uno shim più avanti", () => {
  const fs = fakeFs({
    'C:\\Users\\u\\.local\\bin\\claude.exe': '',
    [`${NPM_DIR}\\claude.cmd`]: SHIM_NPM11,
  });
  const env = { PATH: `${NPM_DIR};C:\\Users\\u\\.local\\bin` };
  assert.deepEqual(resolveClaude(env, 'win32', NODE, fs), { cmd: 'claude', prefix: [] });
});

test('win32: solo lo shim npm → il suo bersaglio, senza cmd.exe', () => {
  const fs = fakeFs({ [`${NPM_DIR}\\claude.cmd`]: SHIM_NPM11 });
  assert.deepEqual(resolveClaude({ Path: `C:\\Windows;${NPM_DIR}` }, 'win32', NODE, fs), {
    cmd: NODE,
    prefix: [CLI_JS],
  });
});

test('win32: un override che nomina un .cmd passa dallo stesso parser', () => {
  const shim = 'D:\\tools\\claude.cmd';
  const fs = fakeFs({ [shim]: SHIM_NPM11 });
  assert.deepEqual(resolveClaude({ LOOM_DECK_CLAUDE_CMD: shim }, 'win32', NODE, fs), {
    cmd: NODE,
    prefix: ['D:\\tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
});

test("win32: niente nel PATH → claude nudo, e l'errore dello spawn dirà il fatto", () => {
  assert.deepEqual(resolveClaude({ PATH: 'C:\\Windows' }, 'win32', NODE, fakeFs({})), {
    cmd: 'claude',
    prefix: [],
  });
});
