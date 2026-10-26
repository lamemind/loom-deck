import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DLV_REASON,
  dlvGate,
  parseDeliverables,
  preflightState,
  taskSize,
  type Deliverable,
} from '../src/deliverables.js';
import { sanitize } from '../src/width.js';
import { unixOnly } from './platform-gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Il cappello che contiene il deck come submodule: task file veri e sorgente
 *  del plugin, cioè le due metà del confronto. */
const PROJECT = dirname(dirname(HERE));
const TASKS_DIR = join(PROJECT, 'runtime', 'tasks');
const SCRIPT = join(PROJECT, 'loom-works-plugin', 'scripts', 'task', 'task-deliverables.sh');

const summary = (dlvs: readonly Deliverable[]) => dlvs.map((d) => `${d.n}:${d.done ? 'x' : ' '}`);

const TASK = `# Task: esempio

- **ID**: T1
- **Size**: M

## Acceptance Criteria

- [ ] un criterio, non un deliverable

## Deliverables Checklist
*Numerati posizionalmente — la riga in corsivo non è una voce.*

- [ ] primo
  - [ ] sotto-voce indentata: prosa del primo, non una voce
- [x] secondo, fatto
   continuazione indentata
- [X] terzo, fatto con la X maiuscola
-  [ ] due spazi dopo il trattino: non è una checkbox a colonna zero
* [ ] asterisco: non è la grammatica del template
### un sotto-heading non chiude la sezione
- [ ]    quarto, spazi in testa tolti

## Decisions

- [ ] fuori sezione di nuovo
`;

test('numera le sole checkbox a colonna zero della sezione, in ordine di file', () => {
  const dlvs = parseDeliverables(TASK);
  assert.deepEqual(summary(dlvs), ['1: ', '2:x', '3:x', '4: ']);
  assert.deepEqual(
    dlvs.map((d) => d.text),
    ['primo', 'secondo, fatto', 'terzo, fatto con la X maiuscola', 'quarto, spazi in testa tolti'],
  );
});

test('sezione assente, testo assente → nessun DLV', () => {
  assert.deepEqual(parseDeliverables('# Task\n\n## Description\n\n- [ ] non è un DLV\n'), []);
  assert.deepEqual(parseDeliverables(null), []);
  assert.deepEqual(parseDeliverables(''), []);
});

test('la sezione si riconosce per prefisso, come fa lo script', () => {
  const dlvs = parseDeliverables('## Deliverables Checklist (fase 2)\n- [ ] uno\n');
  assert.deepEqual(summary(dlvs), ['1: ']);
});

test('un fence non sospende il conteggio: lo script non lo vede, quindi nemmeno il deck', () => {
  // È una tolleranza dello script, non un'idea del deck. Una checkbox dentro un
  // fence sposta la numerazione per entrambi: correggerla da una parte sola
  // darebbe due numeri diversi per lo stesso DLV.
  const dlvs = parseDeliverables('## Deliverables Checklist\n```\n- [ ] nel fence\n```\n- [ ] dopo\n');
  assert.deepEqual(summary(dlvs), ['1: ', '2: ']);
});

test('CRLF: la numerazione non cambia', () => {
  const dlvs = parseDeliverables(TASK.replace(/\n/g, '\r\n'));
  assert.deepEqual(summary(dlvs), ['1: ', '2:x', '3:x', '4: ']);
});

// ── Gate di eseguibilità (run-task §3, D1/D2) ────────────────────────────────

/** Un task file minimo: header con la Size, DLV, e i blocchi `### Preflight`
 *  dati, nell'ordine dato, dentro `## Decisions`. */
function taskFile(size: string | null, dlvs: string[], preflights: string[] = []): string {
  return [
    '# Task: esempio',
    '',
    '- **ID**: T7',
    ...(size === null ? [] : [`- **Size**: ${size}`]),
    '',
    '## Deliverables Checklist',
    '',
    ...dlvs,
    '',
    '## Decisions',
    '',
    ...preflights.flatMap((h) => [`### Preflight ${h}`, '', '- nessuna ambiguità', '']),
    '## Implementation Notes',
    '',
    '### Preflight fuori da Decisions: non conta',
  ].join('\n');
}

