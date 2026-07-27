import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, parseTaskDetail } from '../src/tasks.js';
import { sanitize } from '../src/width.js';

const TASKS_MD = `# Tasks

## Tasks Overview

| ID  | Pri | K  | Prog | Task (max 64)                    |
| --- | --- | -- | ---- | -------------------------------- |
| T40 | 🔥 | ⚙️ | 🔵 | Budget iniezione SessionStart    |
| D02 | ⚡ | 📝 | 🔵 | Task attiva → contesto modello   |
| D01 | ⚡ | 📝 | 🔵 | Importare la doc compass         |

## Lane attive

| Lane | Repos | Branch | Task | Stato |
|------|-------|--------|------|-------|
| _(nessuna lane attiva)_ |  |  |  |  |
`;

test('parseTasks prende sia le T sia le D', () => {
  const ids = parseTasks(TASKS_MD).map((t) => t.id);
  assert.deepEqual(ids, ['T40', 'D02', 'D01']);
});

test('parseTasks scarta header, separatori e righe di altre tabelle', () => {
  const ids = parseTasks(TASKS_MD).map((t) => t.id);
  assert.ok(!ids.includes('ID'));
  assert.ok(!ids.includes('Lane'));
  assert.ok(!ids.some((id) => id.startsWith('---')));
});

test('parseTasks legge le colonne giuste anche su riga D', () => {
  // pri/prog escono GREZZI: sono chiavi semantiche (isDone, lookup di view.ts,
  // riscrittura su tasks.md), sanificate solo al display. La desc invece passa
  // da sanitize come tutto il testo che finisce nel frame.
  const d02 = parseTasks(TASKS_MD).find((t) => t.id === 'D02');
  assert.equal(d02?.pri, '⚡');
  assert.equal(d02?.prog, '🔵');
  assert.equal(d02?.desc, 'Task attiva → contesto modello');
});

test('parseTasks tiene la desc GREZZA accanto a quella sanificata', () => {
  // `✔` è discorde (Ink lo misura 2, il terminale 1) → sanitize lo sostituisce
  // con `✅`. Il modale edit semina il campo titolo da `rawDesc`: con `desc`
  // salvare senza toccare il titolo riscriverebbe il glifo su tasks.md.
  const md = '| T01 | 🔥 | ⚙️ | 🔵 | fatto ✔ davvero |\n';
  const t01 = parseTasks(md)[0];
  assert.equal(t01.rawDesc, 'fatto ✔ davvero');
  assert.equal(t01.desc, sanitize('fatto ✔ davvero'));
  assert.notEqual(t01.desc, t01.rawDesc);
});

// I due template scrivono cappelli H1 diversi: entrambi vanno via, resta la
// descrizione. Senza lo strip la doc task mostrerebbe "Doc Task: …" nel pane.
test('parseTaskDetail strippa il cappello H1 di entrambi i template', () => {
  assert.equal(parseTaskDetail('T40', '# Task: Budget iniezione').title, 'Budget iniezione');
  assert.equal(parseTaskDetail('D01', '# Doc Task: Importare la doc').title, 'Importare la doc');
});

test('parseTaskDetail legge i bullet header di un D-file', () => {
  const detail = parseTaskDetail(
    'D01',
    ['# Doc Task: Importare la doc', '', '- **ID**: D01', '- **Priority**: Med', '- **Parent Task**: T34', '- **Progress**: 🔵 Todo', '', '## Description', '', 'corpo'].join('\n'),
  );
  assert.equal(detail.fields['Priority'], 'Med');
  assert.equal(detail.fields['Progress'], sanitize('🔵 Todo'));
  assert.equal(detail.fields['Parent Task'], 'T34');
  assert.equal(detail.description, 'corpo');
});
