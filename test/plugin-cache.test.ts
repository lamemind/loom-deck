// T134 — il risolutore della cache del plugin.
//
// Un solo difetto vale davvero un test qui, ed è silenzioso: la cartella delle
// cache contiene decine di versioni, e in ordine lessicografico `10.1.3`
// precede `7.9.1`. Un sort ingenuo sceglierebbe quindi una cache vecchia di due
// major, che esiste, gira e risponde col contratto di allora — nessun errore,
// solo numeri sbagliati.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareSemver,
  pickLatestVersion,
  resolvePluginCache,
} from '../src/plugin-cache.js';
import { unixOnly } from './platform-gates.js';

test('10.1.3 batte 7.9.1 — il caso che il sort lessicografico sbaglia', () => {
  assert.equal(compareSemver('10.1.3', '7.9.1'), 1);
  assert.equal(compareSemver('7.9.1', '10.1.3'), -1);
  // La prova che la stringa direbbe l'opposto, così il test resta leggibile
  // come dimostrazione e non come tautologia sul proprio comparatore.
  assert.ok('10.1.3' < '7.9.1');
});

test('ordine numerico su ogni componente', () => {
  assert.equal(compareSemver('7.10.0', '7.9.0'), 1);
  assert.equal(compareSemver('7.1.13', '7.1.2'), 1);
  assert.equal(compareSemver('11.3.1', '11.3.1'), 0);
  assert.equal(compareSemver('9.0.0', '11.0.0'), -1);
});

test('pickLatestVersion sulla forma reale della cartella cache', () => {
  // Le versioni realmente presenti su una macchina in esercizio: quaranta
  // cartelle in cui il massimo lessicografico (`9.0.0`) e quello numerico
  // (`11.3.1`) sono due cose diverse.
  const names = [
    '6.3.0', '7.0.0', '7.1.0', '7.1.2', '7.1.3', '7.2.0', '7.3.0', '7.9.0',
    '7.9.1', '7.10.0', '7.11.0', '7.12.0', '7.13.0', '8.0.0', '8.2.1', '9.0.0',
    '10.0.0', '10.1.0', '10.1.3', '11.0.0', '11.3.0', '11.3.1',
  ];
  assert.equal(pickLatestVersion(names), '11.3.1');
  assert.equal([...names].sort().at(-1), '9.0.0');
});

test('nomi non-semver ignorati, nessuno valido → null', () => {
  assert.equal(pickLatestVersion(['latest', 'main', '.tmp']), null);
  assert.equal(pickLatestVersion(['1.2', '1.2.3.4', '1.2.3']), '1.2.3');
  assert.equal(pickLatestVersion([]), null);
});

function withCacheRoot(names: string[], fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'deck-plugcache-'));
  const previous = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  try {
    for (const name of names) mkdirSync(join(root, name), { recursive: true });
    process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = root;
    fn(root);
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('resolvePluginCache sceglie la versione più alta e ne compone la radice', () => {
  withCacheRoot(['7.9.1', '10.1.3', '9.0.0'], (root) => {
    const cache = resolvePluginCache();
    assert.equal(cache?.version, '10.1.3');
    assert.equal(cache?.root, join(root, '10.1.3'));
  });
});

test('radice assente → null, mai un throw', () => {
  const previous = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = join(tmpdir(), 'deck-plugcache-inesistente-xyz');
  try {
    assert.equal(resolvePluginCache(), null);
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = previous;
  }
});

test('un file semver-simile non è una cache: solo directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-plugcache-'));
  const previous = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  try {
    writeFileSync(join(root, '99.0.0'), 'non sono una cartella');
    mkdirSync(join(root, '1.0.0'));
    process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = root;
    assert.equal(resolvePluginCache()?.version, '1.0.0');
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * T248 — una radice di cache vuota più una cartella FUORI dalla radice, verso
 * cui puntano i symlink: un link che punta dentro la radice stessa sarebbe una
 * versione in più, e il test misurerebbe anche quella.
 */
function withLinkedCacheRoot(fn: (root: string, outside: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'deck-plugcache-'));
  const outside = mkdtempSync(join(tmpdir(), 'deck-plugsrc-'));
  const previous = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  try {
    process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = root;
    fn(root, outside);
  } finally {
    if (previous === undefined) delete process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
    else process.env.LOOM_DECK_PLUGIN_CACHE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

test(
  'una cartella di versione in symlink a una cartella entra fra le candidate',
  { skip: unixOnly('symlink di cartella') },
  () => {
    withLinkedCacheRoot((root, outside) => {
      // La forma del collaudo contro un plugin non pubblicato: la versione più
      // alta è il link al sorgente, accanto a una cache vera più vecchia.
      mkdirSync(join(root, '1.0.0'));
      symlinkSync(outside, join(root, '99.0.0'), 'dir');
      const cache = resolvePluginCache();
      assert.equal(cache?.version, '99.0.0');
      assert.equal(cache?.root, join(root, '99.0.0'));
    });
  },
);

test(
  'un symlink rotto o verso un file resta fuori, senza eccezioni',
  { skip: unixOnly('symlink di cartella') },
  () => {
    withLinkedCacheRoot((root, outside) => {
      const file = join(outside, 'non-una-cartella');
      writeFileSync(file, 'sono un file');
      symlinkSync(join(outside, 'inesistente'), join(root, '98.0.0'), 'dir');
      symlinkSync(file, join(root, '99.0.0'), 'file');
      // Solo link scartati: nessuna versione, e null invece di un throw.
      assert.equal(resolvePluginCache(), null);
      // Con una cache vera accanto, vince lei anche se è la più bassa.
      mkdirSync(join(root, '1.0.0'));
      assert.equal(resolvePluginCache()?.version, '1.0.0');
    });
  },
);
