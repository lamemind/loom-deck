import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTasks,
  parseTaskDetail,
  headerColumns,
  parseMandateMembers,
  taskEpicOf,
  taskIsEpic,
  taskIsMandate,
  taskIsPerimeter,
} from '../src/tasks.js';
import { sanitize } from '../src/width.js';
import { unixOnly } from './platform-gates.js';

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

// T172 — caso reale: `checkpoint-task` chiude T08 e toglie il 🔒 dalle righe
// cross-deps di T07 e T09. Da lì `| T07 | — | ✔️T08 |` ha la forma di una riga
// task, e senza confine il deck la leggeva come una seconda T07 (Pri `—`,
// Prog `✔️T08`) → key React duplicata in TasksPane.
const OVERVIEW_T01_T11 = `# Tasks

## Tasks Overview

| ID  | Pri | Prog | Task (max 64)          |
| --- | --- | ---- | ---------------------- |
| T01 | 🔥 | ✔️ | Uno                    |
| T02 | 🔥 | ✔️ | Due                    |
| T03 | 🔥 | 🔵 | Tre                    |
| T04 | ⚡ | 🔵 | Quattro                |
| T05 | ⚡ | 🔵 | Cinque                 |
| T06 | ⚡ | 🔵 | Sei                    |
| T07 | ⚡ | 🟢 | Sette                  |
| T08 | ⚡ | ✔️ | Otto                   |
| T09 | 🔹 | 🔵 | Nove                   |
| T10 | 🔹 | 🔵 | Dieci                  |
| T11 | 🔥 | 🟡 | Undici (epica)         |
`;

const EXECUTION_PLAN_SBLOCCATO = `## Execution Plan

\`\`\`
Legend: ✔️ Done  🟡 In Progress  🔒 Locked

Epica T11 (archetipi), spot su main:   ✔️T08 · T04 · T05 · T06 → T07 · T09 → 🔒T03

Cross-deps:
| Task  | Parent | Cross Deps                   |
| ----- | ------ | ---------------------------- |
| T07   | —      | ✔️T08                        |
| T09   | —      | ✔️T08                        |
| 🔒T03 | —      | T04, T05, T06, T07, ✔️T08, T09 |
\`\`\`
`;

test('parseTasks: le righe cross-deps sbloccate non diventano task', () => {
  const conPlan = parseTasks(`${OVERVIEW_T01_T11}\n${EXECUTION_PLAN_SBLOCCATO}`);
  // stesso elenco del file senza Execution Plan
  assert.deepEqual(conPlan, parseTasks(OVERVIEW_T01_T11));
  const ids = conPlan.map((t) => t.id);
  assert.equal(ids.length, 11);
  assert.equal(new Set(ids).size, ids.length, 'nessun id duplicato');
  // Pri e Prog vengono dalla Tasks Overview, non dalle celle Parent/Cross Deps
  const t07 = conPlan.find((t) => t.id === 'T07');
  const t09 = conPlan.find((t) => t.id === 'T09');
  assert.equal(t07?.pri, '⚡');
  assert.equal(t07?.prog, '🟢');
  assert.equal(t09?.pri, '🔹');
  assert.equal(t09?.prog, '🔵');
});

test('parseTasks: la riga cross-deps col 🔒 resta ignorata', () => {
  const ids = parseTasks(`${OVERVIEW_T01_T11}\n${EXECUTION_PLAN_SBLOCCATO}`).map((t) => t.id);
  assert.equal(ids.filter((id) => id === 'T03').length, 1);
});

test('parseTasks: la tabella chiude alla prima riga che non inizia con `|`', () => {
  const md = [
    '| ID | Pri | Prog | Task |',
    '| -- | --- | ---- | ---- |',
    '| T01 | 🔥 | 🔵 | dentro |',
    '',
    '| T02 | 🔥 | 🔵 | fuori, dopo la riga vuota |',
  ].join('\n');
  assert.deepEqual(parseTasks(md).map((t) => t.id), ['T01']);
});

