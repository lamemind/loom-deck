// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il modo DLV del detail, la
// lista custom e l'orchestrator, sul progetto sintetico di `detail-fixture.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_R, ESC, SKIP } from './pty-harness.js';
import { capture, lastFrame } from './modes-kit.js';
import { DETAIL_RUN_MODEL, DETAIL_RUN_TITLE, detailProject } from './detail-fixture.js';

// ── T189 · il modo DLV del detail ────────────────────────────────────────
//
// Sul progetto SINTETICO di `detail-fixture.ts`: il modo di apertura dipende
// dalla task, e sul cappello vero quella condizione cambia a ogni checkpoint.
// L'argv si legge dalla riga di stato (`NO_SPAWN`), che `cutMiddle` taglia nel
// mezzo: la coda — prompt, modello, titolo — resta a schermo, il flag
// `--prompt` davanti a un perimetro eseguibile lungo può cadere nel taglio.

const RUN_TAIL = `--model ${DETAIL_RUN_MODEL} --title-note '${DETAIL_RUN_TITLE}'`;

function captureDetail(keys: string): string {
  const { proj, env } = detailProject();
  return lastFrame(capture(keys, proj, env));
}

test('modo DLV: ⏎ coi DLV selezionati lancia run col perimetro eseguibile, modello e titolo di run', {
  skip: SKIP,
}, () => {
  // Il cursore parte dal primo aperto (2); `↓` salta il 3, fatto, e va al 4.
  const frame = captureDetail('DD\r D \r');
  assert.ok(
    frame.includes(`'/loom-works:run-task T1 DLV 2,4' ${RUN_TAIL}`),
    `perimetro eseguibile, modello o titolo diversi da run: ${frame}`,
  );
});

test('modo DLV: ↑↓ si fermano solo sui DLV aperti', { skip: SKIP }, () => {
  // Dal 2, un `↓` salta il 3 (fatto): la selezione cade sul 4, non sul 3.
  const frame = captureDetail('DD\rD \r');
  assert.ok(frame.includes(`'/loom-works:run-task T1 DLV 4' ${RUN_TAIL}`), `cursore su un fatto: ${frame}`);
});

test('modo DLV: ⏎ senza selezione → apre a vuoto, come l\'azione open dei campi', { skip: SKIP }, () => {
  const frame = captureDetail('DD\r\r');
  assert.match(frame, /--prompt-kind none/, `non si è aperta a vuoto: ${frame}`);
  assert.ok(!frame.includes(RUN_TAIL), `modello o titolo di run su una open: ${frame}`);
});

test('modo DLV: la selezione non sopravvive alla chiusura del detail', { skip: SKIP }, () => {
  // Seleziona il 2, chiude con `esc`, riapre (`⏎` sulla lista) e lancia: il
  // perimetro eseguibile armato prima non deve partire.
  const frame = captureDetail(`DD\r ${ESC}\r\r`);
  assert.match(frame, /--prompt-kind none/, `selezione sopravvissuta: ${frame}`);
});

test('modo DLV: Size L senza preflight → avviso a schermo, sulla lista DLV', { skip: SKIP }, () => {
  // Il gate avvisa e non blocca: T3 si apre sulla lista, col motivo accanto al
  // prompt. Il rifiuto, se arriva, è di `run-task`.
  const frame = captureDetail('DDDD\r');
  assert.match(frame, /Size L senza preflight/, `avviso assente: ${frame}`);
  assert.match(frame, /\[ \] 1/, `non si è aperta sulla lista DLV: ${frame}`);
});

test('modo DLV: Size L senza preflight → ⏎ lancia lo stesso', { skip: SKIP }, () => {
  const frame = captureDetail('DDDD\r \r');
  assert.ok(frame.includes(`'/loom-works:run-task T3 DLV 1' ${RUN_TAIL}`), `lo spawn non è partito: ${frame}`);
});

