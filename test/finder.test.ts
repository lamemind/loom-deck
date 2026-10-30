// T169 — il motore del finder: forma della query, righe, ordine e selezione
// iniziale. Logica pura: nessun Ink, nessun terminale, nessun filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTasks, initialSelection, parseFinderQuery } from '../src/finder.js';
import type { Task } from '../src/tasks.js';

function task(id: string, desc: string, prog = '🔵'): Task {
  return { id, pri: '⚡', prog, desc, rawDesc: desc };
}

// Fuori ordine APPOSTA: l'ordine del finder lo decide il motore, non la
// posizione in cui la lista gli arriva.
const TASKS: Task[] = [
  task('T14', 'Deck: tasto di prova'),
  task('T142', 'Sistema documentale: razionalizzazione'),
  task('T9', 'Spike Workflow'),
  task('T141', 'Review contratto editoriale doc', '✔️'),
  task('T1420', 'Ramo lontano con le stesse cifre in testa'),
  task('T169', 'Deck: finder delle task su T'),
  task('T20', 'Cita T142 nel titolo, ma è la T20'),
];

const ids = (ts: Task[]) => ts.map((t) => t.id);

test('parseFinderQuery: vuoto, numero con e senza T, testo', () => {
  assert.deepEqual(parseFinderQuery(''), { kind: 'all' });
  assert.deepEqual(parseFinderQuery('   '), { kind: 'all' });
  assert.deepEqual(parseFinderQuery('142'), { kind: 'id', digits: '142' });
  assert.deepEqual(parseFinderQuery('T142'), { kind: 'id', digits: '142' });
  assert.deepEqual(parseFinderQuery('t142'), { kind: 'id', digits: '142' });
  assert.deepEqual(parseFinderQuery(' T142 '), { kind: 'id', digits: '142' });
  assert.deepEqual(parseFinderQuery('deck'), { kind: 'text', text: 'deck' });
  // `T` da sola e `T14x` non sono un id: diventano testo, non un numero vuoto.
  assert.deepEqual(parseFinderQuery('T'), { kind: 'text', text: 'T' });
  assert.deepEqual(parseFinderQuery('T14x'), { kind: 'text', text: 'T14x' });
});

test('campo vuoto: tutte le righe, id decrescente', () => {
  const r = findTasks(TASKS, '');
  assert.deepEqual(ids(r.tasks), ['T1420', 'T169', 'T142', 'T141', 'T20', 'T14', 'T9']);
  assert.equal(r.exact, null);
  assert.equal(initialSelection(r), 'T1420');
});

test('le righe sono tutte quelle ricevute: nessun predicato di vista o di filtro', () => {
  // Una task chiusa (✔️) è proprio quella che il filtro salvato del pane
  // nasconde: qui deve esserci comunque.
  const r = findTasks(TASKS, '');
  assert.equal(r.tasks.length, TASKS.length);
  assert.ok(ids(r.tasks).includes('T141'));
});

test('id esatto: in testa e selezione iniziale, con e senza T', () => {
  for (const q of ['142', 'T142', 't142']) {
    const r = findTasks(TASKS, q);
    assert.equal(r.exact, 'T142', q);
    assert.equal(r.tasks[0]!.id, 'T142', q);
    assert.equal(initialSelection(r), 'T142', q);
  }
});

test('id: dopo l\'esatto gli id che cominciano con le stesse cifre, decrescenti', () => {
  const r = findTasks(TASKS, '14');
  assert.deepEqual(ids(r.tasks), ['T14', 'T1420', 'T142', 'T141']);
  assert.equal(initialSelection(r), 'T14');
});

test('id: un numero non guarda il titolo', () => {
  // T20 nomina T142 in prosa: `142` cerca un id, e tirarla dentro metterebbe
  // un'altra riga a un tasto dall'`⏎` battuto di slancio.
  assert.ok(!ids(findTasks(TASKS, '142').tasks).includes('T20'));
});

test('id: solo prefisso senza esatto, la selezione parte dalla prima', () => {
  const r = findTasks(TASKS, '16');
  assert.deepEqual(ids(r.tasks), ['T169']);
  assert.equal(r.exact, null);
  assert.equal(initialSelection(r), 'T169');
});

test('id assente: lista vuota, nessuna selezione', () => {
  const r = findTasks(TASKS, '999');
  assert.deepEqual(r.tasks, []);
  assert.equal(r.exact, null);
  assert.equal(initialSelection(r), null);
});

test('id con zeri in testa: non diventa un altro id per via del numero', () => {
  assert.equal(findTasks(TASKS, '0142').exact, null);
  assert.deepEqual(findTasks(TASKS, '0142').tasks, []);
});

test('testo: sottostringa del titolo senza maiuscole, id decrescente', () => {
  const r = findTasks(TASKS, 'DECK');
  assert.deepEqual(ids(r.tasks), ['T169', 'T14']);
  assert.equal(r.exact, null);
  assert.equal(initialSelection(r), 'T169');
});

test('testo: letterale, i metacaratteri non fanno da regex', () => {
  assert.deepEqual(ids(findTasks(TASKS, 'deck:').tasks), ['T169', 'T14']);
  assert.deepEqual(findTasks(TASKS, 'd.ck').tasks, []);
});

test('testo: basta un carattere', () => {
  assert.ok(findTasks(TASKS, 'w').tasks.length > 0);
});

test('task senza task file: il motore non legge file, la riga di tasks.md basta', () => {
  // Nessun `tasksDir` fra i parametri: una task il cui file manca risponde
  // come le altre, per id e per titolo.
  const orfana = task('T300', 'Riga senza task file');
  assert.equal(findTasks([orfana], '300').exact, 'T300');
  assert.deepEqual(ids(findTasks([orfana], 'senza').tasks), ['T300']);
});

test('lista vuota: nessuna riga, nessuna selezione', () => {
  const r = findTasks([], '');
  assert.deepEqual(r.tasks, []);
  assert.equal(initialSelection(r), null);
});

test('il motore non muta la lista ricevuta', () => {
  const copy = [...TASKS];
  findTasks(TASKS, '');
  findTasks(TASKS, '14');
  assert.deepEqual(TASKS, copy);
});
