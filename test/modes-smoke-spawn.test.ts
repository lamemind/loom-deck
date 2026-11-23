// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il selettore del modello
// della nuda e del resume, e l'alfabeto del detail misurato sull'argv dello
// spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKIP } from './pty-harness.js';
import { capture, lastFrame, singleSessionProject } from './modes-kit.js';
import { detailProject } from './detail-fixture.js';

// T117 — l'ALFABETO del detail dopo il passaggio all'area di compilazione a
// righe. Cosa un tasto faccia dipende ora dalla RIGA IN FUOCO, ed è precisamente
// l'informazione che un merge futuro può perdere senza che nulla smetta di
// compilare: una lettera che finisce nel campo sbagliato è un comportamento, non
// un tipo.
//
// Lo spawn è l'unico punto in cui i quattro valori diventano osservabili in
// testo semplice: la riga di stato porta il COMANDO esatto, quindi tutti come
// argomenti (`--prompt`, `--model`, `--title-note`), mentre nel frame del detail
// la voce attiva si distingue solo per video inverso, che `stripAnsi` toglie.
// Con NO_SPAWN il processo non parte, ma il sidecar SÌ — da cui il project root
// temporaneo: i record orfani di un test non hanno motivo di finire nel file di
// chi lo lancia.
//
// La coda del comando sopravvive al taglio anche su un terminale stretto
// (`cutMiddle` sacrifica il mezzo): è ciò che rende queste asserzioni stabili
// nonostante il path assoluto di `deck-run` in testa.
//
// T252 — ogni scenario gira su un progetto SINTETICO, nessuno sul cappello
// vero né su una copia del suo `tasks.md`: la lista del cappello cambia a ogni
// create-task e a ogni checkpoint, e con lei la task che il detail apre.

/**
 * Un progetto con UNA riga in `tasks.md` e NESSUN task file, `HOME` dirottato.
 *
 * Senza task file il detail si apre sull'area di compilazione (non c'è una
 * checklist da leggere), e il buco `{slug}` del titolo di `open` resta senza
 * valore: il campo titolo parte vuoto, e lo spawn di `open` non porta
 * `--title-note`. È ciò che gli scenari sotto misurano — una cifra o una
 * lettera che non finiscono nel titolo, un titolo vuoto che non diventa un
 * flag — e su una task col suo file il titolo partirebbe già pieno del nome.
 * Nessun blocco `spawn`, quindi `run` tiene modello e titolo del catalogo: la
 * coda del comando resta corta, e `--prompt` sopravvive al taglio a metà.
 */
function rowOnlyProject(): { proj: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-smoke-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'runtime', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(
    join(proj, 'runtime', 'tasks.md'),
    [
      '# Tasks',
      '',
      '## Tasks Overview',
      '',
      '| ID | Pri | Prog | Task |',
      '| --- | --- | --- | --- |',
      '| T1 | ⚡ | 🔵 | task senza file |',
    ].join('\n') + '\n',
  );
  return { proj, env: { HOME: join(root, 'home') } };
}

/** Apre il detail della sola task di `rowOnlyProject`, sulla riga azione:
 *  `DD` scende dalle due righe meta alla task. */
const OPEN_DETAIL = 'DD\r';

/** Dalla riga azione alla riga titolo: `D` (↓) scende di una riga. */
const TO_TITLE_ROW = 'DDD';

/** L'ultimo frame dopo i tasti, su un `rowOnlyProject` nuovo. */
function captureRowOnly(keys: string): string {
  const { proj, env } = rowOnlyProject();
  return lastFrame(capture(keys, proj, env));
}

// ── T154 · il selettore della nuda e il tasto `m` bifronte ───────────────

test('c senza toccare il selettore apre comunque su un modello esplicito (il default)', {
  skip: SKIP,
}, () => {
  const frame = captureRowOnly('c');
  assert.match(frame, /--no-task/, `c non ha spawnato la nuda: ${frame}`);
  assert.match(frame, /--model opus/, `il default non è stato passato esplicitamente: ${frame}`);
});

