// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il click sulle liste, che
// porta fuoco e selezione, e il tracking del mouse acceso e spento.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CTRL_C, SKIP } from './pty-harness.js';
import { capture, captureRaw, lastFrame } from './modes-kit.js';

// ── T21 · mouse (mandata 3: focus via click sulle liste) ──────────────────
//
// Le righe non sono indovinate: il frame è ancorato a riga 1 e sopra i pane
// tutto è incondizionato in modalità normale, quindi l'header con le viste sta
// a riga 7, il corpo del pane sessioni da riga 8, la lista task da riga 9 (la
// riga 8 del pane task è `sort:`). Ogni scenario legge il BERSAGLIO dal frame
// di partenza e lo confronta con la selezione dopo il click: un conto delle
// righe sbagliato non passa per caso, perché il caret finirebbe su un'altra
// riga con un altro id.

/** L'id task della riga `n` (1-based) del frame, paddato come a schermo. */
function taskIdAtRow(frame: string, n: number): string {
  const line = frame.split('\n')[n - 1] ?? '';
  const m = line.match(/│ │\s+(T ?\d+)/);
  assert.ok(m, `nessuna task a riga ${n}: ${line}`);
  return m[1]!;
}

/** L'hash della conversazione sulla riga `n`: otto esadecimali, che il pane
 *  task non porta mai. */
function sessionAtRow(frame: string, n: number): string {
  const line = frame.split('\n')[n - 1] ?? '';
  const m = line.match(/([0-9a-f]{8})/);
  assert.ok(m, `nessuna conversazione a riga ${n}: ${line}`);
  return m[1]!;
}

const selectedTask = (f: string) => {
  const m = f.match(/▸ (T ?\d+)/);
  assert.ok(m, `nessuna task selezionata nel frame: ${f}`);
  return m[1];
};

/**
 * La riga `n` (1-based) porta il caret del pane TASK, cioè una task selezionata.
 *
 * L'ancora è il bordo del pane (`│ │`) subito prima del caret: il pane sessioni
 * disegna il proprio caret sulla stessa riga di schermo, e un `▸` cercato nudo
 * matcherebbe quello.
 *
 * Serve a misurare la selezione DENTRO un solo frame. Confrontare la task
 * selezionata dopo il click con quella letta in una cattura PRECEDENTE lega
 * l'esito a due deck diversi: la lista è ordinata anche per data di commit
 * (`useCommitTimes`), che arriva da uno spawn di `git log` asincrono, quindi
 * fra i due avvii l'ordine può differire e la riga 13 portare un'altra task.
 * Non è un difetto del click, ed è un rosso che compare solo quando la macchina
 * è carica — cioè quando la suite intera gira in parallelo.
 */
function assertTaskCaretAtRow(frame: string, n: number, what: string) {
  const line = frame.split('\n')[n - 1] ?? '';
  assert.match(line, /^│ │ *▸ *T ?\d+/, `${what} (riga ${n}): ${frame}`);
}

test('click su una riga task la seleziona senza aprire il detail', { skip: SKIP }, () => {
  // Riga 13 = terza task della finestra (9 `≡`, 10 `○`, 11 prima task).
  const after = lastFrame(capture('@10,13;'));
  assertTaskCaretAtRow(after, 13, 'il caret non è sulla riga cliccata');
  // D2: solo fuoco. La lista è ancora a schermo e `⏎` aprirebbe il detail ora.
  assert.match(after, /t 💻/, `il click ha lasciato la lista: ${after}`);
  // Il fuoco si legge da `N`: dal pane task rifiuta con una nota.
  const refused = lastFrame(capture('@10,13;N'));
  assert.match(refused, /seleziona una sessione/, `il fuoco non è sul pane task: ${refused}`);
});

test('click su una riga meta riporta la selezione su di lei', { skip: SKIP }, () => {
  // Da una task (tre `↓`) si torna su `○ spot` (riga 10) con un click.
  const frame = lastFrame(capture('DDD@10,10;'));
  assert.match(frame, /▸ ○ spot/, `la riga spot non è selezionata: ${frame}`);
});

