// T131 — il custode che mancava allo split.
//
// `MODE_KEYS` è un `Record<CapturingMode, Handler>`: un modo nuovo senza
// handler non compila. Quello che il tipo NON impedisce è che l'handler viva
// dentro il file del dispatch invece che in un overlay, e T112 lo ha
// dimostrato — modo dichiarato, voce riempita, compilazione verde, e
// centosessantacinque righe di purge rimaste in `cli.tsx` per ventun versioni,
// finché uno split non è tornato a toglierle.
//
// Il gate legge il sorgente come TESTO, che è l'unico modo di verificare DOVE
// vive una funzione: un test che importasse `MODE_KEYS` vedrebbe funzioni
// identiche qualunque sia il file che le ospita. Stesso pattern di
// `deck-run.test.ts`, che ispeziona uno script bash allo stesso modo.
//
// Cosa fa fallire questo gate, e cosa fare: una voce di `MODE_KEYS` scritta
// come funzione locale (`create: onCreateKey`) invece che come metodo di un
// overlay (`create: overlays.text.onCreateKey`). Il rimedio non è allentare il
// gate — è portare stato e handler in un hook sotto `src/overlays/`, che è la
// forma che tutti gli altri modi hanno già.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURING_MODES } from '../src/input-modes.js';

const PKG = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const INPUT_SRC = join(PKG, 'src', 'input.ts');

/** Le voci di un `Record` letterale, come coppie `chiave: valore` testuali. */
function recordEntries(src: string, name: string): Array<[string, string]> {
  const start = src.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `${name} non trovato in src/input.ts`);
  const open = src.indexOf('{', src.indexOf('=', start));
  const close = src.indexOf('\n  };', open);
  assert.ok(close > open, `corpo di ${name} non delimitato`);
  return src
    .slice(open + 1, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.replace(/,$/, ''))
    .map((l) => {
      const at = l.indexOf(':');
      return [l.slice(0, at).trim(), l.slice(at + 1).trim()] as [string, string];
    });
}

test('MODE_KEYS: ogni modo capturing ha la sua voce', () => {
  const entries = recordEntries(readFileSync(INPUT_SRC, 'utf8'), 'MODE_KEYS');
  const declared = entries.map(([k]) => k).sort();
  assert.deepEqual(
    declared,
    [...CAPTURING_MODES].sort(),
    'il catalogo dei modi capturing e le voci di MODE_KEYS devono coincidere',
  );
});

test('MODE_KEYS: nessun handler vive dentro il dispatch', () => {
  const src = readFileSync(INPUT_SRC, 'utf8');
  const entries = recordEntries(src, 'MODE_KEYS');
  for (const [mode, handler] of entries) {
    assert.match(
      handler,
      /^overlays\.\w+\.\w+$/,
      `il modo '${mode}' punta a '${handler}': un handler deve essere il metodo di un overlay ` +
        `(overlays.<nome>.<metodo>), non una funzione dichiarata in src/input.ts. ` +
        `Portalo in un hook sotto src/overlays/, come gli altri modi.`,
    );
  }
});

test('MODE_WHEEL: anche lo scroll dei modi scorrevoli viene dagli overlay', () => {
  const src = readFileSync(INPUT_SRC, 'utf8');
  for (const [mode, handler] of recordEntries(src, 'MODE_WHEEL')) {
    assert.match(
      handler,
      /^overlays\.\w+\.\w+$/,
      `il modo scorrevole '${mode}' punta a '${handler}', che non è un metodo di overlay`,
    );
  }
});

test('il dispatch non dichiara funzioni di handler proprie', () => {
  // Le uniche funzioni ammesse in `src/input.ts` sono il dispatch stesso e i
  // suoi tre rami di smistamento. Una `onXxxKey` qui dentro è esattamente il
  // difetto che il gate esiste per intercettare.
  const src = readFileSync(INPUT_SRC, 'utf8');
  const dichiarate = [...src.matchAll(/^\s*function (\w+)\(/gm)].map((m) => m[1]!);
  const ammesse = new Set(['onKey', 'onMouse', 'onListClick', 'onQuitKey', 'useDeckInput']);
  const intruse = dichiarate.filter((n) => !ammesse.has(n));
  assert.deepEqual(
    intruse,
    [],
    `src/input.ts dichiara ${intruse.join(', ')}: il dispatch smista, non implementa`,
  );
});

test('cli.tsx resta composizione: nessun handler di tastiera al suo interno', () => {
  // Il gemello del controllo sopra, sul file da cui tutto è uscito: è lì che la
  // logica rientra per gravità, perché nel corpo del componente ogni stato è
  // già in scope.
  const src = readFileSync(join(PKG, 'src', 'cli.tsx'), 'utf8');
  const dichiarate = [...src.matchAll(/^\s*function (\w+)\(/gm)].map((m) => m[1]!);
  assert.deepEqual(
    dichiarate,
    ['Deck'],
    `cli.tsx dichiara ${dichiarate.join(', ')}: deve contenere il solo componente di composizione`,
  );
});