test('parseTasks: un secondo header riapre una tabella con le sue colonne', () => {
  const md = [
    '| ID | Pri | Prog | Task |',
    '| T01 | 🔥 | 🔵 | prima |',
    '',
    'testo in mezzo',
    '',
    '| ID | Pri | K | Prog | Task |',
    '| T02 | ⚡ | 📝 | 🟡 | seconda |',
  ].join('\n');
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => t.id), ['T01', 'T02']);
  assert.equal(tasks[1].prog, '🟡');
  assert.equal(tasks[1].desc, 'seconda');
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
const EPIC_MD = `# Task: Asfaltamento del sistema documentale

- **ID**: T74
- **Size**: Epic
- **Progress**: 🟡 In Progress

## Description
Cappello.
`;

test('taskIsEpic: `Size: Epic` marca il cappello', () => {
  assert.equal(taskIsEpic('T74', EPIC_MD), true);
  assert.equal(taskIsEpic('T74', EPIC_MD.replace('Epic', 'L')), false);
  // Il valore lo scrive un umano nel file: il confronto non può essere sensibile
  // alla cassa, o `epic` in minuscolo aprirebbe la sotto-skill sbagliata.
  assert.equal(taskIsEpic('T74', EPIC_MD.replace('Epic', 'epic')), true);
  assert.equal(taskIsEpic('T74', EPIC_MD.replace('Epic', 'EPIC')), true);
});

test('taskIsEpic: senza testo o senza campo Size degrada a non-cappello', () => {
  // `null` = task file non ancora letto. La mancanza di prova non è prova di
  // cappello, e il caso comune (task normale) è l'esito benigno su cui cadere.
  assert.equal(taskIsEpic('T74', null), false);
  assert.equal(taskIsEpic('T74', ''), false);
  assert.equal(taskIsEpic('T99', '# Task: Senza size\n\n- **ID**: T99\n'), false);
});

test('taskIsEpic: legge il Size dell’HEADER, non un’occorrenza nel corpo', () => {
  // First-match-wins di parseTaskDetail: una riga `- **Size**: Epic` citata
  // dentro la Description (es. la task che DOCUMENTA il marker) non deve
  // trasformare quella task in un cappello.
  const citante = `# Task: Contratto epica

- **ID**: T113
- **Size**: M

## Description
Il marker si scrive cosi:
- **Size**: Epic
`;
  assert.equal(taskIsEpic('T113', citante), false);
});

// ── T67 · taskEpicOf ─────────────────────────────────────────────────────

test('taskEpicOf: T142 (maniglia) → primo token, la maniglia si ignora', () => {
  const md = '# Task: Figlia\n\n- **ID**: T99\n- **Parent Task**: T142 (epica sistema documentale)\n';
  assert.equal(taskEpicOf('T99', md), 'T142');
});

test('taskEpicOf: campo assente o vuoto → nessun cappello', () => {
  assert.equal(taskEpicOf('T99', '# Task: Senza parent\n\n- **ID**: T99\n'), null);
  assert.equal(taskEpicOf('T99', '# Task: Vuoto\n\n- **ID**: T99\n- **Parent Task**: \n'), null);
  assert.equal(taskEpicOf('T99', null), null);
});

test('taskEpicOf: le cifre del token sono greedy — T74 non si legge T7', () => {
  const md = '# Task: Figlia\n\n- **ID**: T7\n- **Parent Task**: T74\n';
  assert.equal(taskEpicOf('T7', md), 'T74');
});

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

// ── T212 · il mandato ────────────────────────────────────────────────────────

const MANDATE_MD = `# Task: Mandato: convention e regia insieme

- **ID**: T230
- **Size**: Mandate
- **Parent Task**:
- **Progress**: 🔵 Todo

## Description

Un perimetro che nomina \`Size: Epic\` in prosa senza esserlo.

## Membri

- T52 (lettore unico delle convention)
- **T61** — gate del deck sulle convention
- \`T64\` regia headless
  - T70 riga indentata: prosa della voce sopra
- nessun id su questa riga
Testo fuori dalla lista con T71 dentro.

### Secondo gruppo

- T52 ripetuto: conta alla prima riga
- T230 il mandato che elenca sé stesso
- XT72 coda di una parola, poi T73 vero

\`\`\`
- T74 dentro un blocco di codice
## nemmeno questo chiude, è dentro il blocco
\`\`\`

- T75 dopo il blocco

## Preferenze d'ordine

- T76 fuori dalla sezione
`;