test('m senza una riga sessione in fuoco cicla il modello della nuda: c la spawna col valore ciclato', {
  skip: SKIP,
}, () => {
  // Focus di apertura è `tasks` (D4): `m` deve cadere sul bersaglio nuda.
  const frame = captureRowOnly('mc');
  assert.match(frame, /--no-task/, `c non ha spawnato la nuda: ${frame}`);
  assert.match(frame, /--model sonnet/, `m fuori dal pane sessioni non ha cambiato la nuda: ${frame}`);
});

test('m con una riga sessione selezionata cicla il modello di resume, non quello della nuda', {
  skip: SKIP,
}, () => {
  const { proj, env } = singleSessionProject();
  // `R` porta il focus sul pane sessioni, sulla sola riga esistente. Il suo
  // modello d'origine è `fable`: `m` deve avanzare quella riga a `opus`, e
  // `⏎` (resume) lo porta nell'argv.
  const frame = lastFrame(capture('Rm\r', proj, env));
  assert.match(frame, /--resume/, `⏎ non ha fatto resume: ${frame}`);
  assert.match(frame, /--model opus/, `m sulla riga sessione non ha cambiato il resume: ${frame}`);
});

test('i due selettori non si contaminano: la nuda ciclata non muove il resume', { skip: SKIP }, () => {
  const { proj, env } = singleSessionProject();
  // `m` (nuda → sonnet) col focus ancora sui task, poi `R` porta il focus sulla
  // riga sessione e `⏎` fa resume: se i due stati fossero lo stesso, il
  // resume partirebbe già su `sonnet` invece che sul modello d'origine (`fable`).
  const frame = lastFrame(capture('mR\r', proj, env));
  assert.match(frame, /--model fable/, `il resume ha ereditato il modello della nuda: ${frame}`);
});

test('i due selettori non si contaminano: il resume ciclato non muove la nuda', { skip: SKIP }, () => {
  const { proj, env } = singleSessionProject();
  // `R` seleziona la riga sessione, `mm` cicla il suo resume da `fable` a
  // `sonnet`; `L` torna sul pane task e `c` apre la nuda: se i due stati
  // fossero lo stesso, aprirebbe già su `sonnet` invece che sul proprio default
  // (`opus`). Due `m` e non uno: un solo giro porterebbe il resume proprio su
  // `opus`, e il test resterebbe verde anche con i due stati fusi.
  const frame = lastFrame(capture('RmmLc', proj, env));
  assert.match(frame, /--no-task/, `c non ha spawnato la nuda: ${frame}`);
  assert.match(frame, /--model opus/, `la nuda ha ereditato il modello del resume: ${frame}`);
});

test('detail: la riga azione risponde alle lettere e riscrive il prompt', { skip: SKIP }, () => {
  const frame = captureRowOnly(`${OPEN_DETAIL}r\r`);
  assert.match(frame, /--prompt .\/loom-works:run-task/, `r non ha selezionato run: ${frame}`);
});

test('detail: una cifra sulla riga azione è inerte, non finisce in un campo', {
  skip: SKIP,
}, () => {
  // Nessuna azione ha `2` per iniziale → il tasto non ha nulla da fare, e con il
  // fuoco su una riga a scelta non esiste un campo dove ricadere.
  const frame = captureRowOnly(`${OPEN_DETAIL}2\r`);
  assert.doesNotMatch(frame, /--title-note/, `la cifra è finita nel titolo: ${frame}`);
  assert.match(frame, /--model opus/, `il modello è cambiato con una cifra: ${frame}`);
});

test('detail: le lettere entrano nel campo solo quando la sua riga è in fuoco', {
  skip: SKIP,
}, () => {
  // `o` è l'iniziale di `open`: sulla riga azione seleziona, sulla riga titolo
  // dev'essere testo. È il caso che distingue il focus-gating da un catch-all.
  const frame = captureRowOnly(`${OPEN_DETAIL}${TO_TITLE_ROW}oro\r`);
  assert.match(frame, /--title-note oro/, `il testo non è finito nel titolo: ${frame}`);
});

