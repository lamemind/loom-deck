// T250 — l'esito di `CANC` a potatura finita. Il deck non legge il materiale 💎
// di `## Materiale`: la task che lo porta la scopre dall'esito, cioè dalla riga
// di `tasks.md` che resta e dalla prima riga della risposta della skill, che
// nomina le task non rimosse col motivo. La riga di stato deve portare tutte e
// due le cose: una task protetta che sparisse in un «✔» o in un «⚠» muto
// sarebbe un'eliminazione dichiarata che non è avvenuta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeOutcomeNote } from '../src/task-ops.js';

const PROTECTED_REPLY =
  'non rimosse: T07 — materiale 💎 nella folder (.26-01-01-tool/tool.py)\n\nT08 eliminata.';

test('una task rifiutata per il 💎 resta nominata, col motivo della skill', () => {
  const note = purgeOutcomeNote(['T07', 'T08'], ['T07'], true, PROTECTED_REPLY);
  assert.match(note, /^⚠ 1\/2 eliminate · restano T07 · /);
  assert.match(note, /non rimosse: T07 — materiale 💎/);
  assert.doesNotMatch(note, /✔/);
});

test('un CANC su una sola task protetta non dichiara nessuna eliminazione', () => {
  const note = purgeOutcomeNote(['T07'], ['T07'], true, PROTECTED_REPLY);
  assert.match(note, /^⚠ 0\/1 eliminate · restano T07 · non rimosse: T07/);
});

test('la risposta su più righe entra in una riga sola, tagliata', () => {
  const note = purgeOutcomeNote(['T07', 'T08'], ['T07'], true, PROTECTED_REPLY);
  assert.doesNotMatch(note, /\n/);
  assert.match(note, /…$/);
});

test('tutte eliminate: ✔ e il push che manca', () => {
  assert.equal(
    purgeOutcomeNote(['T07', 'T08'], [], true, 'fatto'),
    '✔ 2 task eliminate · commit locali, nessun push',
  );
});

test('una skill fallita senza testo nomina il comando invece di tacere', () => {
  assert.match(purgeOutcomeNote(['T07'], ['T07'], false, ''), /restano T07 · \S+ -p$/);
});