test('click sulla riga sort del pane task è inerte', { skip: SKIP }, () => {
  // Tre `↓` da `≡` (riga 9) portano il caret a riga 12; il click sulla riga
  // `sort:` non deve spostarlo. Si misura la RIGA e non l'id della task: quale
  // task ci sia a riga 12 dipende dall'ordinamento, che il click non tocca.
  assertTaskCaretAtRow(lastFrame(capture('DDD@10,8;')), 12, 'il click sulla riga sort ha mosso il caret');
});

test('click su una conversazione porta fuoco e selezione sul pane sessioni', { skip: SKIP }, () => {
  // Riga 10 = terza conversazione (il corpo del pane sessioni parte da riga 8).
  // Colonna 70: dentro il pane destro a qualunque larghezza ≥ 100.
  const after = lastFrame(capture('@70,10;'));
  const line = after.split('\n')[9] ?? '';
  const target = sessionAtRow(after, 10);
  // Il caret precede l'hash sulla stessa riga senza un bordo in mezzo: il
  // caret del pane task, a sinistra, è separato da `│ │`.
  assert.match(line, new RegExp(`▸[^│]*${target}`), `il caret non è sulla conversazione cliccata: ${line}`);
  // Il fuoco si legge da `N`: dal pane sessioni apre il campo del titolo (`✎`).
  const opened = lastFrame(capture('@70,10;N'));
  assert.match(opened, /✎ ›/, `il fuoco non è passato al pane sessioni: ${opened}`);
});

test('click su una voce dell\'header attiva quella vista', { skip: SKIP }, () => {
  // La colonna di `nascoste` si legge dal frame: tutto ciò che la precede sulla
  // riga 7 è largo 1, quindi indice + 1 = colonna. Scriverla come numero sarebbe
  // un calco della larghezza di `Tasks (N/M)`, che cambia con le task.
  const line = lastFrame(capture('')).split('\n')[6] ?? '';
  const at = line.indexOf('nascoste');
  assert.ok(at > 0, `la voce nascoste non è nell'header: ${line}`);
  const after = lastFrame(capture(`@${at + 1},7;`));
  assert.match(after, /vista task: \d+ nascoste/, `la vista non è cambiata: ${after}`);
});

test('click sulla vista già attiva non muove la selezione', { skip: SKIP }, () => {
  // `Tasks` comincia a colonna 5 (bordo + padding del pane): un click lì con
  // una task selezionata deve lasciarla dov'è, non riportarla su `≡ tutte`.
  assertTaskCaretAtRow(lastFrame(capture('DDD@6,7;')), 12, 'il click sulla vista attiva ha mosso il caret');
});

test('secondo click sulla task già selezionata apre il detail, come ⏎', { skip: SKIP }, () => {
  // Il primo click seleziona e mette a fuoco, il secondo — stessa riga, pane
  // già a fuoco — sintetizza `⏎`. Niente doppio-click a timer (D2): sono due
  // click qualsiasi, comunque distanti nel tempo.
  const target = taskIdAtRow(lastFrame(capture('')), 13).replace(/ /g, ' ?');
  const after = lastFrame(capture('@10,13;@10,13;'));
  assert.match(after, /righe \d+-\d+ di \d+/, `il detail non si è aperto: ${after}`);
  assert.match(after, new RegExp(target), `il detail non è della task cliccata: ${after}`);
});

/**
 * T229 — progetto SINTETICO con cinque conversazioni ferme, per i click sulla
 * lista conversazioni che devono riprenderne una.
 *
 * Sul cappello vero la riga cliccata è quella che capita: una conversazione
 * viva, o col turno headless in corso — anche quella della sessione che lancia
 * la suite —, su cui il secondo click porta davanti la tab o scrive la nota
 * del turno in corso, e il resume giustamente non parte. Qui `HOME` è
 * dirottato: nessun registro dei vivi, nessuno stato headless, e cinque
 * transcript bastano a riempire la riga 10 del frame (la terza riga del pane).
 * Gli id sono UUID veri perché `sessionAtRow` cerca otto cifre esadecimali.
 */
