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
import { EDIT_PROG } from '../src/model.js';
import { PROG_ENTRIES } from '../src/view.js';

const TASKS_MD = `# Tasks

| ID  | Pri | Prog | Task (max 64)                    |
| --- | --- | ---- | -------------------------------- |
| T40 | 🔥 | 🔵 | Budget iniezione SessionStart    |
| T39 | ⚡ | ✔️ | Deck: filtri + sort              |
| T01 | ⚡ | 🔵 | Importare la doc compass         |
`;

test('updateTasksMdRow riscrive solo pri e prog della riga giusta', () => {
  const { content, ok } = updateTasksMdRow(TASKS_MD, 'T39', '🔥', '🟡');
  assert.equal(ok, true);
  assert.match(content, /\| T39 \| 🔥 \| 🟡 \| Deck: filtri \+ sort\s+\|/);
  // la riga non toccata resta identica
  assert.match(content, /\| T40 \| 🔥 \| 🔵 \|/);
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

// Qui si SCRIVE su disco: un indice cablato su una tabella più larga metterebbe
// il glifo di progresso sopra la prima parola del titolo.
test('updateTasksMdRow segue l’header anche con una colonna in più', () => {
  const larga = [
    '| ID  | Pri | K  | Prog | Task |',
    '| --- | --- | -- | ---- | ---- |',
    '| T40 | 🔥 | 📝 | 🔵 | Budget iniezione |',
  ].join('\n');
  const { content, ok } = updateTasksMdRow(larga, 'T40', '⚡', '🟡');
  assert.equal(ok, true);
  assert.match(content, /\| T40 \| ⚡ \| 📝 \| 🟡 \| Budget iniezione \|/);
});

test('updateTasksMdRow senza header non scrive nulla', () => {
  const orfana = '| T40 | 🔥 | 🔵 | Budget iniezione |\n';
  const { content, ok } = updateTasksMdRow(orfana, 'T40', '⚡', '🟡');
  assert.equal(ok, false);
  assert.equal(content, orfana);
});

test('updateTasksMdRow riscrive anche la descrizione quando la si passa', () => {
  const { content, ok } = updateTasksMdRow(TASKS_MD, 'T39', '⚡', '🟡', 'Titolo nuovo di zecca');
  assert.equal(ok, true);
  assert.match(content, /\| T39 \| ⚡ \| 🟡 \| Titolo nuovo di zecca \|/);
  // nessun residuo del titolo vecchio in coda alla riga
  assert.doesNotMatch(content, /filtri \+ sort/);
});

test('updateTasksMdRow: desc undefined ≠ desc vuota', () => {
  // undefined → cella intatta (chiamata di sola pri/prog)
  assert.match(updateTasksMdRow(TASKS_MD, 'T39', '⚡', '🟡').content, /Deck: filtri \+ sort/);
  // '' → cella davvero svuotata
  assert.match(updateTasksMdRow(TASKS_MD, 'T39', '⚡', '🟡', '').content, /\| T39 \| ⚡ \| 🟡 \|  \|/);
});

test('updateTasksMdRow: un `|` nel titolo viene escapato, non spezza la cella', () => {
  const { content } = updateTasksMdRow(TASKS_MD, 'T39', '⚡', '🟡', 'a | b');
  const row = content.split('\n').find((l) => l.startsWith('| T39'))!;
  // 4 colonne + le due stringhe vuote ai bordi = 6 token, come una riga sana
  assert.equal(row.split('|').length, 6 + 1); // +1: lo `\|` escapato resta uno split
  assert.match(row, /\| a \\\| b \|/);
});

test('updateTasksMdRow: descrizione con `|` già presente collassa in una cella sola', () => {
  const md = '| ID | Pri | Prog | Task |\n| T39 | ⚡ | 🔵 | vecchio | con pipe |\n';
  const { content } = updateTasksMdRow(md, 'T39', '⚡', '🟡', 'nuovo');
  assert.equal(content, '| ID | Pri | Prog | Task |\n| T39 | ⚡ | 🟡 | nuovo |\n');
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

test('updateTaskFileFields riscrive l’H1 conservando il cappello `Task:`', () => {
  const { content, ok } = updateTaskFileFields(TASK_FILE, 'High', '🟡 42%', 'Altro titolo');
  assert.equal(ok, true);
  assert.match(content, /^# Task: Altro titolo$/m);
});

test('updateTaskFileFields: H1 senza cappello resta senza cappello', () => {
  const plain = '# Vecchio\n\n- **Priority**: Low\n';
  const { content } = updateTaskFileFields(plain, 'Med', '🔵 Todo', 'Nuovo');
  assert.match(content, /^# Nuovo$/m);
});

test('updateTaskFileFields: title undefined lascia l’H1 intatto', () => {
  const { content } = updateTaskFileFields(TASK_FILE, 'High', '🟡 42%');
  assert.match(content, /^# Task: Qualcosa$/m);
});

test('updateTaskFileFields: solo l’H1 basta a rendere il file scritto', () => {
  const noFields = '# Task: Vecchio\n\ntesto libero\n';
  const { content, ok } = updateTaskFileFields(noFields, 'High', '🟡 42%', 'Nuovo');
  assert.equal(ok, true);
  assert.match(content, /^# Task: Nuovo$/m);
});

test('progressText: detail arbitrario vince sul default', () => {
  assert.equal(progressText('wip', '85%'), '🟡 85%');
  assert.equal(progressText('done', 'rifatta a mano', '2026-07-20'), '✔️ rifatta a mano');
});

test('progressText: default per stato, done data-stampato', () => {
  assert.equal(progressText('todo', ''), '🔵 Todo');
  assert.equal(progressText('ready', ''), '🟢 Ready');
  assert.equal(progressText('wip', '  '), '🟡 In Progress');
  assert.equal(progressText('locked', ''), '🔒 Locked');
  assert.equal(progressText('done', '', '2026-07-20'), '✔️ Done at 2026-07-20');
});

// Un valore di ProgName assente da EDIT_PROG lo retrocede a `todo` al salvataggio
// del modale: il cursore nasce da Math.max(0, indexOf(prog)), e -1 → 0.
test('EDIT_PROG copre ogni valore di ProgName', () => {
  for (const name of PROG_ENTRIES.map((e) => e.name)) {
    assert.ok(EDIT_PROG.includes(name), `${name} manca da EDIT_PROG`);
  }
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
