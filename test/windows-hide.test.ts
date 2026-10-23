// T175 — il custode di `windowsHide`: ogni processo figlio del deck nasce
// senza finestra su Windows.
//
// Una sede di spawn che dimentica l'opzione non rompe niente su Linux, dove
// l'opzione non ha effetto, e su Windows fa lampeggiare una finestra console a
// ogni giro di uno scan. Il guasto non si vede da nessun test di
// comportamento, quindi il custode legge il sorgente: le chiamate dirette a
// `child_process` stanno in pochi file, e ognuna deve nominare l'opzione — tranne
// `spawn` dentro `spawnOut`, che la impone a tutti i suoi chiamanti.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Il testo della chiamata che si apre all'indice `open` (la parentesi). */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

test('ogni chiamata diretta a child_process passa windowsHide', () => {
  const missing: string[] = [];
  let calls = 0;
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('node:child_process')) continue;
    // Nessun `exec` nudo nel pattern: nel deck nessuno usa `child_process.exec`,
    // e `.exec(` è quasi sempre quello di una RegExp. Il lookbehind esclude i
    // metodi (`x.spawn(`) e i nomi più lunghi.
    const re = /(?<![.\w])(execFileAsync|execFileSync|execFile|spawnSync|spawn)\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const before = src.slice(Math.max(0, m.index - 10), m.index);
      if (before.endsWith('promisify(')) continue; // `promisify(execFile)`, non una chiamata
      const text = callText(src, m.index + m[0].length - 1);
      calls++;
      if (!text.includes('windowsHide')) {
        const line = src.slice(0, m.index).split('\n').length;
        missing.push(`${file.slice(SRC.length)}:${line} ${m[1]}`);
      }
    }
  }
  assert.ok(calls > 0, 'nessuna chiamata trovata: il custode non misura più niente');
  assert.deepEqual(missing, []);
});