function clickSessionsProject(): { proj: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-clicksessions-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'runtime', 'tasks'), { recursive: true });
  writeFileSync(
    join(proj, 'runtime', 'tasks.md'),
    ['# Tasks', '', '## Tasks Overview', '', '| ID | Pri | Prog | Task |', '| --- | --- | --- | --- |'].join(
      '\n',
    ) + '\n',
  );
  const projects = join(root, 'home', '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    const sid = `0000000${i}-1111-4222-8333-44445555666${i}`;
    const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 10, i, s)).toISOString();
    writeFileSync(
      join(projects, `${sid}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: sid,
          cwd: proj,
          timestamp: at(0),
          message: { role: 'user', content: `conversazione ${i}` },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: sid,
          cwd: proj,
          timestamp: at(1),
          message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] },
        }),
      ].join('\n') + '\n',
    );
  }
  return { proj, env: { HOME: join(root, 'home') } };
}

test('secondo click sulla conversazione già selezionata fa il resume, come ⏎', { skip: SKIP }, () => {
  // Il bersaglio si legge dallo STESSO frame in cui si misura l'esito: la lista
  // conversazioni è ordinata su dati che arrivano asincroni, quindi la riga 10
  // di un secondo avvio del deck può portare un'altra conversazione.
  //
  // T229 — su un progetto sintetico di sole conversazioni ferme: il resume è
  // l'esito del secondo click solo su una conversazione che non è viva e non
  // ha un turno headless in corso (`enterSession`).
  //
  // L'hash sopravvive nella riga di stato perché `resumeArgs` tiene
  // `--resume <uuid>` in CODA all'argv, dove il taglio al mezzo non arriva. Con
  // `--title-note` in fondo — argomento a lunghezza libera — bastava un titolo
  // di conversazione lungo perché l'elisione si mangiasse proprio l'hash, e il
  // test cadeva su un resume partito correttamente.
  const { proj, env } = clickSessionsProject();
  const after = lastFrame(capture('@70,10;@70,10;', proj, env));
  const target = sessionAtRow(after, 10);
  assert.match(
    after,
    new RegExp(`--resume ${target}`),
    `il resume non è partito sulla conversazione cliccata: ${after}`,
  );
});

test('secondo click su una riga meta già selezionata resta solo fuoco', { skip: SKIP }, () => {
  // `⏎` su una riga meta non fa nulla: sintetizzarlo produrrebbe la nota di
  // scarto. Il deck deve restare sulla lista, senza note.
  const after = lastFrame(capture('@10,9;@10,9;'));
  assert.match(after, /▸ ≡ tutte le sessioni/, `la selezione ha lasciato la riga meta: ${after}`);
  assert.match(after, /t 💻/, `il click ha lasciato la lista: ${after}`);
  assert.doesNotMatch(after, /⏎ → /, `il click ha prodotto una nota di scarto: ${after}`);
});

test('il tracking si accende all\'avvio e si spegne all\'uscita', { skip: SKIP }, () => {
  // Un tracking lasciato acceso non è cosmetico: il terminale continua a
  // mandare sequenze a chi prende il posto del deck, che le stampa come testo.
  // Si misura sui BYTE, non sul frame — `stripAnsi` cancellerebbe la prova.
  const raw = captureRaw(CTRL_C + CTRL_C);
  assert.match(raw, /\x1b\[\?1000h/, 'il tracking non è stato acceso');
  assert.match(raw, /\x1b\[\?1006h/, 'la modalità SGR non è stata accesa');
  const off = raw.lastIndexOf('\x1b[?1000l');
  assert.ok(off > raw.indexOf('\x1b[?1000h'), 'il tracking non è stato spento all\'uscita');
});
