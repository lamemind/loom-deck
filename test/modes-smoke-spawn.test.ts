// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il selettore del modello
// della nuda e del resume, e l'alfabeto del detail misurato sull'argv dello
// spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAN_RUN, SKIP, TASKS } from './pty-harness.js';
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
const spawnProject = mkdtempSync(join(tmpdir(), 'loom-deck-smoke-'));
if (CAN_RUN) {
  mkdirSync(join(spawnProject, 'runtime', 'tasks'), { recursive: true });
  copyFileSync(TASKS, join(spawnProject, 'runtime', 'tasks.md'));
}

/** Il detail si apre sulla riga azione; `D` (↓) scende di una riga. */
const DETAIL_TITLE_ROW = '\rDDD';

// ── T154 · il selettore della nuda e il tasto `m` bifronte ───────────────

test('c senza toccare il selettore apre comunque su un modello esplicito (il default)', {
  skip: SKIP,
}, () => {
  const frame = lastFrame(capture('c', spawnProject));
  assert.match(frame, /--no-task/, `c non ha spawnato la nuda: ${frame}`);
  assert.match(frame, /--model opus/, `il default non è stato passato esplicitamente: ${frame}`);
});

test('m senza una riga sessione in fuoco cicla il modello della nuda: c la spawna col valore ciclato', {
  skip: SKIP,
}, () => {
  // Focus di apertura è `tasks` (D4): `m` deve cadere sul bersaglio nuda.
  const frame = lastFrame(capture('mc', spawnProject));
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
  const frame = lastFrame(capture(`DD\rr\r`, spawnProject));
  assert.match(frame, /--prompt .\/loom-works:run-task/, `r non ha selezionato run: ${frame}`);
});

test('detail: una cifra sulla riga azione è inerte, non finisce in un campo', {
  skip: SKIP,
}, () => {
  // Nessuna azione ha `2` per iniziale → il tasto non ha nulla da fare, e con il
  // fuoco su una riga a scelta non esiste un campo dove ricadere.
  const frame = lastFrame(capture('DD\r2\r', spawnProject));
  assert.doesNotMatch(frame, /--title-note/, `la cifra è finita nel titolo: ${frame}`);
  assert.match(frame, /--model opus/, `il modello è cambiato con una cifra: ${frame}`);
});

test('detail: le lettere entrano nel campo solo quando la sua riga è in fuoco', {
  skip: SKIP,
}, () => {
  // `o` è l'iniziale di `open`: sulla riga azione seleziona, sulla riga titolo
  // dev'essere testo. È il caso che distingue il focus-gating da un catch-all.
  const frame = lastFrame(capture(`DD${DETAIL_TITLE_ROW}oro\r`, spawnProject));
  assert.match(frame, /--title-note oro/, `il testo non è finito nel titolo: ${frame}`);
});

test('detail: il prompt modificato a mano è quello che parte', { skip: SKIP }, () => {
  // `r` sceglie run (prompt pre-riempito col template), poi si scende sul campo
  // e si scrive in coda: quello che parte dev'essere il testo MODIFICATO, che
  // nessun `--prompt-kind` saprebbe più descrivere.
  const frame = lastFrame(capture('DD\rrDzz\r', spawnProject));
  assert.match(frame, /--prompt .\/loom-works:run-task T\d+zz./, `prompt non modificato: ${frame}`);
  assert.doesNotMatch(frame, /--prompt-kind/, `kind e prompt insieme: ${frame}`);
});

test('detail: azione open → nessun prompt iniziale allo spawn', { skip: SKIP }, () => {
  // `open` è l'azione di default e il suo campo prompt è vuoto: lo spawn passa
  // `--prompt-kind none`, non un `--prompt ''` — deck-run cadrebbe altrimenti sul
  // proprio default `recap`, cioè su un prompt che nessuno ha chiesto.
  const frame = lastFrame(capture('DD\r\r', spawnProject));
  assert.match(frame, /--prompt-kind none/, `open non ha spawnato a mani nude: ${frame}`);
  assert.doesNotMatch(frame, /--title-note/, `flag di titolo a vuoto: ${frame}`);
});

test('detail: tab alterna i due modi senza toccare il modello', { skip: SKIP }, () => {
  // `T` = tab nel mapping del pty. T189 gli dà un binding — alterna area di
  // compilazione e lista DLV — ma il modello resta un dato dei campi: si cambia
  // con `←→` dalla sua riga, e `tab` non deve muoverlo di nascosto. Due `tab`
  // tornano ai campi, e `⏎` parte col modello dell'azione iniziale.
  const frame = lastFrame(capture('DD\rTT\r', spawnProject));
  assert.match(frame, /--model opus/, `tab ha cambiato modello: ${frame}`);
});

test('detail: la riga modello risponde a ←→ quando è in fuoco', { skip: SKIP }, () => {
  // Due `D` portano dalla riga azione a quella modello; `R` (→) avanza di una
  // voce nel giro di `MODELS`, cioè da `opus` (il modello dell'azione
  // iniziale `open`) a `sonnet`.
  const frame = lastFrame(capture('DD\rDDR\r', spawnProject));
  assert.match(frame, /--model sonnet/, `←→ non ha cambiato modello: ${frame}`);
});

test('detail: la riga hint non nomina i tasti standard', { skip: SKIP }, () => {
  // T252 — sul progetto SINTETICO, su T4 (`DDDDD⏎`): senza DLV il detail si
  // apre sull'area di compilazione, con la riga modello e la sua hint. Sul
  // cappello vero si apriva la prima task di `tasks.md`, e sulla lista dei DLV
  // quando quella task ne aveva di aperti.
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
