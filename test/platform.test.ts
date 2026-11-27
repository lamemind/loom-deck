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
  type Tools,
} from '../src/platform.js';
import { gitlinkIndicator } from '../src/frame.js';
import { sessionView } from '../src/pane-views.js';

const ALL: Feature[] = ['spawn', 'liveSessions', 'pluginScripts', 'launch', 'notify', 'windowCheck'];

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
// T180 — la terza è `notify`: toast WinRT al posto di `notify-send`.
// T178 — la quarta è `pluginScripts`: gli script `.sh` col bash di Git.
// T179 — la quinta è `launch`: il comando `windows` delle voci col bash di Git.
const WIN_ON: Feature[] = ['spawn', 'liveSessions', 'notify', 'pluginScripts', 'launch'];
const WIN_OFF: Feature[] = ALL.filter((f) => !WIN_ON.includes(f));

/** Gli strumenti di una macchina finta: col bash di Git, o senza. */
const WITH_BASH: Tools = { gitBash: () => 'C:\\Git\\bin\\bash.exe' };
const NO_BASH: Tools = { gitBash: () => null };

test('su Windows col bash di Git è spento il solo controllo della finestra (T199), le altre sono accese', () => {
  for (const f of WIN_OFF) assert.equal(isAvailable(f, 'win32', WITH_BASH), false, f);
  for (const f of WIN_ON) assert.equal(isAvailable(f, 'win32', WITH_BASH), true, f);
  // La mappa è il punto che una figlia tocca per riaccendere: nessuna voce
  // doppia, o togliere una voce sola lascerebbe la funzione spenta.
  const win = UNAVAILABLE.win32 ?? [];
  assert.equal(new Set(win).size, win.length);
});

test('T178 — su Windows senza bash di Git gli script del plugin e le voci launch restano spenti, e le altre funzioni no', () => {
  assert.equal(isAvailable('pluginScripts', 'win32', NO_BASH), false);
  assert.equal(isAvailable('launch', 'win32', NO_BASH), false);
  assert.equal(offText('launch', undefined, 'win32', NO_BASH), 'voci launch n/d su Windows: bash di Git non trovato');
  for (const f of ['spawn', 'liveSessions', 'notify'] as Feature[]) {
    assert.equal(isAvailable(f, 'win32', NO_BASH), true, f);
  }
});

test('T178 — senza bash di Git l\'avviso di ^U nomina la causa (P4)', () => {
  assert.equal(
    offNote('^U', 'pluginScripts', 'bump del gitlink', 'win32', NO_BASH),
    '⚠ ^U → bump del gitlink n/d su Windows: bash di Git non trovato',
  );
});

test('T178 — il bash di Git non conta fuori da Windows: su Linux non si cerca nemmeno', () => {
  const never: Tools = {
    gitBash: () => {
      throw new Error('il bash di Git si cerca solo su win32');
    },
  };
  assert.equal(isAvailable('pluginScripts', 'linux', never), true);
  assert.equal(offText('launch', undefined, 'linux', never), 'voci launch n/d su Linux');
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
  assert.equal(
    offText('windowCheck', 'finestra del progetto', 'win32'),
    'finestra del progetto n/d su Windows',
  );
});

// T179 — `windowCheck` e non più `launch` come funzione spenta di riferimento:
// su Windows `launch` dipende dal bash di Git della macchina, e il caso
// cambierebbe esito fra la macchina Windows e quella Linux.
test('LOOM_DECK_PLATFORM sostituisce la piattaforma vera, e si legge a ogni chiamata', () => {
  const real = process.platform;
  onPlatform('win32', () => {
    assert.equal(platform(), 'win32');
    assert.equal(isAvailable('windowCheck'), false);
  });
  onPlatform('linux', () => assert.equal(isAvailable('windowCheck'), true));
  if (process.env.LOOM_DECK_PLATFORM === undefined) assert.equal(platform(), real);
});

test('refuse: su una funzione spenta scrive l\'avviso e ferma il chiamante', () => {
  const notes: string[] = [];
  const blocked = onPlatform('win32', () => refuse('windowCheck', '3', (s) => notes.push(s)));
  assert.equal(blocked, true);
  assert.deepEqual(notes, ['⚠ 3 → verifica della finestra del progetto n/d su Windows']);
});

test('refuse: su una funzione accesa non scrive niente e lascia passare', () => {
  const notes: string[] = [];
  const blocked = onPlatform('linux', () => refuse('launch', '3', (s) => notes.push(s)));
  assert.equal(blocked, false);
  assert.deepEqual(notes, []);
});

test('gli indicatori di una funzione spenta tengono l\'etichetta e mostrano n/d', () => {
  assert.equal(
    gitlinkIndicator({ count: 2, attention: 1, scanned: true, ok: true, failed: true, available: false }),
    `gitlink ${OFF_MARK}`,
  );
});

test('gli indicatori senza il campo `available` restano quelli di prima', () => {
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
