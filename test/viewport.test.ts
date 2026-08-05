import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutBudget,
  windowRange,
  MODAL_HEIGHT,
  SLACK,
  type BudgetInput,
  type Mode,
  type PreviewKind,
} from '../src/viewport.js';
import { wrapLines } from '../src/width.js';

const input = (over: Partial<BudgetInput> = {}): BudgetInput => ({
  rows: 40,
  mode: 'normal',
  launchLine: false,
  noteLine: false,
  preview: 'none',
  detailMetaLines: 0,
  sessionHasFirstPreview: false,
  sessionHasLastPreview: false,
  ...over,
});

/**
 * Ricostruisce l'altezza del frame dal budget, con la stessa aritmetica del
 * componente: è QUESTA la proprietà che tiene chiuso il bug (frame < rows),
 * non i singoli numeri.
 *
 * T70 — il blocco preview non sta più DENTRO una colonna: è una riga di frame a
 * sé, sotto il `max` delle due, quindi si somma invece di competere.
 */
const frameHeight = (i: BudgetInput, b: ReturnType<typeof layoutBudget>) => {
  if (b.compact) return 1; // riga singola, nessun box
  const outer =
    2 + 1 + 1 + (i.launchLine ? 1 : 0) + MODAL_HEIGHT[i.mode] + 1 + (i.noteLine ? 1 : 0);
  // T59 — 6 di chrome: 2 bordi + header + riga sort + le DUE righe meta
  // (`≡ tutte`, `○ spot`).
  const tasksCol = 6 + b.taskRows;
  const sessionsCol = 3 + b.sessionRows;
  // Blocco preview: 3 chrome (marginTop + 2 bordi) + le righe fisse del suo
  // contenuto (task: titolo/meta/commit · sessione: titolo + meta) + le
  // variabili.
  const preview = !b.preview
    ? 0
    : i.preview === 'task'
      ? 3 + i.detailMetaLines + b.detailLines
      : 3 + 2 + b.sessionFirstLines + b.sessionLastLines;
  return outer + Math.max(tasksCol, sessionsCol) + preview;
};

