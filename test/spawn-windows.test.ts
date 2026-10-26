// T176 — il tasto `t` su Windows (P10 preflight): stessa primitiva delle
// conversazioni, una tab di Windows Terminal col profilo del deck e il titolo
// bloccato, ma senza comando — la shell è il `commandline` del profilo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalName, windowsTerminalArgs } from '../src/spawn.js';

test('tasto t su Windows: profilo, cartella e titolo bloccato, nessun comando', () => {
  assert.deepEqual(windowsTerminalArgs('C:\\p', '🖥️ p [term]', {}), [
    '-w',
    '0',
    'new-tab',
    '-p',
    'loom-deck',
    '-d',
    'C:\\p',
    '--title',
    '🖥️ p [term]',
    '--suppressApplicationTitle',
  ]);
  assert.ok(!windowsTerminalArgs('C:\\p', null, {}).includes('--'));
});

test('tasto t senza identità: nessun titolo, la tab prende quello della shell', () => {
  assert.deepEqual(windowsTerminalArgs('C:\\p', null, { LOOM_DECK_WT_PROFILE: '' }), ['-w', '0', 'new-tab', '-d', 'C:\\p']);
});

test('la nota di un terminale che non parte nomina il terminale della piattaforma', () => {
  assert.equal(terminalName('win32'), 'wt.exe');
  assert.equal(terminalName('linux'), 'ptyxis');
});
