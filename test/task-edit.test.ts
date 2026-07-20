import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDetail,
  progressText,
  stripProgGlyph,
  today,
  updateTaskFileFields,
  updateTasksMdRow,
} from '../src/task-edit.js';

const TASKS_MD = `# Tasks

| ID  | Pri | K  | Prog | Task (max 64)                    |
| --- | --- | -- | ---- | -------------------------------- |
| T40 | 🔥 | ⚙️ | 🔵 | Budget iniezione SessionStart    |
| T39 | ⚡ | ⚙️ | ✔️ | Deck: filtri + sort              |
`;

test('updateTasksMdRow riscrive solo pri e prog della riga giusta', () => {
  const { content, ok } = updateTasksMdRow(TASKS_MD, 'T39', '🔥', '🟡');
  assert.equal(ok, true);
  assert.match(content, /\| T39 \| 🔥 \| ⚙️ \| 🟡 \| Deck: filtri \+ sort\s+\|/);
  // la riga non toccata resta identica
  assert.match(content, /\| T40 \| 🔥 \| ⚙️ \| 🔵 \|/);
});

test('updateTasksMdRow su id assente non tocca nulla', () => {
  const { content, ok } = updateTasksMdRow(TASKS_MD, 'T99', '🔥', '🟡');
  assert.equal(ok, false);
  assert.equal(content, TASKS_MD);
});

test('updateTasksMdRow ignora header e separatori', () => {
  const { ok } = updateTasksMdRow(TASKS_MD, 'ID', '🔥', '🟡');
  assert.equal(ok, false);
});

const TASK_FILE = `# Task: Qualcosa

- **ID**: T39
- **Priority**: Med
- **Progress**: 🔵 Todo

## Description

Testo con - **Progress**: residuo template che NON va toccato.
`;

test('updateTaskFileFields riscrive i primi bullet Priority/Progress', () => {
  const { content, ok } = updateTaskFileFields(TASK_FILE, 'High', '🟡 42%');
  assert.equal(ok, true);
  assert.match(content, /^- \*\*Priority\*\*: High$/m);
  assert.match(content, /^- \*\*Progress\*\*: 🟡 42%$/m);
  // first-match-wins: il residuo nel body resta com'era
  assert.match(content, /residuo template che NON va toccato/);
  assert.equal(content.match(/\*\*Progress\*\*: 🟡 42%/g)?.length, 1);
});

test('progressText: detail arbitrario vince sul default', () => {
  assert.equal(progressText('wip', '85%'), '🟡 85%');
  assert.equal(progressText('done', 'rifatta a mano', '2026-07-20'), '✔️ rifatta a mano');
});

test('progressText: default per stato, done data-stampato', () => {
  assert.equal(progressText('todo', ''), '🔵 Todo');
  assert.equal(progressText('wip', '  '), '🟡 In Progress');
  assert.equal(progressText('locked', ''), '🔒 Locked');
  assert.equal(progressText('done', '', '2026-07-20'), '✔️ Done at 2026-07-20');
});

test('stripProgGlyph toglie il glifo di testa e lascia il resto', () => {
  assert.equal(stripProgGlyph('🟡 85%'), '85%');
  assert.equal(stripProgGlyph('✔️ Done at 2026-07-20'), 'Done at 2026-07-20');
  assert.equal(stripProgGlyph('🔵 Todo'), 'Todo');
  assert.equal(stripProgGlyph(''), '');
});

test('initialDetail: testo uguale al default → vuoto (non appiccica al nuovo stato)', () => {
  assert.equal(initialDetail('🔵 Todo', 'todo'), '');
  assert.equal(initialDetail('🟡 In Progress', 'wip'), '');
  assert.equal(initialDetail('🔒 Locked', 'locked'), '');
  assert.equal(initialDetail('✔️ Done at 2026-07-20', 'done', '2026-07-20'), '');
  assert.equal(initialDetail('', 'todo'), '');
});

test('initialDetail: testo custom preservato', () => {
  assert.equal(initialDetail('🟡 85%', 'wip'), '85%');
  // data storica: il default di oggi non la riproduce → sopravvive, non si ri-stampa
  assert.equal(initialDetail('✔️ Done at 2026-07-14', 'done', '2026-07-20'), 'Done at 2026-07-14');
});

test('today usa la data LOCALE, non UTC', () => {
  // 23:30 locale del 20 → deve restare il 20 anche se in UTC è già il 21
  assert.equal(today(new Date(2026, 6, 20, 23, 30)), '2026-07-20');
});