const gate = (text: string, done = false) => dlvGate('T7', text, parseDeliverables(text), done);

test('Size L senza preflight → bloccata col motivo; con preflight → eseguibile', () => {
  assert.deepEqual(gate(taskFile('L', ['- [ ] uno'])), { kind: 'blocked', reason: DLV_REASON.sizeL });
  assert.deepEqual(gate(taskFile('L', ['- [ ] uno'], ['2026-10-26 11:56'])), { kind: 'ready' });
});

test('Size S, M e assente non chiedono il preflight', () => {
  for (const size of ['S', 'M', '', null]) {
    assert.deepEqual(gate(taskFile(size, ['- [ ] uno'])), { kind: 'ready' }, `Size ${size}`);
  }
  assert.equal(taskSize('T7', taskFile(null, [])), 'M');
  assert.equal(taskSize('T7', taskFile('', [])), 'M');
  assert.equal(taskSize('T7', taskFile('l (grande)', [])), 'L');
});

test('ultimo preflight con premessa decaduta → bloccata a ogni Size', () => {
  for (const size of ['S', 'M', 'L', 'Epic', null]) {
    const text = taskFile(size, ['- [ ] uno'], ['2026-10-20 10:00', '2026-10-26 11:56 — premessa decaduta']);
    assert.deepEqual(gate(text), { kind: 'blocked', reason: DLV_REASON.decayed }, `Size ${size}`);
  }
});

test('una premessa decaduta seguita da un preflight riuscito non blocca più', () => {
  const text = taskFile('L', ['- [ ] uno'], ['2026-10-20 10:00 — premessa decaduta', '2026-10-26 11:56']);
  assert.equal(preflightState(text), 'done');
  assert.deepEqual(gate(text), { kind: 'ready' });
});

test('un ### Preflight fuori da ## Decisions non conta come preflight', () => {
  // `taskFile` ne mette sempre uno sotto Implementation Notes.
  assert.equal(preflightState(taskFile('L', ['- [ ] uno'])), 'none');
});

test('Epic con DLV aperti: eseguibile come le altre (D2)', () => {
  assert.deepEqual(gate(taskFile('Epic', ['- [ ] uno'])), { kind: 'ready' });
});

test('disattivato: task chiusa, tutti i DLV fatti, nessun DLV', () => {
  assert.deepEqual(gate(taskFile('M', ['- [ ] uno']), true), { kind: 'off', reason: DLV_REASON.closed });
  assert.deepEqual(gate(taskFile('M', ['- [x] uno', '- [x] due'])), {
    kind: 'off',
    reason: DLV_REASON.allDone,
  });
  assert.deepEqual(gate(taskFile('M', [])), { kind: 'off', reason: DLV_REASON.empty });
  assert.deepEqual(dlvGate('T7', null, [], false), { kind: 'off', reason: DLV_REASON.empty });
});

test('su una task chiusa vince «chiusa», anche con una premessa decaduta o Size L', () => {
  const text = taskFile('L', ['- [ ] uno'], ['2026-10-26 11:56 — premessa decaduta']);
  assert.deepEqual(gate(text, true), { kind: 'off', reason: DLV_REASON.closed });
});

// ── Parità con lo script del plugin ──────────────────────────────────────────
//
// Il deck replica la regola invece di eseguire lo script (D6), quindi la parità
// non è garantita dalla fonte comune: la garantisce questo test, su OGNI task
// file del cappello. Il confronto è contro il SORGENTE del plugin nel submodule,
// cioè la versione che verrà pubblicata.
//
// Il deck legge il task file passato da `sanitize` (`loadTaskFileText`): la
// numerazione si confronta sul testo grezzo E su quello sanificato, perché è il
// secondo quello su cui il detail conta davvero.

const PARITY_SKIP =
  unixOnly('task-deliverables.sh è uno script bash') ||
  (existsSync(SCRIPT) ? false : `sorgente del plugin assente (${SCRIPT})`) ||
  (existsSync(TASKS_DIR) ? false : `task file del cappello assenti (${TASKS_DIR})`);

