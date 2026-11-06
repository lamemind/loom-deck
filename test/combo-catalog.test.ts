// T194 — il catalogo del modale delle combo: le tre liste e le righe che le
// dispongono. Sotto pty il modale vero lo misurano `modes-smoke.test.ts` e
// `frame-width.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  comboLines,
  comboRows,
  deckLegend,
  hintLegend,
  type ComboLine,
  type DeckLegend,
} from '../src/combo-catalog.js';
import { TASK_MODE_LEGEND } from '../src/input-modes.js';
import { termWidth } from '../src/width.js';

const taskBase = { purgeBulk: false, docMode: false, gitlink: false, restore: false, launchDigits: [] as string[] };
const fullBase = { ...taskBase, gitlink: true, restore: true, launchDigits: ['1', '2', '3'] };
const docBase = { ...fullBase, docMode: true };

const allVoices = (legend: DeckLegend) => [
  ...legend.general.voices,
  ...legend.left.voices,
  ...legend.right.voices,
];
const lineText = (line: ComboLine) => line.map((span) => span.text).join('');

// ── deckLegend: le tre liste ─────────────────────────────────────────────────

test('deckLegend: task a sinistra, conversazioni a destra', () => {
  const { left, right } = deckLegend(taskBase);
  assert.equal(left.title, 'task');
  assert.deepEqual(left.voices, [
    '⏎ detail',
    '^K/^P/^R spawn',
    'CANC elimina',
    ...TASK_MODE_LEGEND,
  ]);
  assert.equal(right.title, 'conversazioni');
  assert.deepEqual(right.voices, [
    '⏎ resume',
    'f fork',
    'm modello',
    'CANC elimina',
    'p pin',
    'a priorità',
    'N titolo',
    'A assegna',
  ]);
});

test('deckLegend: le azioni finora mai annunciate stanno fra le generali', () => {
  const { general } = deckLegend(taskBase);
  for (const voce of ['tab vista', '←→ pane', '^W lista hard-wrap', '^E scan hard-wrap', 't terminale', 'c claude']) {
    assert.ok(general.voices.includes(voce), `voce assente: ${voce}`);
  }
});

test('deckLegend: CANC nomina il bersaglio, e il bulk delle task non tocca le conversazioni', () => {
  // Il bulk vale sul solo pane task: una voce «elimina tutte» sulle conversazioni
  // prometterebbe una strage che non parte.
  const bulk = deckLegend({ ...taskBase, purgeBulk: true });
  assert.ok(bulk.left.voices.includes('CANC elimina tutte'), `bulk non annunciato: ${bulk.left.voices}`);
  assert.ok(!bulk.left.voices.includes('CANC elimina'));
  assert.ok(bulk.right.voices.includes('CANC elimina'));
  assert.ok(!bulk.right.voices.includes('CANC elimina tutte'));
});

test('deckLegend: `^U` solo con submodule, `^T` solo col bottone a schermo e in testa', () => {
  const plain = deckLegend(taskBase).general.voices.join(' · ');
  assert.ok(!plain.includes('^U'), plain);
  assert.ok(!plain.includes('^T'), plain);
  const full = deckLegend(fullBase).general.voices;
  assert.ok(full.includes('^U bumpa gitlink'));
  assert.equal(full[0], '^T restore');
});

