// T232 — gate di larghezza (vedi `frame-width.test.ts`): le schermate che
// leggono una cache o un sensore — il viewer del project status, la lista
// hard-wrap, l'indicatore del gitlink, il bottone di restore in testata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CTRL_G, CTRL_O, CTRL_W, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame, mixedIdProject, strip } from './frame-kit.js';
import { termWidth } from '../src/width.js';
import { VERSION } from '../src/version.js';

/** T121 — cache del recap a coordinata nota: senza, `^O` risponderebbe «nessun
 *  recap in cache» e lo scenario misurerebbe la lista invece del viewer. Le
 *  righe portano markdown reso e una riga più larga del box, che è ciò che il
 *  viewer deve tagliare. */
function statusCacheFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'deck-status-')), 'recap.md');
  writeFileSync(
    path,
    [
      '# Stato del progetto',
      '',
      '## Task aperte',
      '',
      `- **T121** — ${'una riga di recap lunga abbastanza da eccedere il box '.repeat(4)}`,
      '- `T109` — asfaltatura v2',
      '',
      'Chiusura con un paragrafo normale.',
    ].join('\n'),
  );
  return path;
}

/**
 * T134 — cache dello scan hard-wrap, sintetica: il gate non deve dipendere da
 * uno scan reale (cammina l'albero del progetto intero e dura minuti) né dal
 * fatto che chi lancia i test ne abbia già fatto uno.
 *
 * I path sono lunghi di proposito: la cella del path è l'unica elastica della
 * riga, quindi è l'unica che può sfondare il box, e su un terminale a 80
 * colonne un path da 120 caratteri è il caso vero — le task folder rientrano nel
 * perimetro dello scan (D3 preflight) e producono esattamente questi.
 */
function wrapCacheFileFixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'deck-wrap-')), 'scan.tsv');
  const lungo = `.26-08-11-review/${'sotto-cartella-lunga/'.repeat(5)}turno.md`;
  writeFileSync(
    path,
    [
      `WRAP\t${lungo}\tcol=93\tratio=0.82\tbreaks=41\tprose=50`,
      'WRAP\truntime/reference/doc-system/doc-system-topology.md\tcol=80\tratio=0.7\tbreaks=9\tprose=13',
      'misto\truntime/inbox/T134-note-una-riga-per-pensiero.md\tcol=\tratio=0.3\tbreaks=2\tprose=7',
      '',
    ].join('\n'),
  );
  return path;
}

/**
 * T155 — una cache del plugin FINTA con uno stub di `bump-gitlink.sh`.
 *
 * Il sensore del gitlink non classifica da sé: spawna lo script del plugin e
 * mostra il TSV che ne esce. Farlo girare sul plugin vero legherebbe il gate a
 * quale versione sia installata su questa macchina e a quanto siano allineati i
 * submodule del cappello in questo istante — cioè a due cose che cambiano da
 * sole, e con loro la larghezza dell'indicatore.
 *
 * La cartella di versione dev'essere una directory VERA: `resolvePluginCache`
 * filtra le entry con `isDirectory()`, che su un symlink a cartella è falso.
 *
 * Il TSV porta tutti i casi insieme, che è la forma più larga dell'indicatore:
 * tre disallineati (il numero) più un membro che nessun bump sistema (il glifo
 * di allerta accanto).
 */
function gitlinkCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'deck-gitlink-'));
  const dir = join(root, '99.0.0', 'scripts', 'utils');
  mkdirSync(dir, { recursive: true });
  const rows = [
    'loom-compass\\tallineato\\t-',
    'loom-deck\\tavanti\\tcf1df3b→19bb984 riga di dettaglio lunga come un subject vero',
    'loom-works-plugin\\tnon-pushato\\tgit -C loom-works-plugin push',
    'vendor/stale\\tindietro\\tgit submodule update -- vendor/stale',
    'vendor/mai-inizializzato\\tnon-inizializzato\\tgit submodule update --init -- vendor/mai-inizializzato',
  ];
  writeFileSync(
    join(dir, 'bump-gitlink.sh'),
    ['#!/bin/bash', ...rows.map((r) => `printf '${r}\\n'`), ''].join('\n'),
    { mode: 0o755 },
  );
  return root;
}

// T121 — il viewer del project status e i due stati «rumorosi» della testata.
// Vivono fuori da una tabella di scenari perché la cache va scritta prima, e un file
// temporaneo creato al modulo sarebbe condiviso da scenari che non lo usano.
for (const cols of [80, 100, 176]) {
  test(`gate larghezza · viewer project status @ ${cols} colonne`, { skip: SKIP }, () => {
    const raw = capture(cols, 38, CTRL_O, { LOOM_DECK_STATUS_FILE: statusCacheFile() });
    assertFrameFits(raw, cols, `project status@${cols}`);
  });

  // La testata durante una generazione porta il glifo di liveness più il
  // contatore: è la sua forma più larga, e su un terminale stretto compete con
  // `v<VERSION>` ancorata a destra.
  test(`gate larghezza · testata in building @ ${cols} colonne`, { skip: SKIP }, () => {
    const raw = capture(cols, 38, CTRL_G, { LOOM_DECK_STATUS_FILE: statusCacheFile() });
    assertFrameFits(raw, cols, `testata building@${cols}`);
  });
}

