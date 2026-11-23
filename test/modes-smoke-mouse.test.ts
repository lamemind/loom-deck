// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il mouse sulla riga launch
// e la rotella nei contenuti lunghi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT, SKIP } from './pty-harness.js';
import { alive, capture, lastFrame } from './modes-kit.js';
import { detailProject } from './detail-fixture.js';
import { loadLaunch } from '../src/config.js';
import { launchRow } from '../src/frame.js';

// ── T21 · mouse (mandata 1: superfici della riga launch) ──────────────────

/**
 * Click su una colonna della riga launch, che sta a riga 4 del terminale.
 *
 * `t 💻` comincia a colonna 3 (bordo + padding) — quella non si muove. `c 🤖`
 * invece è il blocco selettore della nuda, ancorato al bordo DESTRO (T154/P9):
 * la sua colonna dipende dalle voci `launch` del progetto e dalla larghezza
 * del terminale, quindi si CALCOLA con la stessa `launchRow` che il deck usa,
 * non si indovina — un bersaglio spostato non passa silenziosamente solo
 * perché ogni scenario asserisce anche l'esito dell'azione.
 */
const clickLaunch = (col: number) => `@${col},4;`;

// 120 colonne: la stessa dimensione fissa con cui `captureRaw` apre il pty.
const projectLaunchRow = () => launchRow(loadLaunch(PROJECT), 120);

test('click su `t 💻` apre il terminale, come il tasto t', { skip: SKIP }, () => {
  const captured = capture(clickLaunch(4));
  assert.ok(alive(captured), 'il deck è morto sul click');
  assert.match(lastFrame(captured), /terminale su/i, 'il click non ha attivato la surface t');
});

test('click su `c 🤖` spawna la sessione, come il tasto c', { skip: SKIP }, () => {
  const bareCol = projectLaunchRow().regions.find((r) => r.key === 'c')!.start;
  const frame = lastFrame(capture(clickLaunch(bareCol)));
  assert.match(frame, /deck-run/, `il click non ha attivato la surface c: ${frame}`);
});

test('un click su un bottone modello del blocco nuda è inerte: nessun tasto lo nomina', {
  skip: SKIP,
}, () => {
  // P9 — solo l'etichetta `c 🤖` è cliccabile: `m` cicla, non seleziona, quindi
  // un bottone non ha un tasto da sintetizzare.
  //
  // Sul progetto SINTETICO, con `HOME` dirottato: l'asserzione legge il frame
  // intero, e sul cappello vero `deck-run` compare anche nel titolo di una
  // task o nell'anteprima di una conversazione (la riga T217 «Deck: deck-run
  // rifiuta…» lo faceva scattare senza nessun click attivo). Qui task e
  // conversazioni sono del test. La colonna si calcola dalle voci `launch`
  // dello stesso progetto su cui gira il deck.
  const { proj, env } = detailProject();
  const bare = launchRow(loadLaunch(proj), 120).regions.find((r) => r.key === 'c')!;
  const frame = lastFrame(capture(clickLaunch(bare.end + 2), proj, env));
  assert.match(frame, /c 🤖/, `il deck non ha disegnato la riga launch: ${frame}`);
  assert.doesNotMatch(frame, /deck-run|terminale su/i, `un bottone ha risposto al click: ${frame}`);
});

test('lo spazio fra due superfici non attiva la vicina', { skip: SKIP }, () => {
  // Colonna 8: il separatore fra `t 💻` e la prima voce `launch`. Un hit-test
  // che arrotondasse al segmento più vicino lancerebbe un'azione che nessuno
  // ha chiesto. La voce `codium` compare comunque nella riga launch STATICA —
  // l'asserzione deve leggere la nota di un'azione partita, non il testo della
  // legenda che è sempre a schermo.
  const frame = lastFrame(capture(clickLaunch(8)));
  assert.doesNotMatch(frame, /terminale su/i, `il separatore ha attivato t: ${frame}`);
  assert.doesNotMatch(frame, /→ codium su/i, `il separatore ha attivato la voce launch: ${frame}`);
});

test('un click fuori dalla riga launch è inerte', { skip: SKIP }, () => {
  // Mandata 1: le liste non sono cliccabili. Riga 6 è dentro il pane task.
  const frame = lastFrame(capture('@4,6;'));
  assert.doesNotMatch(frame, /terminale su/i, `una riga estranea ha attivato t: ${frame}`);
});

