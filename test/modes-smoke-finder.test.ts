// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il finder delle task, il
// modale delle combo e la riga due.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESC, PROJECT, SKIP } from './pty-harness.js';
import { LIST_FRAME, capture, lastFrame } from './modes-kit.js';
import { detailProject } from './detail-fixture.js';

// ── T169 · il finder delle task ──────────────────────────────────────────
//
// Sul progetto SINTETICO di `detail-fixture.ts`, con la vista salvata che
// nasconde le chiuse: T2 (✔️) è proprio la task che il pane non mostra, cioè il
// caso per cui il finder esiste. Sul cappello vero gli id cambiano a ogni purga.

function finderProject(): { proj: string; env: NodeJS.ProcessEnv } {
  const p = detailProject();
  writeFileSync(
    join(p.proj, '.claude', 'loom', 'deck-view.json'),
    JSON.stringify({ sort: [{ key: 'id', dir: 'asc' }], hiddenPri: [], hiddenProg: ['done'] }),
  );
  return p;
}

test('finder: esc chiude senza effetti, il deck torna alla lista', { skip: SKIP }, () => {
  const { proj, env } = finderProject();
  const frame = lastFrame(capture(`\`T2${ESC}`, proj, env));
  assert.doesNotMatch(frame, /trova task/i, `il finder è rimasto aperto: ${frame}`);
  assert.match(frame, LIST_FRAME, `il deck non è tornato alla lista: ${frame}`);
  // Nessun salto: il pane resta sulla vista principale, sulla riga d'apertura.
  assert.doesNotMatch(frame, /→ T2/, `esc ha fatto il salto: ${frame}`);
});

test('finder: un id nascosto dai filtri si trova, e ⏎ lo apre nel detail', { skip: SKIP }, () => {
  const { proj, env } = finderProject();
  const frame = lastFrame(capture('`T2\r', proj, env));
  // La riga meta del detail porta id e titolo della task aperta: il titolo è
  // l'H1 del task file, la forma lunga, non la riga di tasks.md («chiusa»).
  assert.match(frame, /T2 · T2 del collaudo/, `il detail non è quello di T2: ${frame}`);
});

test('finder: → su una task nascosta porta il pane su nascoste e il fuoco sulle conversazioni', {
  skip: SKIP,
}, () => {
  const { proj, env } = finderProject();
  const frame = lastFrame(capture('`T2R', proj, env));
  assert.match(frame, /→ T2 · vista 1 nascoste · conversazioni/, `riga di stato del salto: ${frame}`);
  // L'header del pane conversazioni nomina il parent: è la task selezionata.
  assert.match(frame, /Sessions · T2/, `il pane conversazioni non segue T2: ${frame}`);
});

// ── T194 · il modale delle combo ─────────────────────────────────────────

test('combo: esc torna alla lista, col fuoco sul pane da cui si è entrati', { skip: SKIP }, () => {
  const closed = lastFrame(capture(`RH${ESC}`));
  assert.doesNotMatch(closed, /tutte le azioni/, `il modale è rimasto aperto: ${closed}`);
  assert.match(closed, LIST_FRAME, `il deck non è tornato alla lista: ${closed}`);
  // Il modale è uguale da ogni pane, quindi il fuoco si legge da `N`: dal pane
  // conversazioni apre il campo del titolo (`✎`), dal pane task lo rifiuta con una
  // nota.
  assert.match(lastFrame(capture(`RH${ESC}N`)), /✎ ›/, 'il fuoco non è rimasto a destra');
  assert.match(lastFrame(capture(`H${ESC}N`)), /seleziona una sessione/, 'il fuoco non è rimasto a sinistra');
});

