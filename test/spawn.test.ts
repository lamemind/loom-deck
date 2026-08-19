import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckArgs, forkArgs, resumeArgs, terminalArgs, DETAIL_ACTIONS } from '../src/spawn.js';

// La forma degli argv È il contratto col primitive `deck-run`, e finora non la
// fissava nulla: un flag rinominato da un lato si scopriva solo aprendo una tab.

test('deckArgs pinna il sessionId e dichiara sempre il kind', () => {
  // Il kind non ha default qui: dal deck ogni tasto dichiara il proprio intento,
  // e un default silenzioso renderebbe indistinguibili `⏎` e `^K`.
  // Il modello sì (T108): i percorsi che non passano dal selettore del detail
  // non hanno un intento da dichiarare, e il loro unico valore sensato è quello
  // che il selettore stesso mostra all'apertura.
  assert.deepEqual(deckArgs('T104', 'sid-1', 'run'), [
    'T104',
    '--session-id',
    'sid-1',
    '--prompt-kind',
    'run',
    '--model',
    'opus',
  ]);
  assert.deepEqual(deckArgs('T104', 'sid-1', 'run', 'sonnet').slice(-2), ['--model', 'sonnet']);
});

test('resumeArgs scoped porta la task, spot porta --no-task', () => {
  assert.deepEqual(resumeArgs('T81', 'sid-1'), ['T81', '--resume', 'sid-1']);
  assert.deepEqual(resumeArgs(null, 'sid-1'), ['--no-task', '--resume', 'sid-1']);
});

test('resumeArgs aggiunge la nota al titolo solo quando c\'è', () => {
  assert.deepEqual(resumeArgs('T81', 'sid-1', 'parser'), [
    'T81',
    '--resume',
    'sid-1',
    '--title-note',
    'parser',
  ]);
  // Nota vuota = nessuna nota: un `--title-note ''` metterebbe nel titolo una
  // maniglia che in lista non compare.
  assert.deepEqual(resumeArgs('T81', 'sid-1', ''), ['T81', '--resume', 'sid-1']);
});

test('forkArgs porta insieme --resume e --session-id', () => {
  // È l'unico punto in cui i due flag convivono: CC apre un id NUOVO invece di
  // riprendere a scrivere sull'origine — due writer sullo stesso JSONL non
  // esistono mai, che è l'intero punto del fork.
  const args = forkArgs('T81', 'origine', 'nuovo');
  assert.deepEqual(args, ['T81', '--resume', 'origine', '--fork', '--session-id', 'nuovo']);
  assert.ok(args.includes('--resume') && args.includes('--session-id'));
});

test('forkArgs senza task resta spot', () => {
  assert.deepEqual(forkArgs(null, 'origine', 'nuovo'), [
    '--no-task',
    '--resume',
    'origine',
    '--fork',
    '--session-id',
    'nuovo',
  ]);
});

test('il fork non eredita la nota dell\'origine', () => {
  assert.ok(!forkArgs('T81', 'origine', 'nuovo').includes('--title-note'));
});

test('terminalArgs titola la tab quando il progetto ha un\'identità', () => {
  // Senza titolo la surface resta funzionante, ma il progetto esce dal radar di
  // compass finché quella tab è in primo piano.
  assert.deepEqual(terminalArgs('/p', '🖥️ loom-works'), [
    '--tab',
    '-T',
    '🖥️ loom-works',
    '-d',
    '/p',
  ]);
  assert.deepEqual(terminalArgs('/p', null), ['--tab', '-d', '/p']);
});

test('terminalArgs non passa mai un comando da eseguire', () => {
  // L'azione È aprire la shell — differenza dalle launch custom, che eseguono un
  // comando dentro `bash -lic`.
  assert.ok(!terminalArgs('/p', 't').includes('--'));
});

test('ogni azione del detail è un prompt-kind valido', () => {
  const kinds = DETAIL_ACTIONS.map((a) => a.kind);
  assert.deepEqual(kinds, ['none', 'preflight', 'run', 'recap', 'checkpoint']);
  // Le etichette non ripetono i kind: dove differiscono, il kind nomina il
  // MECCANISMO e l'etichetta l'INTENZIONE.
  assert.equal(DETAIL_ACTIONS[0]!.label, 'open');
  assert.equal(DETAIL_ACTIONS[3]!.label, 'status');
});