// T134 — la lista hard-wrap. Fuori da una tabella per la stessa ragione del
// project status: la cache va scritta prima, e un file temporaneo creato al
// modulo sarebbe condiviso da scenari che non lo usano.
for (const cols of [80, 100, 176]) {
  test(`gate larghezza · lista hard-wrap @ ${cols} colonne`, { skip: SKIP }, () => {
    const raw = capture(cols, 38, CTRL_W, { LOOM_DECK_WRAP_FILE: wrapCacheFileFixture() });
    assertFrameFits(raw, cols, `lista hard-wrap@${cols}`);
  });
}

// T155 — l'indicatore del gitlink accanto agli altri due, nella sua forma più
// larga. Fuori da una tabella per la stessa ragione del project status: la cache
// finta va scritta prima, e un temporaneo creato al modulo sarebbe condiviso da
// scenari che non lo usano.
//
// `W` non batte nulla: fa passare 0,7s, il tempo perché lo spawn del sensore
// torni e il frame si ridisegni col numero al posto di `missing`.
for (const cols of [80, 100, 176]) {
  test(`gate larghezza · indicatore gitlink @ ${cols} colonne`, { skip: SKIP }, () => {
    const raw = capture(cols, 38, 'WW', { LOOM_DECK_PLUGIN_CACHE_ROOT: gitlinkCacheRoot() });
    assertFrameFits(raw, cols, `indicatore gitlink@${cols}`);
    // Il numero deve esserci davvero: senza, il gate misurerebbe la larghezza
    // di `gitlink missing` e passerebbe senza aver mai visto il caso vero.
    if (cols >= 100) {
      assert.ok(
        lastFrame(raw).join('\n').includes('gitlink 3'),
        'indicatore assente o con un conteggio diverso da 3',
      );
    }
  });
}

/**
 * T181 — il progetto a id misti con due conversazioni MARCATE vive e nessuna
 * viva davvero: è lo stato del deck appena riaperto dopo la chiusura della
 * finestra. L'`HOME` dirottato non ha `~/.claude/sessions`, quindi il registro
 * vivo è vuoto per costruzione — il bottone compare, e nessun tick lo smarca.
 *
 * Il nome di progetto lungo della fixture è ciò che rende il caso un gate: il
 * project status a sinistra è l'unico pezzo elastico della testata, e se il
 * bottone non entrasse nel suo budget sarebbe lui a spingere la riga oltre il
 * bordo.
 */
function restoreProject(): string {
  const proj = mixedIdProject();
  appendFileSync(
    join(proj, '.claude', 'loom', 'session-tasks.jsonl'),
    ['1111', '2222'].map((sid) => JSON.stringify({ sessionId: sid, live: true })).join('\n') + '\n',
  );
  return proj;
}

for (const cols of [80, 100, 176]) {
  test(`gate larghezza · testata col bottone di restore @ ${cols} colonne`, { skip: SKIP }, () => {
    const proj = restoreProject();
    const raw = capture(cols, 38, 'W', { HOME: join(dirname(proj), 'home') }, proj);
    assertFrameFits(raw, cols, `restore@${cols}`);
    const frame = lastFrame(raw);
    assert.ok(frame[1]!.includes('[ restore 2 sessions ]'), `bottone assente in testata: ${frame[1]}`);
    assert.ok(frame[1]!.includes(`${cols}×38 · v${VERSION}`), 'risoluzione e versione restano a destra');
    assert.ok(frame[2]!.includes('^T restore'), `voce di legenda assente: ${frame[2]}`);
  });
}

// T181 — il click sul bottone rientra dalla porta della tastiera come `^T`: il
// restore parte (spawn inerte sotto `NO_SPAWN`), la tenuta toglie subito il
// bottone, e la riga di stato mostra in sequenza i comandi di ripresa. Sotto
// `NO_SPAWN` il figlio non esce mai, quindi ogni passo della serie avanza sul
// proprio timeout: dentro la cattura si vedono passare la prima e la seconda,
// in quest'ordine — il rango di entrata, non quello del file delle sessioni.
test('click sul bottone di restore → riprese in serie nell’ordine della marca', { skip: SKIP }, () => {
  const proj = restoreProject();
  const cols = 100;
  const right = `[ restore 2 sessions ]  ${cols}×38 · v${VERSION}`;
  // Ancorato al bordo destro: ultima colonna di testo = cols - 2, quindi il
  // blocco parte `termWidth(right)` colonne prima. Il click cade due colonne
  // dentro il bottone.
  const col = cols - 2 - termWidth(right) + 1 + 2;
  // Dopo il click, cinque `W` (3,5 s di attesa fissa): un passo della serie
  // avanza sul proprio timeout (`RESTORE_STEP_TIMEOUT_MS` di `actions.ts`, 3 s),
  // e la cattura non aspetta da sé — dopo l'ultimo tasto chiude sulla quiete
  // dello schermo, che arriva prima che la seconda ripresa parta.
  const raw = capture(cols, 38, `W@${col},2;WWWWW`, { HOME: join(dirname(proj), 'home') }, proj);
  const frame = lastFrame(raw);
  assertFrameFits(raw, cols, 'restore click');
  assert.ok(!frame[1]!.includes('restore 2 sessions'), `bottone ancora a schermo: ${frame[1]}`);
  const flow = raw.split(/\r?\n/).map(strip).join('\n');
  const first = flow.indexOf('--resume 1111');
  const second = flow.indexOf('--resume 2222');
  assert.ok(first >= 0, 'la ripresa della prima conversazione marcata non compare');
  assert.ok(second > first, 'la seconda non parte dopo la prima');
  assert.equal(flow.indexOf('--resume 3333'), -1, 'una conversazione non marcata è stata ripresa');
});