test('taskIsMandate: la prima parola di `Size` decide, in qualunque maiuscola', () => {
  assert.equal(taskIsMandate('T230', MANDATE_MD), true);
  assert.equal(taskIsMandate('T230', MANDATE_MD.replace('Mandate', 'mandate')), true);
  // La grammatica di `lw_task_members`: una coda dopo la parola non conta.
  assert.equal(taskIsMandate('T230', MANDATE_MD.replace('Mandate', 'Mandate (perimetro)')), true);
  assert.equal(taskIsMandate('T230', MANDATE_MD.replace('Mandate', 'Epic')), false);
  assert.equal(taskIsMandate('T230', MANDATE_MD.replace('Mandate', 'Mandatory')), false);
  assert.equal(taskIsMandate('T230', null), false);
  assert.equal(taskIsMandate('T99', '# Task: Senza size\n\n- **ID**: T99\n'), false);
});

test('taskIsMandate: un mandato non è un cappello, e un cappello non è un mandato', () => {
  assert.equal(taskIsEpic('T230', MANDATE_MD), false);
  assert.equal(taskIsMandate('T74', EPIC_MD), false);
});

test('taskIsPerimeter: vero su epica e mandato, falso su una task qualunque', () => {
  assert.equal(taskIsPerimeter('T230', MANDATE_MD), true);
  assert.equal(taskIsPerimeter('T74', EPIC_MD), true);
  assert.equal(taskIsPerimeter('T74', EPIC_MD.replace('Epic', 'M')), false);
  assert.equal(taskIsPerimeter('T74', null), false);
});

test('parseMandateMembers: i casi del contratto di mandate-format.md', () => {
  assert.deepEqual(parseMandateMembers('T230', MANDATE_MD), ['T52', 'T61', 'T64', 'T73', 'T75']);
});

test('parseMandateMembers: senza sezione o senza testo nessun membro', () => {
  assert.deepEqual(parseMandateMembers('T74', EPIC_MD), []);
  assert.deepEqual(parseMandateMembers('T230', null), []);
  assert.deepEqual(parseMandateMembers('T230', '# Task: x\n\n## Membri\n\n## Altro\n- T1\n'), []);
});

test('parseMandateMembers: un file con fine riga CRLF legge gli stessi membri', () => {
  assert.deepEqual(
    parseMandateMembers('T230', MANDATE_MD.replace(/\n/g, '\r\n')),
    ['T52', 'T61', 'T64', 'T73', 'T75'],
  );
});

test('parseMandateMembers: le cifre sono greedy — T64 non si legge T6', () => {
  assert.deepEqual(parseMandateMembers('T1', '## Membri\n\n- T64x\n- T6\n'), ['T64', 'T6']);
});

// Il deck replica la grammatica di `## Membri` invece di lanciare lo script (P2
// preflight T212): la parità la tiene questo test, contro il SORGENTE del
// plugin nel submodule — la versione che verrà pubblicata.
const PLUGIN_LIB = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'loom-works-plugin',
  'scripts',
  'utils',
  'lib.sh',
);
const MEMBERS_PARITY_SKIP =
  unixOnly('lw_task_members è una funzione bash') ||
  (existsSync(PLUGIN_LIB) ? false : `sorgente del plugin assente (${PLUGIN_LIB})`);

test('parità con lw_task_members del plugin sui casi del contratto', { skip: MEMBERS_PARITY_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-members-'));
  try {
    const dir = join(root, 'docs', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'T230-mandato.md'), MANDATE_MD);
    // Due membri senza task file: il lettore li marca MISSING, nello stesso
    // ordine degli altri — il deck li tiene nella lista allo stesso posto.
    for (const id of ['T52', 'T61', 'T73']) writeFileSync(join(dir, `${id}-membro.md`), `# Task: ${id}\n`);
    const env = { ...process.env, PROJECT_ROOT: root };
    delete env.LOOM_TASK;
    const out = execFileSync('bash', ['-c', 'source "$1" && lw_task_members T230', 'parity', PLUGIN_LIB], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    const fromScript = out
      .split('\n')
      .map((l) => /^TASK_MEMBER(?:_MISSING)?=(T\d+)/.exec(l)?.[1])
      .filter((id): id is string => Boolean(id));
    assert.match(out, /^TASK_MEMBERS_SRC=list$/m);
    assert.deepEqual(parseMandateMembers('T230', MANDATE_MD), fromScript);
    assert.deepEqual(parseMandateMembers('T230', sanitize(MANDATE_MD)), fromScript);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
