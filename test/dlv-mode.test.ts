// T189 — il modo DLV del detail: cursore sui soli DLV aperti, selezione, e il
// prompt che `⏎` fa partire (D3/D4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DLV_IDLE_PROMPT, dlvPrompt, stepOpen, toggleIn } from '../src/overlays/dlv-mode.js';
import { parseDeliverables } from '../src/deliverables.js';
import { resolveSpawn } from '../src/spawn-config.js';
import { spawnAction } from '../src/spawn-catalog.js';
import type { CatalogEntry } from '../src/prompt-catalog.js';

const DLVS = parseDeliverables(
  ['## Deliverables Checklist', '- [x] uno', '- [ ] due', '- [x] tre', '- [ ] quattro', '- [ ] cinque'].join(
    '\n',
  ),
);

test('↑↓ saltano i DLV fatti e girano in tondo', () => {
  assert.equal(stepOpen(DLVS, 2, 1), 4);
  assert.equal(stepOpen(DLVS, 4, 1), 5);
  assert.equal(stepOpen(DLVS, 5, 1), 2);
  assert.equal(stepOpen(DLVS, 2, -1), 5);
  assert.equal(stepOpen(DLVS, 4, -1), 2);
});

test('il cursore parte dal primo DLV aperto; nessuno aperto → 0', () => {
  assert.equal(stepOpen(DLVS, 0, 1), 2);
  // Un numero che non è (più) un DLV aperto riporta sul primo, invece di
  // lasciare il cursore su una riga non selezionabile.
  assert.equal(stepOpen(DLVS, 3, 1), 2);
  assert.equal(stepOpen(parseDeliverables('## Deliverables Checklist\n- [x] uno\n'), 0, 1), 0);
  assert.equal(stepOpen([], 0, 1), 0);
});

test('spazio mette e toglie la selezione', () => {
  const one = toggleIn(new Set(), 4);
  assert.deepEqual([...one], [4]);
  const two = toggleIn(one, 2);
  assert.deepEqual([...two].sort(), [2, 4]);
  assert.deepEqual([...toggleIn(two, 4)], [2]);
  // L'insieme di partenza non si tocca: è stato React.
  assert.deepEqual([...one], [4]);
});

const CATALOG = new Map<string, CatalogEntry>([
  ['run', { template: '/loom-works:run-task {TASK}', model: 'opus' }],
]);
const HOLES = { TASK: 'T189', slug: 'deck dlv selezionabili detail' };

test('D3 — con una selezione: il prompt di run risolto, DLV e perimetro crescente in coda', () => {
  const run = resolveSpawn(spawnAction('run')!, new Map(), CATALOG, HOLES);
  assert.equal(dlvPrompt(run.prompt, new Set([4, 2])), '/loom-works:run-task T189 DLV 2,4');
  assert.equal(dlvPrompt(run.prompt, [3]), '/loom-works:run-task T189 DLV 3');
});

test('D3 — l’override di progetto sul prompt di run vale anche qui', () => {
  const ov = new Map([['run' as const, { prompt: '/loom-works:run-task {TASK} yolo' }]]);
  const run = resolveSpawn(spawnAction('run')!, ov, CATALOG, HOLES);
  assert.equal(dlvPrompt(run.prompt, [5, 1]), '/loom-works:run-task T189 yolo DLV 1,5');
});

test('D4 — senza selezione: cosa fare ora [R0], qualunque sia il prompt di run', () => {
  assert.equal(DLV_IDLE_PROMPT, 'cosa fare ora [R0]');
  assert.equal(dlvPrompt('/loom-works:run-task T189', []), DLV_IDLE_PROMPT);
  assert.equal(dlvPrompt(null, new Set()), DLV_IDLE_PROMPT);
});
