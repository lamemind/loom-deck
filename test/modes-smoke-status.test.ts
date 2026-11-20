// T232 — gate dei modi (vedi `modes-smoke.test.ts`): il project status — il
// viewer della cache, la testata e la generazione.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CTRL_G, CTRL_O, PROJECT, SKIP } from './pty-harness.js';
import { STATUS_ENV, capture, lastFrame } from './modes-kit.js';

// ── T121 · project status ─────────────────────────────────────────────────

test('^O senza cache lo dice invece di aprire un viewer vuoto', { skip: SKIP }, () => {
  // Il file non esiste: la cache assente è uno STATO del progetto, non un
  // documento da mostrare — un viewer vuoto direbbe «il recap è questo, ed è
  // nulla».
  const frame = lastFrame(
    capture(CTRL_O, PROJECT, { LOOM_DECK_STATUS_FILE: join(tmpdir(), 'loom-deck-mai-scritto.md') }),
  );
  assert.match(frame, /nessun recap in cache/i, `nessuna nota di inerzia: ${frame}`);
  assert.match(frame, /t 💻/, `il viewer si è aperto a vuoto: ${frame}`);
});

test('^O mostra il testo della cache, non un rigenerato', { skip: SKIP }, () => {
  const frame = lastFrame(capture(CTRL_O, PROJECT, STATUS_ENV));
  assert.match(frame, /Due task aperte|Due .*task.* aperte/i, `testo della cache assente: ${frame}`);
  assert.match(frame, /generato alle \d\d:\d\d/i, `nessuna ora di generazione: ${frame}`);
});

test('la testata mostra missing finché non c\'è cache', { skip: SKIP }, () => {
  const frame = lastFrame(
    capture('', PROJECT, { LOOM_DECK_STATUS_FILE: join(tmpdir(), 'loom-deck-mai-scritto.md') }),
  );
  assert.match(frame, /PROJECT STATUS \[ missing \]/, `stato missing non renderizzato: ${frame}`);
});

test('la testata mostra l\'ora quando la cache c\'è', { skip: SKIP }, () => {
  // Il recap sopravvive alla chiusura del deck: qui il processo nasce con la
  // cache già sul disco, che è esattamente la condizione di un deck riaperto.
  const frame = lastFrame(capture('', PROJECT, STATUS_ENV));
  assert.match(frame, /PROJECT STATUS \[ \d\d:\d\d \]/, `ora non renderizzata: ${frame}`);
});

test('^G avvia la generazione e la testata la conta', { skip: SKIP }, () => {
  // Con NO_SPAWN il figlio è inerte e non chiude mai: lo stato resta `building`,
  // che è ciò che questo scenario deve osservare.
  const frame = lastFrame(capture(CTRL_G, PROJECT, STATUS_ENV));
  assert.match(frame, /building \d+\.\.\./, `nessun contatore in testata: ${frame}`);
});

test('un secondo ^G non spawna una seconda generazione', { skip: SKIP }, () => {
  const frame = lastFrame(capture(CTRL_G + CTRL_G, PROJECT, STATUS_ENV));
  assert.match(frame, /generazione già in corso/i, `il secondo ^G non è stato rifiutato: ${frame}`);
});

test('il viewer scorre a riga e a pagina', { skip: SKIP }, () => {
  // Una cache più alta del terminale: con un recap corto la posizione non si
  // muove e lo scenario passerebbe senza provare niente.
  const long = join(mkdtempSync(join(tmpdir(), 'loom-deck-status-')), 'lungo.md');
  writeFileSync(
    long,
    Array.from({ length: 200 }, (_, i) => `riga numero ${i} del recap`).join('\n'),
  );
  const env = { LOOM_DECK_STATUS_FILE: long };

  const start = lastFrame(capture(CTRL_O, PROJECT, env));
  assert.match(start, /righe 1-\d+ di 200/, `posizione iniziale assente: ${start}`);

  const oneDown = lastFrame(capture(`${CTRL_O}D`, PROJECT, env));
  assert.match(oneDown, /righe 2-\d+ di 200/, `↑↓ non scorre di una riga: ${oneDown}`);

  // `>` = PagDn nella mappa di `pty-frame.py`: una pagina intera, quindi la
  // prima riga salta di quanto è alta la finestra invece che di uno.
  const onePage = lastFrame(capture(`${CTRL_O}>`, PROJECT, env));
  const at = onePage.match(/righe (\d+)-/);
  assert.ok(at && Number(at[1]) > 2, `PagDn non ha scorso una pagina: ${onePage}`);
});

test('^O durante una generazione apre la cache vecchia e lo dichiara', {
  skip: SKIP,
}, () => {
  // D3 — la generazione dura minuti, quindi la finestra in cui questo caso
  // capita è larga: leggere un recap di un'ora fa è quasi sempre meglio che non
  // leggere niente, purché il viewer non lo spacci per l'ultimo.
  const frame = lastFrame(capture(CTRL_G + CTRL_O, PROJECT, STATUS_ENV));
  assert.match(frame, /versione precedente/i, `il viewer non dichiara lo stale: ${frame}`);
});

test('^G e ^O sono inerti dentro un modo capturing', { skip: SKIP }, () => {
  // Come `^K`/`^P`/`^R`: chi è dentro il detail non deve poter far partire una
  // generazione da minuti con un tasto pensato per un'altra schermata.
  const frame = lastFrame(capture(`DD\r${CTRL_G}`, PROJECT, STATUS_ENV));
  assert.doesNotMatch(frame, /building \d+/, `^G ha generato dal detail: ${frame}`);
  assert.match(frame, /preflight|checkpoint/i, `il detail si è chiuso: ${frame}`);
});