/**
 * Lo script su tutti i task file in UNA bash: uno spawn per file costerebbe
 * secondi alla suite. Ogni blocco è delimitato da `@@@`, con l'exit dello
 * script in coda.
 */
function scriptRuns(files: readonly string[]): Map<string, { exit: number; out: string }> {
  const loop = [
    'S="$1"; shift',
    'for f in "$@"; do',
    '  printf "@@@ %s\\n" "$f"',
    '  bash "$S" --docs-root runtime "${f%%-*}" 2>&1',
    '  printf "@@@ exit %d\\n" "$?"',
    'done',
  ].join('\n');
  const env = { ...process.env, PROJECT_ROOT: PROJECT };
  delete env.LOOM_TASK;
  const raw = execFileSync('bash', ['-c', loop, 'parity', SCRIPT, ...files], {
    cwd: PROJECT,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = new Map<string, { exit: number; out: string }>();
  for (const block of raw.split(/^@@@ (?=\S+\.md\n)/m).slice(1)) {
    const nl = block.indexOf('\n');
    const file = block.slice(0, nl);
    const body = block.slice(nl + 1);
    const m = /^@@@ exit (\d+)\n?$/m.exec(body);
    assert.ok(m, `${file}: blocco senza exit`);
    out.set(file, { exit: Number(m[1]), out: body.slice(0, m.index) });
  }
  return out;
}

/** L'attesa dello script per un file, nella stessa forma di `parseDeliverables`. */
function expected(file: string, run: { exit: number; out: string }): Deliverable[] {
  if (run.exit === 0) {
    return run.out
      .split('\n')
      .filter((l) => l.startsWith('DLV|'))
      .map((l) => {
        const [, n, state, , ...text] = l.split('|');
        return { n: Number(n), done: state === 'done', text: text.join('|') };
      });
  }
  // Exit 1 ha due forme lecite su un task file vero, ed entrambe dicono quanti
  // DLV ci sono: nessuno, oppure N tutti fatti. Lo script in quel caso non li
  // elenca, quindi l'ordine e il testo non si confrontano — il numero e lo stato sì.
  if (run.exit === 1 && /nessun deliverable in/.test(run.out)) return [];
  const all = /tutti e (\d+) sono gia/.exec(run.out);
  assert.ok(run.exit === 1 && all, `${file}: esito inatteso dello script (exit ${run.exit})\n${run.out}`);
  return Array.from({ length: Number(all[1]) }, (_, i) => ({ n: i + 1, done: true, text: '' }));
}

test('parità con task-deliverables.sh su ogni task file del cappello', { skip: PARITY_SKIP }, () => {
  const files = readdirSync(TASKS_DIR)
    .filter((f) => /^T\d+-.*\.md$/.test(f))
    .sort();
  assert.ok(files.length > 0, 'nessun task file da confrontare');
  const runs = scriptRuns(files);
  let withText = 0;
  for (const file of files) {
    const run = runs.get(file);
    assert.ok(run, `${file}: lo script non ha prodotto un blocco`);
    const want = expected(file, run);
    const raw = readFileSync(join(TASKS_DIR, file), 'utf8');
    for (const [label, text] of [['grezzo', raw], ['sanificato', sanitize(raw)]] as const) {
      const got = parseDeliverables(text);
      assert.deepEqual(summary(got), summary(want), `${file} (${label}): numero o stato dei DLV diversi`);
    }
    // Il testo si confronta solo dove lo script lo stampa, e sul grezzo: il
    // sanificato cambia di proposito i glifi.
    if (run.exit === 0) {
      assert.deepEqual(
        parseDeliverables(raw).map((d) => d.text),
        want.map((d) => d.text),
        `${file}: testo dei DLV diverso`,
      );
      withText += 1;
    }
  }
  // Un confronto che non ha mai visto un DLV aperto passerebbe anche su un
  // parser che restituisce sempre la lista vuota.
  assert.ok(withText > 0, 'nessun task file con DLV aperti: il confronto non ha misurato niente');
});