test('layoutBudget: il frame resta sotto stdout.rows su ogni combinazione', () => {
  const modes: Mode[] = ['normal', 'create', 'sort', 'filter', 'edit'];
  const kinds: PreviewKind[] = ['none', 'task', 'session'];
  for (let rows = 8; rows <= 80; rows++) {
    for (const mode of modes) {
      for (const launchLine of [false, true]) {
        for (const noteLine of [false, true]) {
          for (const preview of kinds) {
            for (const previews of [
              [false, false],
              [true, false],
              [false, true],
              [true, true],
            ] as const) {
              for (const detailMetaLines of [1, 2, 3]) {
                const i = input({
                  rows,
                  mode,
                  launchLine,
                  noteLine,
                  preview,
                  detailMetaLines,
                  sessionHasFirstPreview: preview === 'session' && previews[0],
                  sessionHasLastPreview: preview === 'session' && previews[1],
                });
                const h = frameHeight(i, layoutBudget(i));
                // Condizione di Ink: `outputHeight >= rows` → ramo clearTerminal.
                assert.ok(
                  h <= rows - SLACK,
                  `frame ${h} > ${rows - SLACK} (rows=${rows} mode=${mode} preview=${preview} anteprime=${previews})`,
                );
              }
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

test('layoutBudget: terminale alto → lista task ampia, preview al suo tetto', () => {
  const b = layoutBudget(input({ rows: 60, preview: 'task', detailMetaLines: 2 }));
  assert.equal(b.detailLines, 6);
  assert.ok(b.taskRows >= 30);
});

test('layoutBudget: terminale basso → sacrifica la preview, non la lista', () => {
  const b = layoutBudget(input({ rows: 16, preview: 'task', detailMetaLines: 2 }));
  assert.equal(b.preview, false);
  assert.equal(b.detailLines, 0);
  assert.ok(b.taskRows >= 3);
});

// T70 — il costo del blocco lo pagano ENTRAMBE le colonne, perché sta sotto di
// esse e non dentro una. Con i due pannelli separati quello del pane sessioni
// era di fatto gratis (la colonna più corta non decideva l'altezza del frame).
test('layoutBudget: la preview scala righe da entrambe le liste, non da una sola', () => {
  const base = layoutBudget(input({ rows: 60 }));
  for (const kind of ['task', 'session'] as const) {
    const b = layoutBudget(
      input({
        rows: 60,
        preview: kind,
        detailMetaLines: 2,
        sessionHasFirstPreview: true,
        sessionHasLastPreview: true,
      }),
    );
    assert.equal(b.preview, true);
    const cut = base.taskRows - b.taskRows;
    assert.ok(cut > 0, `${kind}: la lista task non ha pagato nulla`);
    assert.equal(base.sessionRows - b.sessionRows, cut, `${kind}: costo non condiviso`);
  }
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

test('layoutBudget: preview sessione su terminale alto → entrambe le anteprime piene, liste ridotte del costo', () => {
  const base = layoutBudget(input({ rows: 60 }));
  const b = layoutBudget(
    input({ rows: 60, preview: 'session', sessionHasFirstPreview: true, sessionHasLastPreview: true }),
  );
  assert.equal(b.preview, true);
  assert.equal(b.sessionFirstLines, 3);
  assert.equal(b.sessionLastLines, 3);
  // Costo intero del blocco: 3 chrome + 2 fisse + 3 first + 3 last.
  assert.equal(base.sessionRows - b.sessionRows, 11);
});

test('layoutBudget: solo ultima risposta (nessun titolo custom) → riservate solo le sue righe', () => {
  const b = layoutBudget(input({ rows: 60, preview: 'session', sessionHasLastPreview: true }));
  assert.equal(b.sessionFirstLines, 0);
  assert.equal(b.sessionLastLines, 3);
});

test('layoutBudget: primo prompt ha priorità sull\'ultima risposta quando lo spazio è poco', () => {
  // spare = 1: basta per 1 riga di anteprima, va al primo prompt, l'ultima resta a 0.
  let found = false;
  for (let rows = 8; rows <= 80; rows++) {
    const b = layoutBudget(
      input({ rows, preview: 'session', sessionHasFirstPreview: true, sessionHasLastPreview: true }),
    );
    if (b.preview && b.sessionFirstLines === 1) {
      assert.equal(b.sessionLastLines, 0, `rows=${rows}: con 1 sola riga vince il primo prompt`);
      found = true;
    }
  }
  assert.ok(found, 'nessun rows produce esattamente 1 riga di anteprima — copertura mancante');
});

test('layoutBudget: preview sessione sacrificata prima delle liste', () => {
  const b = layoutBudget(
    input({ rows: 14, preview: 'session', sessionHasFirstPreview: true, sessionHasLastPreview: true }),
  );
  const bare = layoutBudget(input({ rows: 14 }));
  assert.equal(b.compact, false);
  assert.equal(b.preview, false);
  // Rinunciata la preview, le liste tornano ESATTAMENTE quelle di un frame che
  // non la chiedeva: un blocco negato non deve lasciare righe riservate dietro.
  assert.equal(b.taskRows, bare.taskRows);
  assert.equal(b.sessionRows, bare.sessionRows);
});

test('layoutBudget: preview concessa → nessuna delle due liste sotto il minimo', () => {
  for (let rows = 8; rows <= 80; rows++) {
    for (const kind of ['task', 'session'] as const) {
      const b = layoutBudget(
        input({
          rows,
          preview: kind,
          detailMetaLines: 3,
          sessionHasFirstPreview: true,
          sessionHasLastPreview: true,
        }),
      );
      if (!b.preview) continue;
      assert.ok(b.taskRows >= 3, `rows=${rows} ${kind} → lista task sotto il minimo`);
      assert.ok(b.sessionRows >= 3, `rows=${rows} ${kind} → lista sessioni sotto il minimo`);
    }
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
