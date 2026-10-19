// T184 — `⏎` su una conversazione: le parti PURE di `focus-session.ts`.
//
// Il canale vero (un processo `gdbus`) sta in `focus-channel.test.ts` e in
// `focus-absent.test.ts`: il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), quindi ogni binario finto vuole un file suo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusNote, focusSessionArgs, parseFocusReply } from '../src/focus-session.js';

// L'argv È il contratto col metodo di compass (T183): un nome di interfaccia o
// di metodo sbagliato da un lato si scoprirebbe solo come `UnknownMethod` a
// runtime, cioè come «compass non raggiungibile» su un compass vivo.
test('focusSessionArgs: il metodo di compass, col timeout e il sessionId nudo in coda', () => {
  assert.deepEqual(focusSessionArgs('sid-1'), [
    'call',
    '--session',
    '--dest',
    'org.lamemind.Compass',
    '--object-path',
    '/org/lamemind/Compass',
    '--method',
    'org.lamemind.Compass.FocusSession',
    '--timeout',
    '5',
    'sid-1',
  ]);
});

test('parseFocusReply: la parola dentro la tupla di un elemento', () => {
  assert.equal(parseFocusReply("('tab',)\n"), 'tab');
  assert.equal(parseFocusReply("('esatta',)"), 'esatta');
  assert.equal(parseFocusReply("('sconosciuta',)\n"), 'sconosciuta');
});

test('parseFocusReply: un esito che compass aggiungesse passa così com’è', () => {
  // Il vocabolario non si ricopia qui: un esito nuovo deve arrivare nella nota
  // con la sua parola, non confondersi con un canale rotto.
  assert.equal(parseFocusReply("('nuovo',)"), 'nuovo');
});

test('parseFocusReply: una risposta di forma diversa non è un esito', () => {
  assert.equal(parseFocusReply(''), null);
  assert.equal(parseFocusReply('(true,)'), null);
  assert.equal(parseFocusReply("('tab', 'altro')"), null);
  assert.equal(parseFocusReply('tab'), null);
});

// Una nota a OGNI esito, successo compreso: la tab del deck va dietro, e la nota
// si legge al ritorno.
test('focusNote: sul successo il nome della conversazione raggiunta', () => {
  assert.equal(focusNote({ reached: true, outcome: 'tab' }, 'T184 «focus»'), '→ T184 «focus»');
  assert.equal(focusNote({ reached: true, outcome: 'esatta' }, 'T184 «focus»'), '→ T184 «focus»');
});

test('focusNote: ogni esito fuori dalla tab porta la sua parola e il nome', () => {
  for (const outcome of ['ambigua', 'assente', 'fallita', 'errore', 'nessuna', 'sconosciuta']) {
    assert.equal(
      focusNote({ reached: false, outcome }, 'T184 «focus»'),
      `⚠ focus ${outcome} — T184 «focus»`,
    );
  }
});

test('focusNote: il canale che fallisce non nomina un esito', () => {
  assert.equal(
    focusNote({ unreachable: 'ENOENT' }, 'T184 «focus»'),
    '⚠ compass non raggiungibile — T184 «focus»',
  );
});
