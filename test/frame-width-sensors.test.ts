// T232 — gate di larghezza (vedi `frame-width.test.ts`): le schermate che
// leggono un sensore — l'indicatore del gitlink, il bottone di restore in
// testata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame, mixedIdProject, strip } from './frame-kit.js';
import { termWidth } from '../src/width.js';
import { VERSION } from '../src/version.js';

/**
 * T155 — una cache del plugin FINTA con uno stub di `bump-gitlink.sh`.
 *
 * Il sensore del gitlink non classifica da sé: spawna lo script del plugin e
 * mostra il TSV che ne esce. Farlo girare sul plugin vero legherebbe il gate a
 * quale versione sia installata su questa macchina e a quanto siano allineati i
 * submodule del cappello in questo istante — cioè a due cose che cambiano da
 * sole, e con loro la larghezza dell'indicatore.
 *
 * La cartella di versione è una directory vera per scelta, non per obbligo:
 * `resolvePluginCache` accetta anche un symlink a cartella (T248), ma una
 * cartella vera tiene la fixture tutta dentro la sua radice temporanea, senza
 * un secondo path da creare e da pulire.
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

// T155 — l'indicatore del gitlink, nella sua forma più larga. Fuori da una
// tabella perché la cache finta va scritta prima, e un temporaneo creato al
// modulo sarebbe condiviso da scenari che non lo usano.
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
 * nome a sinistra è l'unico pezzo elastico della testata, e se il bottone non
 * entrasse nel suo budget sarebbe lui a spingere la riga oltre il bordo.
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
