// T117 — il catalogo dei prompt come file DATI condiviso col primitive bash.
//
// Il test più importante non è il parser: è che il file esista davvero dove
// entrambi i lati lo cercano, e che contenga i kind che il deck sa nominare. Un
// catalogo che si legge a vuoto non produce nessun errore — apre solo sessioni
// senza prompt, cioè il guasto che si scopre usando il deck e non lanciando i
// test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPromptCatalog, promptFor, PROMPT_CATALOG } from '../src/prompt-catalog.js';
import { DETAIL_ACTIONS } from '../src/spawn.js';

test('il catalogo esiste dove il deck lo risolve', () => {
  assert.ok(existsSync(PROMPT_CATALOG), `catalogo assente: ${PROMPT_CATALOG}`);
});

test('ogni azione del detail trova il proprio testo, tranne open', () => {
  const catalog = loadPromptCatalog();
  for (const a of DETAIL_ACTIONS) {
    const p = promptFor(catalog, a.kind, 'T42');
    if (a.kind === 'none') {
      // `open` è l'assenza della voce, non un template vuoto: il campo prompt
      // resta vuoto e lo spawn non passa nessun prompt.
      assert.equal(p, '', 'open non deve avere un prompt');
    } else {
      assert.ok(p.length > 0, `nessun prompt per il kind ${a.kind}`);
      assert.match(p, /T42/, `il prompt di ${a.kind} non nomina la task: ${p}`);
      // Vincolo di quoting del catalogo: il testo finisce dentro apici singoli
      // nel comando in-tab, e questo file è committato — un apice qui sarebbe un
      // errore di scrittura, non un input da quotare.
      assert.ok(!p.includes("'"), `apice singolo nel template di ${a.kind}: ${p}`);
    }
  }
});

test('parse: commenti e righe vuote non entrano nella mappa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const f = join(dir, 'cat');
  writeFileSync(f, ['# commento', '', 'run\tfai {TASK}', 'senza tab', 'x\ty'].join('\n'));
  const c = loadPromptCatalog(f);
  assert.deepEqual([...c.keys()].sort(), ['run', 'x']);
  assert.equal(promptFor(c, 'run', 'T7'), 'fai T7');
});

test('file assente → mappa vuota, non un default cablato', () => {
  // Un fallback scritto nel deck sarebbe la copia del catalogo che il file dati
  // esiste per non avere, e divergerebbe in silenzio.
  const c = loadPromptCatalog('/non/esiste/affatto');
  assert.equal(c.size, 0);
  assert.equal(promptFor(c, 'run', 'T7'), '');
});

test('{TASK} si interpola ovunque compaia, non solo la prima volta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const f = join(dir, 'cat');
  writeFileSync(f, 'run\t{TASK} poi ancora {TASK}\n');
  assert.equal(promptFor(loadPromptCatalog(f), 'run', 'T9'), 'T9 poi ancora T9');
});
