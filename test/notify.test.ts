// T121 — la notifica di fine generazione non deve poter portare via la TUI.
//
// File separato e non un caso dentro `spawn.test.ts`: il comando si legge a
// import-time (`NOTIFY_CMD`), quindi l'env va scritta prima che il modulo
// entri — e in `spawn.test.ts` è già importato in cima.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('un binario di notifica assente non abbatte il processo', async () => {
  process.env.LOOM_DECK_NOTIFY_CMD = '/non/esiste/notify-send-finto';
  const { notifyDone } = await import('../src/spawn.js');

  const child = notifyDone('loom-deck · project status', 'recap pronto');

  // ENOENT non arriva come throw: è un evento `error` ASINCRONO, e in Node un
  // evento `error` senza listener diventa un'eccezione non catturata — cioè la
  // morte del processo, qui il runner stesso. Il test è quindi il fatto di
  // arrivare vivi all'assert dopo che l'evento è passato.
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(child, 'nessun figlio restituito');
  assert.equal(child.killed, false, 'il figlio è stato ucciso invece di fallire da solo');
});