test('detail: il prompt modificato a mano è quello che parte', { skip: SKIP }, () => {
  // `r` sceglie run (prompt pre-riempito col template), poi si scende sul campo
  // e si scrive in coda: quello che parte dev'essere il testo MODIFICATO, che
  // nessun `--prompt-kind` saprebbe più descrivere.
  const frame = captureRowOnly(`${OPEN_DETAIL}rDzz\r`);
  assert.match(frame, /--prompt .\/loom-works:run-task T\d+zz./, `prompt non modificato: ${frame}`);
  assert.doesNotMatch(frame, /--prompt-kind/, `kind e prompt insieme: ${frame}`);
});

test('detail: azione open → nessun prompt iniziale allo spawn', { skip: SKIP }, () => {
  // `open` è l'azione di default e il suo campo prompt è vuoto: lo spawn passa
  // `--prompt-kind none`, non un `--prompt ''` — deck-run cadrebbe altrimenti sul
  // proprio default `recap`, cioè su un prompt che nessuno ha chiesto.
  const frame = captureRowOnly(`${OPEN_DETAIL}\r`);
  assert.match(frame, /--prompt-kind none/, `open non ha spawnato a mani nude: ${frame}`);
  assert.doesNotMatch(frame, /--title-note/, `flag di titolo a vuoto: ${frame}`);
});

test('detail: tab alterna i due modi senza toccare il modello', { skip: SKIP }, () => {
  // `T` = tab nel mapping del pty. T189 gli dà un binding — alterna area di
  // compilazione e lista DLV — ma il modello resta un dato dei campi: si cambia
  // con `←→` dalla sua riga, e `tab` non deve muoverlo di nascosto. Due `tab`
  // tornano ai campi, e `⏎` parte col modello dell'azione iniziale.
  const frame = captureRowOnly(`${OPEN_DETAIL}TT\r`);
  assert.match(frame, /--model opus/, `tab ha cambiato modello: ${frame}`);
});

test('detail: la riga modello risponde a ←→ quando è in fuoco', { skip: SKIP }, () => {
  // Due `D` portano dalla riga azione a quella modello; `R` (→) avanza di una
  // voce nel giro di `MODELS`, cioè da `opus` (il modello dell'azione
  // iniziale `open`) a `sonnet`.
  const frame = captureRowOnly(`${OPEN_DETAIL}DDR\r`);
  assert.match(frame, /--model sonnet/, `←→ non ha cambiato modello: ${frame}`);
});

test('detail: la riga hint non nomina i tasti standard', { skip: SKIP }, () => {
  // Sulla fixture del detail, su T4 (`DDDDD⏎`): una task col suo file ma senza
  // DLV, che il detail apre sull'area di compilazione con la riga modello e la
  // sua hint, e sotto il testo del task file.
  const { proj, env } = detailProject();
  const frame = lastFrame(capture('DDDDD\r', proj, env));
  assert.match(frame, /\[ opus \]/, `riga modello non renderizzata: ${frame}`);
  // L'asserzione negativa vive sulla SOLA riga hint, non sul frame: sotto c'è il
  // testo del task file, che di quei glifi può parlare quanto vuole.
  const hint = frame.split('\n').find((l) => l.includes('PgUp/PgDn'));
  assert.ok(hint, `riga hint non renderizzata: ${frame}`);
  // `↑↓`, `←→`, `⏎` ed `esc` dentro un'area a righe fanno la cosa attesa: la
  // riga hint esiste per ciò che NON si deduce.
  for (const std of ['↑↓', '←→', '⏎', 'esc']) {
    assert.ok(!hint.includes(std), `la hint nomina ancora ${std}: ${hint}`);
  }
});
