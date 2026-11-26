// T232 — gate dei modi (vedi `modes-smoke.test.ts`): la pagina delle azioni di
// spawn e la pagina delle voci launch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANC, CAN_RUN, CTRL_L, CTRL_S, ESC, SKIP, TASKS } from './pty-harness.js';
import { LIST_FRAME, capture, configProject, lastFrame } from './modes-kit.js';
import { MODELS, MODEL_DEFAULT, spawnAction } from '../src/spawn-catalog.js';

// ── T161 · la pagina delle azioni di spawn ─────────────────────────────────
//
// Il gate di larghezza (`frame-width-pages.test.ts`) misura che la tabella non sfondi
// il frame ed è cieco al comportamento; qui si verifica il CICLO: l'area si
// apre, il valore cambia, `w` scrive il blocco nel file di progetto.
//
// Il progetto è TEMPORANEO e col suo `.claude/loom-works.json`: `w` scrive
// davvero, e scriverlo nel cappello vero significherebbe che lanciare i test
// riconfigura il deck di chi li lancia.

test('pagina azioni: ⏎ apre l\'area di compilazione della riga', { skip: SKIP }, () => {
  const frame = lastFrame(capture(`${CTRL_S}\r`, configProject()));
  assert.match(frame, /modello/, `l'area non si è aperta: ${frame}`);
  assert.match(frame, /esempio/, `manca l'anteprima resa: ${frame}`);
});

test('pagina azioni: CANC su una riga mai toccata lo dice', { skip: SKIP }, () => {
  // Inerzia dichiarata invece che silenziosa, come `^K` fuori dal pane task.
  const frame = capture(`${CTRL_S}${CANC}`, configProject());
  assert.match(frame, /nessun override da togliere/, frame);
});

test('pagina azioni: il modello scelto finisce nel file di progetto', { skip: SKIP }, () => {
  // `⏎` apre l'area sulla prima riga (`none`), `D` scende sulla riga modello,
  // `R` cicla al successivo del default di `none`, `⏎` congela nella bozza, `w`
  // scrive. L'atteso si deriva dal catalogo: scritto a mano è un calco che
  // scade al primo cambio di default.
  const proj = configProject();
  const frame = capture(`${CTRL_S}\rDR\rw`, proj);
  const doc = JSON.parse(readFileSync(join(proj, '.claude', 'loom-works.json'), 'utf8'));
  const base = spawnAction('none')?.model ?? MODEL_DEFAULT;
  const next = MODELS[(MODELS.indexOf(base) + 1) % MODELS.length];
  assert.deepEqual(doc.spawn, { none: { model: next } }, `frame: ${frame}`);
  // Il resto del file non è stato toccato: il saver è read-modify-write.
  assert.equal(doc.id, 'prova');
  assert.equal(doc.emoji, '🧵');
});

test('pagina azioni: senza un file di progetto `w` rifiuta e lo dice', { skip: SKIP }, () => {
  // Un progetto non registrato non riceve un `loom-works.json` generato dal
  // deck: quel file regge identità, label e registry di compass, e il deck non
  // li conosce nemmeno tutti.
  const naked = mkdtempSync(join(tmpdir(), 'loom-deck-noconfig-'));
  mkdirSync(join(naked, 'runtime', 'tasks'), { recursive: true });
  if (CAN_RUN) copyFileSync(TASKS, join(naked, 'runtime', 'tasks.md'));
  const frame = capture(`${CTRL_S}\rDR\rw`, naked);
  assert.match(frame, /⚠|ENOENT|no such file/i, frame);
});

// ── T168 · la pagina delle voci launch ──────────────────────────────────────
//
// Sul progetto temporaneo con due voci: una nuda e una con esito. Gli spawn sono
// inerti (`LOOM_DECK_NO_SPAWN`), quindi `⏎` misura la nota e non il processo;
// `w` scrive davvero nel file del progetto temporaneo.