test('modo DLV: task chiusa → lista spuntata, ⏎ apre a vuoto', { skip: SKIP }, () => {
  const list = captureDetail('DDD\rT');
  assert.match(list, /task chiusa · ⏎ open/, `stato spento assente: ${list}`);
  assert.doesNotMatch(list, /\[ \] \d/, `un DLV della task chiusa senza spunta: ${list}`);
  const frame = captureDetail('DDD\rT\r');
  assert.match(frame, /--prompt-kind none/, `non si è aperta a vuoto: ${frame}`);
});

test('modo DLV: una task non eseguibile si apre sui campi, come prima', { skip: SKIP }, () => {
  // T4 non ha DLV: `⏎` all'apertura è l'azione `open` dei campi.
  const frame = captureDetail('DDDDD\r\r');
  assert.match(frame, /--prompt-kind none/, `non si è aperta sui campi: ${frame}`);
});

// ── T212 · la lista custom ───────────────────────────────────────────────
//
// T5 della fixture è una lista custom: `DDDDDD` la seleziona, `\r` apre il detail.

test('lista custom: ^R scrive una nota e non apre nessuna tab', { skip: SKIP }, () => {
  const frame = captureDetail(`DDDDDD${CTRL_R}`);
  assert.match(frame, /\^R: T5 è una lista custom — niente run/, `nota assente: ${frame}`);
  assert.doesNotMatch(frame, /--prompt-kind run/, `il run è partito: ${frame}`);
});

test('lista custom: nel detail `r` non seleziona niente, ⏎ resta su open', { skip: SKIP }, () => {
  // Sulla lista custom il detail si apre sui campi (modo DLV spento) con l'azione
  // `open`: una `r` che puntasse ancora all'indice di `run` nel catalogo intero
  // selezionerebbe `status`, e partirebbe un recap.
  const frame = captureDetail('DDDDDD\rr\r');
  assert.match(frame, /--prompt-kind none/, `r ha selezionato un'azione: ${frame}`);
});

test('lista custom: `s` nel detail apre il recap del perimetro orchestrabile', { skip: SKIP }, () => {
  const frame = captureDetail('DDDDDD\rs\r');
  assert.match(frame, /recap-status-epic T5/, `non è il recap della lista custom: ${frame}`);
});

// ── T203 · l'orchestrator ──────────────────────────────────────────────────────
//
// `d` seleziona `direct` sui soli perimetri orchestrabili: T6 (epica, `DDDDDDD`) e T5
// (lista custom, `DDDDDD`). Il prompt, il modello e il titolo sono quelli della riga
// `orchestrator` del catalogo, senza override nella fixture. Su T4 (task semplice,
// aperta sui campi) la voce non c'è: `d` non seleziona niente e `⏎` resta su
// open.

test('epica: `d` nel detail apre l’orchestrator, opus, titolo 🎬', { skip: SKIP }, () => {
  const frame = captureDetail('DDDDDDD\rd\r');
  assert.ok(
    frame.includes(`'/loom-works:orchestrate-perimeter T6' --model opus --title-note '🎬 epica'`),
    `non è l'orchestrator dell'epica: ${frame}`,
  );
});

test('lista custom: `d` nel detail apre l’orchestrator, opus, titolo 🎬', { skip: SKIP }, () => {
  const frame = captureDetail('DDDDDD\rd\r');
  // La coda supera quella che `cutMiddle` lascia a 120 colonne: la testa del
  // prompt cade nel taglio, e la misura parte dalla skill.
  assert.ok(
    frame.includes(`orchestrate-perimeter T5' --model opus --title-note '🎬 lista custom'`),
    `non è l'orchestrator della lista custom: ${frame}`,
  );
});

test('task semplice: `d` nel detail non seleziona niente, ⏎ resta su open', { skip: SKIP }, () => {
  const fields = captureDetail('DDDDD\r');
  const row = fields.split('\n').find((l) => l.includes('[ open ]'));
  assert.ok(row, `riga azioni non renderizzata: ${fields}`);
  assert.ok(!row.includes('direct'), `l'orchestrator su una task semplice: ${row}`);
  const frame = captureDetail('DDDDD\rd\r');
  assert.match(frame, /--prompt-kind none/, `d ha selezionato un'azione: ${frame}`);
  assert.doesNotMatch(frame, /orchestrate-perimeter/, `l'orchestrator è partito: ${frame}`);
});
