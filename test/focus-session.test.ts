// T184 — `⏎` su una conversazione: le parti PURE di `focus-session.ts`.
//
// Il canale vero (un processo `gdbus`) sta in `focus-channel.test.ts` e in
// `focus-absent.test.ts`: il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), quindi ogni binario finto vuole un file suo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusSessionArgs, parseFocusReply } from '../src/focus-session.js';

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
