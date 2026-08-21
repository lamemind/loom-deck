import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  cleanTasksArgs,
  cleanTasksPrompt,
  deckArgs,
  forkArgs,
  onInTabCommand,
  resumeArgs,
  shellCommand,
  shellQuote,
  spawnCleanTasks,
  terminalArgs,
  DETAIL_ACTIONS,
  specializeRecap,
  INTAB_MARKER,
} from '../src/spawn.js';

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

// T111 — la nota data alla nascita viaggia sullo STESSO flag del resume, perché
// deck-run appende il suffisso al titolo prima che i rami si separino: il flag
// non appartiene alla ripresa, vale su ogni spawn.
test('deckArgs porta la nota nel titolo solo quando c\'è', () => {
  assert.deepEqual(deckArgs('T111', 'sid-1', 'preflight', 'opus', 'baluba'), [
    'T111',
    '--session-id',
    'sid-1',
    '--prompt-kind',
    'preflight',
    '--model',
    'opus',
    '--title-note',
    'baluba',
  ]);
  // Nota vuota = nessun flag, non `--title-note ''`: quello produrrebbe un `«»`
  // a vuoto nel titolo. Stesso regime già fissato per `resumeArgs`.
  assert.ok(!deckArgs('T111', 'sid-1', 'preflight', 'opus', '').includes('--title-note'));
  assert.ok(!deckArgs('T111', 'sid-1', 'preflight').includes('--title-note'));
});

// T117 — dal detail il prompt è un TESTO, non un simbolo: dopo una modifica a
// mano nessun kind lo descrive più. I due flag sono mutuamente esclusivi in
// deck-run, quindi qui l'uno sostituisce l'altro invece di affiancarlo.
test('deckArgs: un prompt letterale sostituisce il kind', () => {
  assert.deepEqual(deckArgs('T117', 'sid-1', 'run', 'opus', '', 'fai la cosa'), [
    'T117',
    '--session-id',
    'sid-1',
    '--prompt',
    'fai la cosa',
    '--model',
    'opus',
  ]);
});

