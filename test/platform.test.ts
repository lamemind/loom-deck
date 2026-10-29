// T175 — la mappa delle funzioni per piattaforma, e le tre superfici che la
// leggono senza React: l'avviso di un tasto, il marcatore di un indicatore,
// l'etichetta della vista `vive`.
//
// Gira su ogni piattaforma: `LOOM_DECK_PLATFORM` sostituisce quella vera per la
// sola mappa delle funzioni, e si legge a ogni chiamata — un caso la imposta e
// la rimette com'era, senza re-importare niente.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAvailable,
  offNote,
  offText,
  OFF_MARK,
  platform,
  refuse,
  UNAVAILABLE,
  type Feature,
} from '../src/platform.js';
import { gitlinkIndicator, inboxButton, wrapIndicator } from '../src/frame.js';
import { sessionView } from '../src/pane-views.js';

const ALL: Feature[] = ['spawn', 'liveSessions', 'pluginScripts', 'hardWrap', 'launch', 'notify'];

/** Esegue `fn` con la piattaforma delle funzioni forzata, poi la rimette. */
function onPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  const prev = process.env.LOOM_DECK_PLATFORM;
  process.env.LOOM_DECK_PLATFORM = p;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOOM_DECK_PLATFORM;
    else process.env.LOOM_DECK_PLATFORM = prev;
  }
}

test('su Linux nessuna funzione è spenta', () => {
  for (const f of ALL) assert.equal(isAvailable(f, 'linux'), true, f);
});

// T176 — `spawn` è la prima funzione riaccesa: tab di Windows Terminal al
// posto di Ptyxis. T177 — la seconda è `liveSessions`: liveness senza `/proc`.
// Le altre quattro restano alle loro figlie di fase 2.
const WIN_ON: Feature[] = ['spawn', 'liveSessions'];
const WIN_OFF: Feature[] = ALL.filter((f) => !WIN_ON.includes(f));

test('su Windows sono spente le quattro funzioni ancora senza figlia chiusa, spawn e liveSessions sono accese', () => {
  for (const f of WIN_OFF) assert.equal(isAvailable(f, 'win32'), false, f);
  for (const f of WIN_ON) assert.equal(isAvailable(f, 'win32'), true, f);
  // La mappa è il punto che una figlia tocca per riaccendere: nessuna voce
  // doppia, o togliere una voce sola lascerebbe la funzione spenta.
  const win = UNAVAILABLE.win32 ?? [];
  assert.equal(new Set(win).size, win.length);
});

test('una piattaforma senza voce ha tutte le funzioni', () => {
  for (const f of ALL) assert.equal(isAvailable(f, 'darwin'), true, f);
});

test("l'avviso nomina il tasto, la funzione e la piattaforma", () => {
  assert.equal(
    offNote('^K', 'spawn', undefined, 'win32'),
    '⚠ ^K → apertura di tab e conversazioni n/d su Windows',
  );
  assert.equal(
    offNote('CANC', 'liveSessions', 'eliminazione delle conversazioni', 'win32'),
    '⚠ CANC → eliminazione delle conversazioni n/d su Windows',
  );
  assert.equal(offText('pluginScripts', 'coda inbox', 'win32'), 'coda inbox n/d su Windows');
});

test('LOOM_DECK_PLATFORM sostituisce la piattaforma vera, e si legge a ogni chiamata', () => {
  const real = process.platform;
  onPlatform('win32', () => {
    assert.equal(platform(), 'win32');
    assert.equal(isAvailable('launch'), false);
  });
  onPlatform('linux', () => assert.equal(isAvailable('launch'), true));
  if (process.env.LOOM_DECK_PLATFORM === undefined) assert.equal(platform(), real);
});

test('refuse: su una funzione spenta scrive l\'avviso e ferma il chiamante', () => {
  const notes: string[] = [];
  const blocked = onPlatform('win32', () => refuse('launch', '3', (s) => notes.push(s)));
  assert.equal(blocked, true);
  assert.deepEqual(notes, ['⚠ 3 → voci launch n/d su Windows']);
});

test('refuse: su una funzione accesa non scrive niente e lascia passare', () => {
  const notes: string[] = [];
  const blocked = onPlatform('linux', () => refuse('launch', '3', (s) => notes.push(s)));
  assert.equal(blocked, false);
  assert.deepEqual(notes, []);
});

test('gli indicatori di una funzione spenta tengono l\'etichetta e mostrano n/d', () => {
  const counts = { nozioni: 0, derivazione: 0, sweep: 0, all: 0 } as never;
  assert.equal(
    inboxButton({ counts, stale: 3, scanned: false, ok: false, available: false }),
    inboxButton({ counts, stale: 0, scanned: true, ok: true, available: false }),
    'sirena e allerta non devono comparire accanto a una misura che non esiste',
  );
  assert.match(inboxButton({ counts, stale: 0, scanned: true, ok: true, available: false }), /^\[ Doc .* n\/d \]$/);
  assert.equal(wrapIndicator({ count: 4, mtime: 1, ok: true, scanning: false, available: false }), `wrap ${OFF_MARK}`);
  assert.equal(
    gitlinkIndicator({ count: 2, attention: 1, scanned: true, ok: true, failed: true, available: false }),
    `gitlink ${OFF_MARK}`,
  );
});

test('gli indicatori senza il campo `available` restano quelli di prima', () => {
  assert.equal(wrapIndicator({ count: 4, mtime: 1, ok: true, scanning: false }), 'wrap 4');
  assert.equal(gitlinkIndicator({ count: 0, attention: 0, scanned: true, ok: true, failed: false }), 'gitlink ok');
});

/** Esegue `fn` su una piattaforma finta che ha spente le sole `off`, poi la
 *  toglie dalla mappa. Serve al ramo «funzione spenta» di una funzione che
 *  nessuna piattaforma vera spegne più: il ramo resta nel codice, e va tenuto
 *  verde per la prossima piattaforma che non l'avesse. */
function onFakePlatform<T>(off: Feature[], fn: () => T): T {
  const fake = 'aix' as NodeJS.Platform;
  assert.equal(UNAVAILABLE[fake], undefined, 'la piattaforma finta non deve averne una vera');
  UNAVAILABLE[fake] = off;
  try {
    return onPlatform(fake, fn);
  } finally {
    delete UNAVAILABLE[fake];
  }
}

test('vista vive: su Windows il numero, come su Linux (T177)', () => {
  const counts = { total: 5, live: 2, pinned: 0, older: 0 };
  const live = sessionView('live');
  for (const p of ['win32', 'linux'] as const) {
    onPlatform(p, () => {
      assert.equal(live.label(counts, 'tutte'), '●2 vive', p);
      assert.equal(live.empty, 'nessuna conversazione viva in questa lista', p);
    });
  }
});

test('vista vive: dove la liveness manca nessun numero e la nota vuota nomina la piattaforma', () => {
  const counts = { total: 5, live: 0, pinned: 0, older: 0 };
  const live = sessionView('live');
  onFakePlatform(['liveSessions'], () => {
    assert.equal(live.label(counts, 'tutte'), '● vive n/d');
    assert.equal(live.empty, 'sessioni vive n/d su aix');
  });
});

test('CANC sulle conversazioni: su Windows la guardia di piattaforma lascia passare (T177)', () => {
  const notes: string[] = [];
  const blocked = onPlatform('win32', () =>
    refuse('liveSessions', 'CANC', (s) => notes.push(s), 'eliminazione delle conversazioni'),
  );
  assert.equal(blocked, false);
  assert.deepEqual(notes, []);
});