function launchProject(): string {
  const root = configProject();
  writeFileSync(
    join(root, '.claude', 'loom-works.json'),
    JSON.stringify(
      {
        id: 'prova',
        emoji: '🧵',
        name: 'prova',
        launch: [
          { emoji: '📝', label: 'codium', command: 'codium .' },
          { emoji: '⬇️', label: 'pull all', command: 'git pull --ff-only', capture: true, key: '9' },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return root;
}

test('pagina launch: elenca le voci con cifra e attributi, esc chiude', { skip: SKIP }, () => {
  const proj = launchProject();
  const open = lastFrame(capture(CTRL_L, proj));
  assert.match(open, /voci launch/, `la pagina non si è aperta: ${open}`);
  assert.match(open, /1 📝 codium/, `manca la voce nuda con la sua cifra: ${open}`);
  assert.match(open, /9 .* pull all/, `la voce pinnata non porta la 9: ${open}`);
  assert.match(open, /capture ✓/, `l'attributo capture non è disegnato: ${open}`);
  const closed = lastFrame(capture(`${CTRL_L}${ESC}`, proj));
  assert.doesNotMatch(closed, /voci launch ·/, `la pagina è rimasta aperta: ${closed}`);
  assert.match(closed, LIST_FRAME, `il deck non è tornato alla lista: ${closed}`);
});

test('pagina launch: ⏎ lancia la voce selezionata, l su una voce senza esito lo dice', { skip: SKIP }, () => {
  const proj = launchProject();
  assert.match(capture(`${CTRL_L}\r`, proj), /⏎ → codium su prova/);
  assert.match(capture(`${CTRL_L}l`, proj), /non ha esito: accendi capture/);
  // La voce con esito, mai partita: nessun log da aprire.
  assert.match(capture(`${CTRL_L}Dl`, proj), /non è mai partita/);
});

test('pagina launch: tab + spazio spegne header, w lo scrive nel file', { skip: SKIP }, () => {
  const proj = launchProject();
  const frame = capture(`${CTRL_L}\t w`, proj);
  const doc = JSON.parse(readFileSync(join(proj, '.claude', 'loom-works.json'), 'utf8'));
  assert.equal(doc.launch[0].header, false, `frame: ${frame}`);
  // Gli altri attributi al default non entrano nel file, e la seconda voce è intatta.
  assert.equal('capture' in doc.launch[0], false);
  assert.deepEqual(doc.launch[1], { emoji: '⬇️', label: 'pull all', command: 'git pull --ff-only', capture: true, key: '9' });
  assert.equal(doc.id, 'prova');
});

// ── T258 · il log del giro vero dopo un tentativo senza esito ───────────────
//
// Lo stato su disco di una voce con `noOutcome` dopo un giro vero (exit 1) e un
// tentativo (exit 3): il record, `<slug>.log` col testo del tentativo e
// `<slug>.outcome.log` col testo del giro vero. Scritto a mano e non prodotto
// da un giro: gli spawn del gate sono inerti. Il test misura il collegamento
// fra il tasto e la scelta del file, che vive in un hook React e nessun test
// puro raggiunge.

function attemptProject(withTrueLog: boolean): string {
  const root = configProject();
  writeFileSync(
    join(root, '.claude', 'loom-works.json'),
    JSON.stringify({
      id: 'prova',
      emoji: '🧵',
      name: 'prova',
      launch: [{ emoji: '🔬', label: 'custodia', command: 'giro.sh', capture: true, noOutcome: [3] }],
    }) + '\n',
  );
  const dir = join(root, '.claude', 'loom', 'launch');
  mkdirSync(dir, { recursive: true });
  const at = Date.parse('2026-11-20T14:30:00');
  writeFileSync(
    join(dir, 'custodia.json'),
    JSON.stringify({
      pid: null,
      procStart: null,
      startedAt: at + 60_000,
      endedAt: at + 61_000,
      exit: 3,
      origin: 'every',
      lastOutcome: { startedAt: at - 30_000, endedAt: at, exit: 1 },
    }) + '\n',
  );
  writeFileSync(join(dir, 'custodia.log'), 'giro già in corso\n');
  if (withTrueLog) writeFileSync(join(dir, 'custodia.outcome.log'), 'misura del giro vero: 4 difetti\n');
  return root;
}

test('pagina launch: l apre il log del giro vero, tab passa al tentativo e torna', { skip: SKIP }, () => {
  const proj = attemptProject(true);
  const truth = lastFrame(capture(`${CTRL_L}l`, proj));
  assert.match(truth, /:: LOG \[ exit 1 · /, `l'intestazione non nomina il giro vero: ${truth}`);
  assert.match(truth, /misura del giro vero/, `il testo non è quello del giro vero: ${truth}`);
  assert.doesNotMatch(truth, /giro già in corso/, `il testo del tentativo sotto l'esito del giro vero: ${truth}`);
  assert.match(truth, /tab tentativo/, `la legenda non offre il tentativo: ${truth}`);
  const tried = lastFrame(capture(`${CTRL_L}l\t`, proj));
  assert.match(tried, /:: LOG tentativo · senza esito: exit 3 · /, `l'intestazione non nomina il tentativo: ${tried}`);
  assert.match(tried, /giro già in corso/, `il testo non è quello del tentativo: ${tried}`);
  assert.doesNotMatch(tried, /exit 1/, `l'esito del giro vero sopra il testo del tentativo: ${tried}`);
  const back = lastFrame(capture(`${CTRL_L}l\t\t`, proj));
  assert.match(back, /misura del giro vero/, `il secondo tab non torna al giro vero: ${back}`);
});

test('pagina launch: senza il log del giro vero, l apre il tentativo dichiarato come tale', { skip: SKIP }, () => {
  const frame = lastFrame(capture(`${CTRL_L}l`, attemptProject(false)));
  assert.match(frame, /:: LOG tentativo · senza esito: exit 3 · .*log del giro vero non su disco/, frame);
  assert.match(frame, /giro già in corso/, frame);
  assert.doesNotMatch(frame, /\[ exit 1/, `l'esito del giro vero sopra il testo del tentativo: ${frame}`);
});

test('pagina launch: la cifra dalla lista lancia la voce pinnata', { skip: SKIP }, () => {
  const proj = launchProject();
  assert.match(capture('9', proj), /9 → pull all avviato/);
  assert.match(capture('2', proj), /2 → nessuna voce launch \(2 in riga\)/);
});