test('col modale aperto il click non scrive nel campo né attiva la surface', {
  skip: SKIP,
}, () => {
  // Due difetti in uno scenario. ① `useInput` riceve le sequenze come TESTO:
  // senza il filtro incondizionato, un click battuto col modale aperto ci
  // scriverebbe dentro `[<0;5;3M`. ② La riga launch NON è a schermo in un modo
  // capturing, quindi la superficie che occupava quelle colonne non deve
  // rispondere lo stesso.
  const frame = lastFrame(capture(`C${clickLaunch(4)}`));
  assert.match(frame, /C ›/, `il modale create non è aperto: ${frame}`);
  assert.doesNotMatch(frame, /\[</, `la sequenza mouse è finita nel campo: ${frame}`);
  assert.doesNotMatch(frame, /terminale su/i, `il click ha attivato t dal modale: ${frame}`);
});

// ── T21 · mouse (mandata 2: rotella nei contenuti lunghi) ─────────────────

/** Una tacca di rotella: `^` su, `_` giù nella mappa di `pty-frame.py`. Le
 *  coordinate sono irrilevanti per il deck — la rotella scorre il modo, non un
 *  punto — ma il driver le emette perché un terminale le manda sempre. */
const WHEEL_UP = '^10,10;';
const WHEEL_DOWN = '_10,10;';

/** La finestra `righe A-B di N` del viewer in cui si è scorso. */
function linesAt(frame: string): number {
  const m = frame.match(/righe (\d+)-\d+ di \d+/);
  assert.ok(m, `nessun indicatore di posizione nel frame: ${frame}`);
  return Number(m[1]);
}

test('nel detail la rotella scorre il testo, non il fuoco fra i campi', { skip: SKIP }, () => {
  // T117: `↑↓` nel detail muovono il fuoco fra le quattro righe dell'area di
  // compilazione. Una rotella che sintetizzasse `↓` sposterebbe il fuoco e
  // lascerebbe il testo fermo — il contrario di quello che la mano ha chiesto.
  //
  // T252 — sul progetto SINTETICO, su T4 (`DDDDD⏎`): senza DLV il detail si
  // apre sull'area di compilazione, col fuoco sulla riga azione. Sul cappello
  // vero si apriva la prima task di `tasks.md`, e sulla lista dei DLV quando
  // quella task ne aveva di aperti. Le tre catture leggono soltanto, quindi
  // condividono il progetto.
  const { proj, env } = detailProject();
  const start = lastFrame(capture('DDDDD\r', proj, env));
  const after = lastFrame(capture(`DDDDD\r${WHEEL_DOWN}`, proj, env));
  assert.equal(linesAt(start), 1);
  assert.equal(linesAt(after), 4, `il testo del detail non è scorso: ${after}`);
  // Una giù e una su: la rotella torna indietro di tre righe, e non è un
  // `PgUp` travestito.
  const back = lastFrame(capture(`DDDDD\r${WHEEL_DOWN}${WHEEL_UP}`, proj, env));
  assert.equal(linesAt(back), 1, `una tacca su non ha riavvolto tre righe: ${back}`);
  // Il fuoco è ancora sulla riga `azione`, che porta il caret; `↓` l'avrebbe
  // spostato sulla riga del prompt.
  assert.match(after, /▸ azione/, `il fuoco ha lasciato la riga azione: ${after}`);
});

test('sulla lista la rotella non muove la selezione', { skip: SKIP }, () => {
  // D5: la rotella scorre testo, mai una scelta. La riga col caret deve restare
  // la stessa dopo due tacche, mentre una `↓` vera la sposta — il secondo
  // confronto è ciò che prova che il metodo vede il movimento.
  // Il caret (`▸`, cioè `CARET` dopo `sanitize`) precede la riga a fuoco in
  // ENTRAMBI i pane: si legge quello seguito da un id task (paddato: `T 94`),
  // che solo il pane task porta. `DD` scende dalle due righe meta alla prima
  // task, o il caret starebbe su `≡ tutte le sessioni` e l'id non ci sarebbe.
  const selRow = (f: string) => {
    const m = f.match(/▸ (T ?\d+)/);
    assert.ok(m, `nessuna task selezionata nel frame: ${f}`);
    return m[1];
  };
  const base = selRow(lastFrame(capture('DD')));
  assert.equal(selRow(lastFrame(capture(`DD${WHEEL_DOWN}${WHEEL_DOWN}`))), base);
  assert.notEqual(selRow(lastFrame(capture('DDD'))), base);
});

test('col modale aperto la rotella non scrive nel campo', { skip: SKIP }, () => {
  // Stesso difetto del click: la sequenza `[<65;10;10M` è TESTO per `useInput`
  // e senza filtro finirebbe nel titolo della task che si sta creando.
  const frame = lastFrame(capture(`C${WHEEL_DOWN}${WHEEL_UP}`));
  assert.match(frame, /C ›/, `il modale create non è aperto: ${frame}`);
  assert.doesNotMatch(frame, /\[<|64;|65;/, `la sequenza rotella è finita nel campo: ${frame}`);
});