test('deckArgs: prompt VUOTO → kind none, non un --prompt a vuoto', () => {
  // Senza flag deck-run cadrebbe sul proprio default `recap`, cioè su un prompt
  // che nessuno ha chiesto: «nessun prompt» va detto, non omesso. È il caso
  // dell'azione `open` e di un campo svuotato a mano.
  assert.deepEqual(deckArgs('T117', 'sid-1', 'none', 'opus', '', '').slice(3, 5), [
    '--prompt-kind',
    'none',
  ]);
  // `undefined` ≠ stringa vuota: chi non ha un campo prompt (gli acceleratori
  // della lista) continua a viaggiare col simbolo.
  assert.deepEqual(deckArgs('T117', 'sid-1', 'run').slice(3, 5), ['--prompt-kind', 'run']);
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

// ── T112 · potatura ordinata a clean-tasks ────────────────────────────────

test('cleanTasksPrompt dichiara la conferma già raccolta ed elenca gli ID', () => {
  // `yolo` non è una comodità: senza, `clean-tasks` apre un `AskUserQuestion`
  // sui target non-Done e in `claude -p` non c'è nessuno che risponda — la
  // sessione resta appesa e per il deck è indistinguibile da un'operazione lenta.
  assert.equal(cleanTasksPrompt(['T31'], null), '/loom-works:clean-tasks yolo T31');
  assert.equal(
    cleanTasksPrompt(['T31', 'T40', 'T52'], null),
    '/loom-works:clean-tasks yolo T31 T40 T52',
  );
});

test('cleanTasksPrompt passa --ignored-files solo quando la scelta è stata fatta', () => {
  // Passarlo sempre significherebbe decidere di default se dei file si perdono.
  assert.equal(
    cleanTasksPrompt(['T31'], 'keep'),
    '/loom-works:clean-tasks yolo --ignored-files keep T31',
  );
  assert.equal(
    cleanTasksPrompt(['T31'], 'purge'),
    '/loom-works:clean-tasks yolo --ignored-files purge T31',
  );
  assert.ok(!cleanTasksPrompt(['T31'], null).includes('--ignored-files'));
});

test('cleanTasksArgs porta il prompt come SINGOLO argv', () => {
  const args = cleanTasksArgs(['T31', 'T40'], 'sid-1', null);
  assert.deepEqual(args.slice(0, 6), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    'sid-1',
  ]);
  // Un argv solo: gli ID non passano mai da una shell, quindi non c'è quoting
  // da sbagliare né injection possibile dal contenuto della lista.
  assert.equal(args.length, 7);
  assert.equal(args[6], '/loom-works:clean-tasks yolo T31 T40');
});

test('nessuno spawn su bersaglio vuoto', () => {
  // `clean-tasks` senza SPEC esce 1: spawnarlo comunque farebbe riportare al
  // deck il fallimento di un'operazione che nessuno ha chiesto.
  let called = false;
  const child = spawnCleanTasks([], '/p', 'sid-1', null, () => {
    called = true;
  });
  assert.equal(child, null);
  assert.equal(called, false);
});

test('ogni azione del detail è un prompt-kind valido', () => {
  const kinds = DETAIL_ACTIONS.map((a) => a.kind);
  assert.deepEqual(kinds, ['none', 'preflight', 'run', 'recap', 'checkpoint']);
  // Le etichette non ripetono i kind: dove differiscono, il kind nomina il
  // MECCANISMO e l'etichetta l'INTENZIONE.
  assert.equal(DETAIL_ACTIONS[0]!.label, 'open');
  assert.equal(DETAIL_ACTIONS[3]!.label, 'status');
});

test('specializeRecap: solo `recap` si sdoppia, gli altri kind passano intatti', () => {
  assert.equal(specializeRecap('recap', false), 'recap-task');
  assert.equal(specializeRecap('recap', true), 'recap-epic');
  // Il flag epic non deve poter deviare un kind che non lo riguarda: un `run` su
  // un cappello resta un `run` (che poi run-task rifiuta, ed è un altro strato).
  for (const k of ['none', 'preflight', 'run', 'checkpoint'] as const) {
    assert.equal(specializeRecap(k, true), k);
    assert.equal(specializeRecap(k, false), k);
  }
  // Idempotente: un kind già specializzato non si ri-specializza.
  assert.equal(specializeRecap('recap-epic', false), 'recap-epic');
  assert.equal(specializeRecap('recap-task', true), 'recap-task');
});

// ── il comando esatto nella riga di stato ─────────────────────────────────

test('shellQuote lascia nudo ciò che una shell non interpreta', () => {
  for (const arg of ['T115', '--prompt-kind', 'opus', '/home/tizio/.local/bin/deck-run', 'a-b_c.d']) {
    assert.equal(shellQuote(arg), arg);
  }
});

test('shellQuote chiude in apici tutto il resto', () => {
  assert.equal(shellQuote('due parole'), "'due parole'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('$HOME'), "'$HOME'");
  assert.equal(shellQuote('nota 🔥'), "'nota 🔥'");
});

test("shellQuote esce dagli apici per l'apice, non lo escapa dentro", () => {
  // Dentro apici singoli nessun escape esiste: `\'` resterebbe backslash+apice.
  // L'unica forma corretta è chiudere, mettere l'apice quotato, riaprire.
  assert.equal(shellQuote("l'apice"), "'l'\\''apice'");
});

test('shellCommand ricompone eseguibile e argv come si scriverebbero in bash', () => {
  // È la riga che finisce nella riga di stato a ogni spawn di sessione Claude:
  // deve poter essere ricopiata in un terminale e fare la stessa cosa.
  assert.equal(
    shellCommand('/opt/deck-run', deckArgs('T115', 'sid-1', 'run', 'sonnet', 'due parole')),
    "/opt/deck-run T115 --session-id sid-1 --prompt-kind run --model sonnet --title-note 'due parole'",
  );
  assert.equal(shellCommand('/opt/deck-run', ['--no-task']), '/opt/deck-run --no-task');
});

// ── l'annuncio del comando in-tab, letto dallo stdout di deck-run ─────────

/** Figlio finto col solo stdout: è tutto ciò che `onInTabCommand` guarda. */
function fakeChild(): { child: ChildProcess; out: PassThrough } {
  const out = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  (child as { stdout: PassThrough }).stdout = out;
  return { child, out };
}

test('onInTabCommand consegna la riga annunciata, senza il marker', () => {
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`${INTAB_MARKER}LOOM_TASK=T115 claude --name 'x' --model opus\n`);
  assert.deepEqual(seen, ["LOOM_TASK=T115 claude --name 'x' --model opus"]);
});

test('onInTabCommand regge la riga spezzata fra due chunk', () => {
  // Una pipe non consegna righe, consegna byte: l'annuncio può arrivare a metà.
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`${INTAB_MARKER}claude --na`);
  assert.deepEqual(seen, [], 'consegnato prima dell’a-capo');
  out.write("me 'x'\n");
  assert.deepEqual(seen, ["claude --name 'x'"]);
});

test('onInTabCommand ignora quel che precede e quel che segue', () => {
  // Prima dell'annuncio può uscire altro; dopo l'exec lo stdout è di ptyxis,
  // e una sua riga non deve sostituire il comando mostrato.
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`rumore\n${INTAB_MARKER}claude\naltro rumore\n${INTAB_MARKER}secondo\n`);
  assert.deepEqual(seen, ['claude']);
});

test('onInTabCommand su un figlio senza stdout non chiama nessuno', () => {
  // È il caso `LOOM_DECK_NO_SPAWN`: il figlio è inerte e non annuncia mai.
  // Il chiamante resta con la nota che ha già scritto.
  const child = new EventEmitter() as ChildProcess;
  let called = false;
  onInTabCommand(child, () => {
    called = true;
  });
  assert.equal(called, false);
});
