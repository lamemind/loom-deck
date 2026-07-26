import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, parseTaskDetail } from '../src/tasks.js';
import { normalizeEmoji } from '../src/viewport.js';

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
  // I glifi escono già normalizzati (VS16 aggiunto al confine da parseTasks):
  // confronto contro la stessa normalizzazione, non contro il glifo grezzo.
  const d02 = parseTasks(TASKS_MD).find((t) => t.id === 'D02');
  assert.equal(d02?.pri, normalizeEmoji('⚡'));
  assert.equal(d02?.prog, normalizeEmoji('🔵'));
  assert.equal(d02?.desc, 'Task attiva → contesto modello');
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
  assert.equal(detail.fields['Progress'], '🔵 Todo');
  assert.equal(detail.fields['Parent Task'], 'T34');
  assert.equal(detail.description, 'corpo');
});
