// T184 — `⏎` su una conversazione: le parti PURE di `focus-session.ts`.
//
// Il canale vero (un processo `gdbus`) sta in `focus-channel.test.ts` e in
// `focus-absent.test.ts`: il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), quindi ogni binario finto vuole un file suo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enterSession,
  focusNote,
  focusSessionArgs,
  parseFocusReply,
  type EnterDeps,
  type FocusResult,
} from '../src/focus-session.js';

// L'argv È il contratto col metodo di compass (T183): un nome di interfaccia o
// di metodo sbagliato da un lato si scoprirebbe solo come `UnknownMethod` a
// runtime, cioè come «compass non raggiungibile» su un compass vivo.
test('focusSessionArgs: il metodo di compass, col timeout e il sessionId nudo in coda', () => {
  assert.deepEqual(focusSessionArgs('sid-1'), [
    'call',
    '--session',
    '--dest',
    'org.lamemind.Compass',
    '--object-path',
    '/org/lamemind/Compass',
    '--method',
    'org.lamemind.Compass.FocusSession',
    '--timeout',
    '5',
    'sid-1',
  ]);
});

test('parseFocusReply: la parola dentro la tupla di un elemento', () => {
  assert.equal(parseFocusReply("('tab',)\n"), 'tab');
  assert.equal(parseFocusReply("('esatta',)"), 'esatta');
  assert.equal(parseFocusReply("('sconosciuta',)\n"), 'sconosciuta');
});

test('parseFocusReply: un esito che compass aggiungesse passa così com’è', () => {
  // Il vocabolario non si ricopia qui: un esito nuovo deve arrivare nella nota
  // con la sua parola, non confondersi con un canale rotto.
  assert.equal(parseFocusReply("('nuovo',)"), 'nuovo');
});

test('parseFocusReply: una risposta di forma diversa non è un esito', () => {
  assert.equal(parseFocusReply(''), null);
  assert.equal(parseFocusReply('(true,)'), null);
  assert.equal(parseFocusReply("('tab', 'altro')"), null);
  assert.equal(parseFocusReply('tab'), null);
});

// Una nota a OGNI esito, successo compreso: la tab del deck va dietro, e la nota
// si legge al ritorno.
test('focusNote: sul successo il nome della conversazione raggiunta', () => {
  assert.equal(focusNote({ reached: true, outcome: 'tab' }, 'T184 «focus»'), '→ T184 «focus»');
  assert.equal(focusNote({ reached: true, outcome: 'esatta' }, 'T184 «focus»'), '→ T184 «focus»');
});

test('focusNote: ogni esito fuori dalla tab porta la sua parola e il nome', () => {
  for (const outcome of ['ambigua', 'assente', 'fallita', 'errore', 'nessuna', 'sconosciuta']) {
    assert.equal(
      focusNote({ reached: false, outcome }, 'T184 «focus»'),
      `⚠ focus ${outcome} — T184 «focus»`,
    );
  }
});

test('focusNote: il canale che fallisce non nomina un esito', () => {
  assert.equal(
    focusNote({ unreachable: 'ENOENT' }, 'T184 «focus»'),
    '⚠ compass non raggiungibile — T184 «focus»',
  );
});

// La scelta del `⏎`, col canale finto: senza `gdbus`, senza compass, senza
// processi vivi.
function fakeDeps(live: Set<string>, reply: FocusResult) {
  const calls = { focused: [] as string[], resumed: [] as string[], notes: [] as string[] };
  const deps: EnterDeps = {
    isLive: (id) => live.has(id),
    nameOf: (id) => `nome-${id}`,
    focus: (id, onResult) => {
      calls.focused.push(id);
      onResult(reply);
    },
    resume: (id) => calls.resumed.push(id),
    note: (s) => calls.notes.push(s),
  };
  return { deps, calls };
}

test('enterSession: non viva → resume, il canale non parte', () => {
  const { deps, calls } = fakeDeps(new Set(['altra']), { reached: true, outcome: 'tab' });
  assert.equal(enterSession('morta', deps), 'resume');
  assert.deepEqual(calls.resumed, ['morta']);
  assert.deepEqual(calls.focused, []);
  // La nota del resume è quella di oggi, scritta da `resumeSession` (il comando
  // di `deck-run`): qui non se ne aggiunge una seconda.
  assert.deepEqual(calls.notes, []);
});

test('enterSession: viva → il canale riceve il sessionId, nessun resume', () => {
  const { deps, calls } = fakeDeps(new Set(['viva']), { reached: true, outcome: 'tab' });
  assert.equal(enterSession('viva', deps), 'focus');
  assert.deepEqual(calls.focused, ['viva']);
  assert.deepEqual(calls.resumed, []);
  assert.deepEqual(calls.notes, ['→ nome-viva']);
});

test('enterSession: viva senza tab (assente) → nota, MAI un resume', () => {
  const { deps, calls } = fakeDeps(new Set(['viva']), { reached: false, outcome: 'assente' });
  enterSession('viva', deps);
  assert.deepEqual(calls.resumed, [], 'riprenderla aprirebbe un secondo scrittore sul transcript');
  assert.deepEqual(calls.notes, ['⚠ focus assente — nome-viva']);
});

test('enterSession: viva e compass assente → nota, MAI un resume', () => {
  const { deps, calls } = fakeDeps(new Set(['viva']), { unreachable: 'ENOENT' });
  enterSession('viva', deps);
  assert.deepEqual(calls.resumed, []);
  assert.deepEqual(calls.notes, ['⚠ compass non raggiungibile — nome-viva']);
});

// Il cablaggio vive in un hook React (`actions.ts`), che un test unitario non
// monta: si legge il sorgente come TESTO, come `input-wiring.test.ts`. Il gate
// tiene fermi i due fatti che un refactor romperebbe in silenzio — i due `⏎`
// passano dalla stessa funzione, e il restore resta fuori da lei.
const PKG = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = (f: string) => readFileSync(join(PKG, 'src', f), 'utf8');

/** Il corpo di `function <name>(` in `src/<file>`, fino alla graffa che la
 *  chiude allo stesso livello di indentazione: il commento della funzione
 *  successiva ne resta fuori. */
function body(file: string, name: string): string {
  const text = src(file);
  const at = text.indexOf(`  function ${name}(`);
  assert.notEqual(at, -1, `${name} non trovata in src/${file}`);
  const end = text.indexOf('\n  }\n', at);
  assert.notEqual(end, -1, `fine di ${name} non trovata in src/${file}`);
  return text.slice(at, end);
}

test('cablaggio: i due ⏎ chiamano openSession, nessuno chiama più resumeSession', () => {
  assert.match(src('input.ts'), /actions\.openSession\(s\.sessionId, model\.resumeModel\)/);
  assert.match(src('cli.tsx'), /onResume: \(row\) =>\s+actions\.openSession\(/);
  assert.doesNotMatch(src('input.ts'), /actions\.resumeSession\(/);
  assert.doesNotMatch(src('cli.tsx'), /actions\.resumeSession\(/);
});

test('cablaggio: il restore riapre con resumeSession, che non porta nessun ramo di focus', () => {
  assert.match(body('actions.ts', 'restoreSessions'), /resumeSession\(s\.sessionId,/);
  assert.doesNotMatch(body('actions.ts', 'restoreSessions'), /openSession\(/);
  assert.doesNotMatch(body('actions.ts', 'resumeSession'), /focus|enterSession|live\./);
});

test('cablaggio: il predicato di «viva» è il registro, come in selectSessionRows', () => {
  assert.match(body('actions.ts', 'openSession'), /isLive: \(id\) => model\.live\.has\(id\)/);
});