test('deckLegend: le cifre coprono le voci launch in riga, pinnate comprese', () => {
  // T168 — la voce delle cifre si ricava da `launchDigitsOf`: un prefisso
  // contiguo è un intervallo, le cifre sparse (key pinnate) si elencano, e la
  // pagina `^L` è annunciata sempre.
  const voices = (launchDigits: string[]) =>
    deckLegend({ ...taskBase, launchDigits }).general.voices.filter((v) => v.includes('launch'));
  assert.deepEqual(voices([]), ['^L launch']);
  assert.deepEqual(voices(['1']), ['^L launch', '1 voce launch']);
  assert.deepEqual(voices(['1', '2', '3']), ['^L launch', '1-3 voci launch']);
  assert.deepEqual(voices(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']), ['^L launch', '1-9,0 voci launch']);
  assert.deepEqual(voices(['2', '7']), ['^L launch', '2,7 voci launch']);
});

test('deckLegend: in modo doc le colonne seguono i pane, e nessun tasto inerte resta annunciato', () => {
  // Un tasto inerte che resta in legenda descrive un deck che non esiste.
  const legend = deckLegend(docBase);
  assert.equal(legend.left.title, 'albero doc');
  assert.equal(legend.right.title, 'coda inbox');
  assert.deepEqual(legend.left.voices, ['⏎ apri']);
  assert.deepEqual(legend.right.voices, ['⏎ apri']);
  const text = allVoices(legend).join(' · ');
  for (const voce of TASK_MODE_LEGEND) {
    assert.ok(!text.includes(voce), `voce del mondo task annunciata in modo doc: ${voce}`);
  }
  for (const key of ['CANC', '^K', 'f fork', 'p pin']) {
    assert.ok(!text.includes(key), `${key} annunciato in modo doc: ${text}`);
  }
  // `^B` nomina il modo che monta: da qui riporta alle task.
  assert.ok(text.includes('^B task'), `la via di ritorno non è annunciata: ${text}`);
  assert.ok(deckLegend(taskBase).general.voices.includes('^B doc'));
});

test('deckLegend: una voce per elemento, nessun separatore dentro una voce', () => {
  for (const state of [taskBase, fullBase, docBase]) {
    for (const voce of allVoices(deckLegend(state))) {
      assert.ok(!voce.includes(' · '), `due voci fuse in una: ${voce}`);
    }
  }
});

// ── il custode: il catalogo contro i rami di `onKey` ─────────────────────────
//
// Le azioni generali non possono venire da un dato condiviso col dispatch, che è
// una catena di rami. Il confronto col sorgente è ciò che le tiene allineate: un
// ramo nuovo senza voce, o una voce senza ramo, fa fallire questo test.

test('deckLegend: ogni tasto del dispatch ha la sua voce, e ogni voce il suo ramo', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', 'src', 'input.ts'), 'utf8');
  const ctrlAt = source.indexOf('    if (key.ctrl) {\n');
  const tabAt = source.indexOf('    if (key.tab) {\n', ctrlAt);
  assert.ok(ctrlAt > 0 && tabAt > ctrlAt, 'il ramo ctrl di onKey non si trova più');
  const branches = (text: string) => [...text.matchAll(/input === '(.)'/g)].map((m) => m[1]!);
  const dispatchedCtrl = new Set(branches(source.slice(ctrlAt, tabAt)));
  // `H` apre il modale stesso: la sua voce sta in riga due (`hintLegend`).
  const dispatchedPlain = new Set(branches(source.slice(tabAt)).filter((key) => key !== 'H'));

  const announced = comboRows(allVoices(deckLegend(fullBase))).flatMap((row) => row.key.split('/'));
  const announcedCtrl = new Set(
    announced.filter((key) => key.startsWith('^')).map((key) => key.slice(1).toLowerCase()),
  );
  const announcedPlain = new Set(announced.filter((key) => /^[A-Za-z]$/.test(key)));

  assert.deepEqual([...announcedCtrl].sort(), [...dispatchedCtrl].sort());
  assert.deepEqual([...announcedPlain].sort(), [...dispatchedPlain].sort());

  // I tasti speciali, che nel dispatch non passano da `input ===`.
  const special: Array<[string, string]> = [
    ['tab', 'key.tab'],
    ['←→', 'key.leftArrow'],
    ['⏎', 'key.return'],
    ['CANC', 'key.delete'],
  ];
  for (const [voiceKey, branch] of special) {
    assert.ok(announced.includes(voiceKey), `voce assente: ${voiceKey}`);
    assert.ok(source.includes(branch), `ramo assente: ${branch}`);
  }
});

// ── comboRows ────────────────────────────────────────────────────────────────

test('comboRows: il taglio sta sul primo spazio, l\'etichetta tiene i successivi', () => {
  assert.deepEqual(comboRows(['CANC elimina tutte', '^K/^P/^R spawn']), [
    { key: 'CANC', label: 'elimina tutte' },
    { key: '^K/^P/^R', label: 'spawn' },
  ]);
});

test('comboRows: ogni voce ha tasto ed etichetta', () => {
  for (const state of [taskBase, fullBase, docBase]) {
    const voices = allVoices(deckLegend(state));
    const rows = comboRows(voices);
    assert.deepEqual(rows.map((r) => `${r.key} ${r.label}`), voices);
    assert.equal(rows.some((r) => r.label === ''), false, 'una voce senza etichetta');
  }
});

// ── comboLines: la disposizione ──────────────────────────────────────────────

test('comboLines: a ogni larghezza ogni voce sta intera su una riga, e nessuna riga sfora', () => {
  for (const state of [taskBase, { ...fullBase, purgeBulk: true }, docBase]) {
    const legend = deckLegend(state);
    for (const width of [172, 92, 72, 40, 32, 24]) {
      const texts = comboLines(legend, width).map(lineText);
      for (const text of texts) {
        assert.ok(termWidth(text) <= width, `riga di ${termWidth(text)} su ${width}: «${text}»`);
      }
      for (const row of comboRows(allVoices(legend))) {
        const voice = new RegExp(`(^|\\s)${row.key.replace(/[\^/]/g, '\\$&')}\\s+${row.label}`);
        assert.ok(texts.some((text) => voice.test(text)), `voce persa a ${width}: ${row.key} ${row.label}`);
      }
    }
  }
});

test('comboLines: le generali in alto, le due colonne affiancate sotto', () => {
  const texts = comboLines(deckLegend(taskBase), 72).map(lineText);
  assert.equal(texts[0], 'generali');
  const titles = texts.findIndex((text) => text.startsWith('task'));
  assert.match(texts[titles]!, /^task\s+conversazioni$/);
  assert.ok(texts.findIndex((text) => text.includes('tab vista')) < titles);
  assert.match(texts[titles + 1]!, /^⏎\s+detail\s+⏎\s+resume$/);
  // La colonna destra sta a metà larghezza, come il pane destro della vista normale.
  for (const text of texts.slice(titles, titles + 9)) {
    assert.equal(text[(72 - 2) / 2 + 2 - 1], ' ', `colonna sinistra sfora: «${text}»`);
    assert.notEqual(text[(72 - 2) / 2 + 2], ' ', `colonna destra disallineata: «${text}»`);
  }
});

test('comboLines: le generali vanno a capo fra una voce e l\'altra', () => {
  const lines = comboLines(deckLegend(fullBase), 40);
  const general = lines.slice(1, lines.findIndex((line) => lineText(line) === ' '));
  assert.ok(general.length > 1, 'a 40 colonne le generali non stanno su una riga');
  for (const line of general) {
    assert.notEqual(line[0]!.style, 'separator', `riga che apre col separatore: ${lineText(line)}`);
    assert.notEqual(line.at(-1)!.style, 'separator', `riga che chiude col separatore: ${lineText(line)}`);
  }
});

test('comboLines: sotto la soglia le colonne si impilano invece di tagliare', () => {
  const texts = comboLines(deckLegend({ ...taskBase, purgeBulk: true }), 32).map(lineText);
  const taskAt = texts.indexOf('task');
  const sessionAt = texts.indexOf('conversazioni');
  assert.ok(taskAt > 0 && sessionAt > taskAt, `colonne non impilate: ${texts.join('|')}`);
  assert.ok(texts.slice(taskAt, sessionAt).some((text) => /CANC\s+elimina tutte/.test(text)));
  assert.ok(texts.slice(sessionAt).some((text) => /A\s+assegna/.test(text)));
});

test('hintLegend: resta la voce che apre il modale, `^T` solo col bottone a schermo', () => {
  assert.equal(hintLegend({ restore: false }), 'H combo');
  assert.equal(hintLegend({ restore: true }), 'H combo · ^T restore');
});
