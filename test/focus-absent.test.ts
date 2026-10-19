// T184 — il ripiego senza compass: binario del canale assente.
//
// È il ramo di Windows (nessun `gdbus`) e di un Linux senza glib, e non ha un
// gate di piattaforma: lo spawn fallisce con ENOENT e quello basta. Su una viva
// il deck scrive la nota e non fa altro — nessun resume, perché il processo
// `claude` c'è comunque.
//
// File separato perché il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), come in `notify.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FocusResult } from '../src/focus-session.js';

process.env.LOOM_DECK_FOCUS_CMD = '/non/esiste/gdbus-finto';
const { enterSession, focusSession } = await import('../src/focus-session.js');

test('binario assente: canale irraggiungibile, e il processo resta vivo', async () => {
  // ENOENT non arriva come throw: è un evento `error` ASINCRONO, e senza
  // listener ucciderebbe il runner stesso. Arrivare all'assert è metà del test.
  const r = await new Promise<FocusResult>((resolve) => focusSession('sid-1', resolve));
  assert.deepEqual(r, { unreachable: 'ENOENT' });
});

test('binario assente su una viva: nota «compass non raggiungibile», nessun resume', async () => {
  const resumed: string[] = [];
  const note = await new Promise<string>((resolve) => {
    const branch = enterSession('sid-viva', {
      isLive: () => true,
      nameOf: () => '🧵 loom-works · T184',
      focus: focusSession,
      resume: (id) => resumed.push(id),
      note: resolve,
    });
    assert.equal(branch, 'focus');
  });
  assert.equal(note, '⚠ compass non raggiungibile — 🧵 loom-works · T184');
  assert.deepEqual(resumed, [], 'una viva non si riprende nemmeno senza compass');
});
