import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, parseTaskDetail, headerColumns } from '../src/tasks.js';
import { sanitize } from '../src/width.js';

const TASKS_MD = `# Tasks

## Tasks Overview

| ID  | Pri | Prog | Task (max 64)                    |
| --- | --- | ---- | -------------------------------- |
| T40 | 🔥 | 🔵 | Budget iniezione SessionStart    |
| T19 | ⚡ | 🔵 | Task attiva → contesto modello   |
| T01 | ⚡ | 🔵 | Importare la doc compass         |

## Lane attive

| Lane | Repos | Branch | Task | Stato |
|------|-------|--------|------|-------|
| _(nessuna lane attiva)_ |  |  |  |  |
`;

test('parseTasks prende le righe della overview', () => {
  const ids = parseTasks(TASKS_MD).map((t) => t.id);
  assert.deepEqual(ids, ['T40', 'T19', 'T01']);
});

test('parseTasks scarta header, separatori e righe di altre tabelle', () => {
  const ids = parseTasks(TASKS_MD).map((t) => t.id);
  assert.ok(!ids.includes('ID'));
  assert.ok(!ids.includes('Lane'));
  assert.ok(!ids.some((id) => id.startsWith('---')));
});

test('parseTasks legge le colonne giuste', () => {
  // pri/prog escono GREZZI: sono chiavi semantiche (isDone, lookup di view.ts,
  // riscrittura su tasks.md), sanificate solo al display. La desc invece passa
  // da sanitize come tutto il testo che finisce nel frame.
  const t19 = parseTasks(TASKS_MD).find((t) => t.id === 'T19');
  assert.equal(t19?.pri, '⚡');
  assert.equal(t19?.prog, '🔵');
  assert.equal(t19?.desc, 'Task attiva → contesto modello');
});

// Il gate della trappola: gli indici vengono dall'HEADER, non dal conteggio.
// Con `cells[2]`/`cells[4]` cablati questa tabella darebbe pri='📝' e prog=desc.
test('parseTasks segue l’header anche con una colonna in più', () => {
  const larga = [
    '| ID  | Pri | K  | Prog | Task |',
    '| --- | --- | -- | ---- | ---- |',
    '| T40 | 🔥 | 📝 | 🟡 | Budget iniezione |',
  ].join('\n');
  const t40 = parseTasks(larga)[0];
  assert.equal(t40.pri, '🔥');
  assert.equal(t40.prog, '🟡');
  assert.equal(t40.desc, 'Budget iniezione');
});

// Senza header non si tira a indovinare: lista vuota (fallimento visibile)
// invece di celle lette al posto sbagliato (fallimento silenzioso).
test('parseTasks senza header non parsa niente', () => {
  assert.deepEqual(parseTasks('| T01 | 🔥 | 🔵 | orfana |\n'), []);
});

test('headerColumns riconosce solo l’header della overview', () => {
  assert.deepEqual(headerColumns('| ID | Pri | Prog | Task |'), { pri: 2, prog: 3, desc: 4 });
  assert.equal(headerColumns('| Lane | Repos | Branch | Task | Stato |'), null);
  assert.equal(headerColumns('| T40 | 🔥 | 🔵 | roba |'), null);
  assert.equal(headerColumns('testo qualunque'), null);
});

test('parseTasks tiene la desc GREZZA accanto a quella sanificata', () => {
  // `✔` è discorde (Ink lo misura 2, il terminale 1) → sanitize lo sostituisce
  // con `✅`. Il modale edit semina il campo titolo da `rawDesc`: con `desc`
  // salvare senza toccare il titolo riscriverebbe il glifo su tasks.md.
  const md = '| ID | Pri | Prog | Task |\n| T01 | 🔥 | 🔵 | fatto ✔ davvero |\n';
  const t01 = parseTasks(md)[0];
  assert.equal(t01.rawDesc, 'fatto ✔ davvero');
  assert.equal(t01.desc, sanitize('fatto ✔ davvero'));
  assert.notEqual(t01.desc, t01.rawDesc);
});

// Il cappello `Task:` del template va via: resta la descrizione.
test('parseTaskDetail strippa il cappello H1', () => {
  assert.equal(parseTaskDetail('T40', '# Task: Budget iniezione').title, 'Budget iniezione');
  assert.equal(parseTaskDetail('T01', '# Importare la doc').title, 'Importare la doc');
});

test('parseTaskDetail legge i bullet header', () => {
  const detail = parseTaskDetail(
    'T01',
    ['# Task: Importare la doc', '', '- **ID**: T01', '- **Priority**: Med', '- **Parent Task**: T34', '- **Progress**: 🔵 Todo', '', '## Description', '', 'corpo'].join('\n'),
  );
  assert.equal(detail.fields['Priority'], 'Med');
  assert.equal(detail.fields['Progress'], sanitize('🔵 Todo'));
  assert.equal(detail.fields['Parent Task'], 'T34');
  assert.equal(detail.description, 'corpo');
});
