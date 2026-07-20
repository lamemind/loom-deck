import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutBudget,
  windowRange,
  wrapLines,
  MODAL_HEIGHT,
  SLACK,
  type BudgetInput,
  type Mode,
} from '../src/viewport.js';

const input = (over: Partial<BudgetInput> = {}): BudgetInput => ({
  rows: 40,
  mode: 'normal',
  launchLine: false,
  noteLine: false,
  hasDetail: false,
  detailMetaLines: 0,
  ...over,
});

/**
 * Ricostruisce l'altezza del frame dal budget, con la stessa aritmetica del
 * componente: è QUESTA la proprietà che tiene chiuso il bug (frame < rows),
 * non i singoli numeri.
 */
const frameHeight = (i: BudgetInput, b: ReturnType<typeof layoutBudget>) => {
  if (b.compact) return 1; // riga singola, nessun box
  const outer =
    2 + 1 + 1 + (i.launchLine ? 1 : 0) + MODAL_HEIGHT[i.mode] + 1 + (i.noteLine ? 1 : 0);
  const tasksCol =
    5 + b.taskRows + (b.detailLines > 0 ? 3 + i.detailMetaLines + b.detailLines : 0);
  const sessionsCol = 3 + b.sessionRows;
  return outer + Math.max(tasksCol, sessionsCol);
};

test('layoutBudget: il frame resta sotto stdout.rows su ogni combinazione', () => {
  const modes: Mode[] = ['normal', 'create', 'sort', 'filter', 'edit'];
  for (let rows = 8; rows <= 80; rows++) {
    for (const mode of modes) {
      for (const launchLine of [false, true]) {
        for (const noteLine of [false, true]) {
          for (const hasDetail of [false, true]) {
            for (const detailMetaLines of [1, 2, 3]) {
              const i = input({ rows, mode, launchLine, noteLine, hasDetail, detailMetaLines });
              const h = frameHeight(i, layoutBudget(i));
              // Condizione di Ink: `outputHeight >= rows` → ramo clearTerminal.
              assert.ok(
                h <= rows - SLACK,
                `frame ${h} > ${rows - SLACK} (rows=${rows} mode=${mode} detail=${hasDetail})`,
              );
            }
          }
        }
      }
    }
  }
});

test('layoutBudget: rows mancante (non-TTY / pre-SIGWINCH) degrada a 24', () => {
  const b = layoutBudget(input({ rows: 0 }));
  assert.ok(b.taskRows > 0);
  assert.ok(frameHeight(input({ rows: 24 }), b) <= 24 - SLACK);
});

test('layoutBudget: terminale alto → lista task ampia, dettaglio al suo tetto', () => {
  const b = layoutBudget(input({ rows: 60, hasDetail: true, detailMetaLines: 2 }));
  assert.equal(b.detailLines, 4);
  assert.ok(b.taskRows >= 30);
});

test('layoutBudget: terminale basso → sacrifica il dettaglio, non la lista', () => {
  const b = layoutBudget(input({ rows: 16, hasDetail: true, detailMetaLines: 2 }));
  assert.equal(b.detailLines, 0);
  assert.ok(b.taskRows >= 3);
});

test('layoutBudget: terminale ridicolo → compact, mai un frame che sfora', () => {
  const b = layoutBudget(input({ rows: 8 }));
  assert.equal(b.compact, true);
  assert.equal(b.taskRows, 0);
});

test('layoutBudget: un pane non-compact mostra sempre almeno una task', () => {
  for (let rows = 8; rows <= 80; rows++) {
    const b = layoutBudget(input({ rows, launchLine: true }));
    if (!b.compact) assert.ok(b.taskRows >= 1, `rows=${rows} → pane vuoto`);
  }
});

test('layoutBudget: modale su terminale medio-basso → compact anziché sforare', () => {
  // La cornice della modale edit (8 righe) da sola non lascia spazio ai pane.
  assert.equal(layoutBudget(input({ rows: 18, mode: 'edit' })).compact, true);
  assert.equal(layoutBudget(input({ rows: 30, mode: 'edit' })).compact, false);
});

test('layoutBudget: la modale edit scala righe dai pane', () => {
  const base = layoutBudget(input({ rows: 40, mode: 'normal' }));
  const edit = layoutBudget(input({ rows: 40, mode: 'edit' }));
  assert.equal(base.taskRows - edit.taskRows, MODAL_HEIGHT.edit);
});

test('windowRange: lista che ci sta → nessuna finestra', () => {
  assert.deepEqual(windowRange(5, 2, 10), { start: 0, end: 5 });
});

test('windowRange: centra la selezione e clampa ai bordi', () => {
  assert.deepEqual(windowRange(30, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(windowRange(30, 15, 10), { start: 10, end: 20 });
  assert.deepEqual(windowRange(30, 29, 10), { start: 20, end: 30 });
});

test('windowRange: la selezione è sempre dentro la finestra', () => {
  for (let sel = 0; sel < 40; sel++) {
    const { start, end } = windowRange(40, sel, 7);
    assert.ok(sel >= start && sel < end, `sel ${sel} fuori da [${start},${end})`);
    assert.equal(end - start, 7);
  }
});

test('windowRange: capienza 0 o lista vuota → finestra vuota', () => {
  assert.deepEqual(windowRange(10, 3, 0), { start: 0, end: 0 });
  assert.deepEqual(windowRange(0, 0, 5), { start: 0, end: 0 });
});

test('wrapLines: rispetta larghezza e tetto righe', () => {
  const text = 'alfa beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const lines = wrapLines(text, 20, 3);
  assert.ok(lines.length <= 3);
  for (const l of lines) assert.ok(l.length <= 20, `riga lunga ${l.length}: ${l}`);
});

test('wrapLines: troncamento non silenzioso → ellissi', () => {
  const lines = wrapLines('alfa beta gamma delta epsilon zeta eta theta', 10, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.endsWith('…'));
});

test('wrapLines: testo corto → nessuna ellissi', () => {
  assert.deepEqual(wrapLines('alfa beta', 40, 3), ['alfa beta']);
});

test('wrapLines: parola più lunga della riga viene spezzata, non lasciata a capo', () => {
  const lines = wrapLines('x'.repeat(50), 10, 3);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(l.length <= 10);
});

test('wrapLines: newline e spazi multipli collassano', () => {
  assert.deepEqual(wrapLines('alfa\n\n  beta\tgamma', 40, 2), ['alfa beta gamma']);
});

test('wrapLines: input vuoto o tetto zero → nessuna riga', () => {
  assert.deepEqual(wrapLines('', 20, 3), []);
  assert.deepEqual(wrapLines('   \n ', 20, 3), []);
  assert.deepEqual(wrapLines('alfa', 20, 0), []);
});
