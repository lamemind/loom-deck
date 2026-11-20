// T234 — il blocco dello schermo visto dal deck: le domande allo shell e la
// lettura delle risposte. Il canale vero contro un `gdbus` finto sta in
// `window-check.test.ts`, che lo esercita dal controllo della finestra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPASS_UUID,
  extensionInfoArgs,
  parseExtensionEnabled,
  parseScreenSaverActive,
  screenSaverActiveArgs,
} from '../src/screen-lock.js';

test('GetActive: (true,) e (false,), ogni altra forma è null', () => {
  assert.equal(parseScreenSaverActive('(true,)\n'), true);
  assert.equal(parseScreenSaverActive('(false,)'), false);
  for (const s of ['', 'true', '(1,)', "('true',)", 'Errore: GDBus.Error:…']) {
    assert.equal(parseScreenSaverActive(s), null, s);
  }
});

test('GetExtensionInfo: enabled dalla scheda, la scheda vuota di un uuid non installato è null', () => {
  // La scheda misurata di compass acceso, a schermo sbloccato (GNOME Shell 50).
  const real =
    "({'name': <'Project Compass'>, 'uuid': <'compass@lamemind'>, 'version': <1.0>, 'type': <2.0>, " +
    "'state': <1.0>, 'enabled': <true>, 'error': <''>, 'hasPrefs': <true>, 'sessionModes': <[<'user'>]>},)\n";
  assert.equal(parseExtensionEnabled(real), true);
  assert.equal(parseExtensionEnabled(real.replace("'enabled': <true>", "'enabled': <false>")), false);
  assert.equal(parseExtensionEnabled('(@a{sv} {},)'), null);
  assert.equal(parseExtensionEnabled(''), null);
});

test('argv: i due metodi dello shell, l’uuid di compass nudo in coda', () => {
  assert.deepEqual(screenSaverActiveArgs(), [
    'call',
    '--session',
    '--dest',
    'org.gnome.ScreenSaver',
    '--object-path',
    '/org/gnome/ScreenSaver',
    '--method',
    'org.gnome.ScreenSaver.GetActive',
    '--timeout',
    '2',
  ]);
  const info = extensionInfoArgs(COMPASS_UUID);
  assert.equal(info[7], 'org.gnome.Shell.Extensions.GetExtensionInfo');
  assert.equal(info.at(-1), 'compass@lamemind');
});