test('combo: le tre liste stanno insieme, qualunque sia il pane a fuoco', { skip: SKIP }, () => {
  const onTask = lastFrame(capture('DDH'));
  const lists: Array<[string, RegExp[]]> = [
    ['generali', [/tab\s+vista/, /←→\s+pane/, /T\s+trova/, /\^F\s+cerca/, /t\s+terminale/, /c\s+claude/]],
    ['task', [/⏎\s+detail/, /\^K\/\^P\/\^R\s+spawn/, /C\s+nuova/, /E\s+edit/, /S\s+sort/, /F\s+filtri/, /w\s+salva/]],
    ['conversazioni', [/⏎\s+resume/, /f\s+fork/, /m\s+modello/, /p\s+pin/, /a\s+priorità/, /N\s+titolo/, /A\s+assegna/]],
  ];
  for (const [name, voices] of lists) {
    for (const voice of voices) assert.match(onTask, voice, `voce di ${name} assente: ${onTask}`);
  }
  assert.match(onTask, /task\s+conversazioni/, `le colonne non sono affiancate: ${onTask}`);
  assert.match(onTask, /⏎\s+detail\s+⏎\s+resume/, `le colonne non sono affiancate: ${onTask}`);
  assert.ok(onTask.indexOf('tab') < onTask.indexOf('⏎'), `le generali non stanno in alto: ${onTask}`);
  assert.equal(lastFrame(capture('RH')), onTask, 'il modale cambia col pane a fuoco');
});

test('combo: il deck non ha un modo doc, e `^B` non monta niente', { skip: SKIP }, () => {
  // T249 — via l'albero doc e il pane inbox: `^B` non ha più un ramo, e il
  // modale resta quello delle task e delle conversazioni.
  const frame = lastFrame(capture('\x02H'));
  assert.match(frame, /task\s+conversazioni/, `colonne del deck assenti: ${frame}`);
  assert.doesNotMatch(frame, /\^B|albero doc|inbox/, `il modo doc è ancora annunciato: ${frame}`);
});

test('riga due: resta la voce del modale, la legenda intera non c\'è più', { skip: SKIP }, () => {
  const line = lastFrame(capture('')).split('\n')[2] ?? '';
  assert.match(line, /H combo/, `voce del modale assente: ${line}`);
  // Il cappello ha submodule: l'indicatore del gitlink c'è, e nessun altro.
  assert.match(line, /gitlink/, `indicatore del gitlink assente: ${line}`);
  assert.doesNotMatch(line, /\[ Doc|wrap/, `indicatori tolti ancora in riga due: ${line}`);
  assert.doesNotMatch(line, /genera status|T trova|\^B doc/, `legenda ancora in riga due: ${line}`);
});

/** Una cache del plugin FINTA il cui `bump-gitlink.sh` dà ogni membro allineato:
 *  il contatore è a zero, e `^U` rifiuta il bump senza spawnare niente. */
function alignedGitlinkCache(): string {
  const root = mkdtempSync(join(tmpdir(), 'deck-gitlink-ok-'));
  const dir = join(root, '99.0.0', 'scripts', 'utils');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bump-gitlink.sh'),
    ['#!/bin/bash', "printf 'loom-deck\\tallineato\\t-\\n'", ''].join('\n'),
    { mode: 0o755 },
  );
  return root;
}

test('riga due: il click su un indicatore rientra dalla sua combo', { skip: SKIP }, () => {
  // L'indicatore del gitlink finisce sull'ultima colonna di testo: bordo destro
  // meno bordo e padding. Colonna 116 di 120 cade dentro `gitlink ok`, e il
  // click preme `^U`. Lo script è uno stub coi membri allineati: il bump rifiuta
  // e lo dice, e nessun commit tocca il cappello. `WW` aspetta la prima misura.
  const frame = lastFrame(
    capture('WW@116,3;', PROJECT, { LOOM_DECK_PLUGIN_CACHE_ROOT: alignedGitlinkCache() }),
  );
  assert.match(frame, /\^U → gitlink già allineato/, `il click non ha premuto ^U: ${frame}`);
});
