// T232 — gate dei modi (vedi `modes-smoke.test.ts`): l'azione distruttiva
// (`CANC`) e l'uscita a doppio `^C`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANC, CTRL_C, ESC, PROJECT, SKIP } from './pty-harness.js';
import { alive, capture, configProject, lastFrame, singleSessionProject } from './modes-kit.js';

// ── T112 · l'azione distruttiva ───────────────────────────────────────────

// Sul pane sessioni il bersaglio di `CANC` lo decide il FOCUS, come per `⏎`:
// la conferma è quella della CONVERSAZIONE, mai quella della task. Progetto e
// `HOME` finti (`singleSessionProject`): il test non manda `⏎`, ma un transcript
// vero sotto `~/.claude/projects` non deve essere nemmeno raggiungibile.
test('CANC sul pane sessioni apre la conferma della conversazione, non della task', {
  skip: SKIP,
}, () => {
  const { proj, env } = singleSessionProject();
  const frame = lastFrame(capture(`R${CANC}`, proj, env));
  // Le due conferme aprono entrambe con `CANC › eliminare`: le distingue il
  // bersaglio nominato e l'effetto sul disco.
  assert.match(frame, /CANC › eliminare la conversazione sid1/, `la conferma della conversazione non si è aperta: ${frame}`);
  assert.match(frame, /irreversibile/, `la conferma non dice l'effetto: ${frame}`);
  assert.doesNotMatch(frame, /tasks\.md/, `si è aperta la conferma della task: ${frame}`);
});

test('CANC sul pane sessioni vuoto è inerte e lo dice', { skip: SKIP }, () => {
  // Inerzia che si annuncia: un tasto che non fa niente in silenzio si legge
  // come deck bloccato. `HOME` vuota → nessuna conversazione nel progetto.
  const home = mkdtempSync(join(tmpdir(), 'loom-deck-emptyhome-'));
  const frame = lastFrame(capture(`R${CANC}`, configProject(), { HOME: home }));
  assert.doesNotMatch(frame, /CANC ›/, `una conferma si è aperta senza bersaglio: ${frame}`);
  assert.match(frame, /nessuna conversazione da eliminare/i, `nessuna nota di inerzia: ${frame}`);
});

test('esc sulla conferma annulla e lo dice', { skip: SKIP }, () => {
  const frame = lastFrame(capture(`DD${CANC}${ESC}`));
  assert.match(frame, /annullata/i, `nessuna nota di annullamento: ${frame}`);
});

test('la conferma nomina la task e l\'effetto, non la parola "archiviare"', {
  skip: SKIP,
}, () => {
  const frame = lastFrame(capture(`DD${CANC}`));
  // ② gli ID bersaglio: una conferma che non dice COSA sparisce non è informata.
  assert.match(frame, /T\d+/, `nessun ID nella conferma: ${frame}`);
  // ③ l'effetto sul disco, e il fatto che il lavoro resta locale.
  assert.match(frame, /tasks\.md/, `la conferma non nomina l'effetto: ${frame}`);
  assert.match(frame, /nessun push/, `la conferma non dice che resta locale: ${frame}`);
  assert.doesNotMatch(frame, /archiviare/i, `«archiviare» promette un archivio che non esiste`);
});

test('CANC su una riga meta della vista archiviabili prende l\'insieme', {
  skip: SKIP,
}, () => {
  // `TT` porta il pane task sulla vista `archiviabili` e riporta la selezione su
  // `≡ tutte` (il reset di `cycleView`), cioè una riga meta: è la condizione del
  // bulk. Con soglia a 1 giorno l'insieme non è vuoto su un progetto giovane, e
  // il bersaglio è quello che la vista MOSTRA (D6) — la conferma parla di N
  // task, non di una.
  const frame = lastFrame(capture(`TT${CANC}`, PROJECT, { LOOM_DECK_ARCHIVABLE_DAYS: '1' }));
  assert.match(frame, /eliminare \d+ task\?/i, `bulk non riconosciuto: ${frame}`);
});

test('con una task selezionata CANC resta sulla singola, anche su archiviabili', {
  skip: SKIP,
}, () => {
  // La SELEZIONE batte la vista: scesi su una riga task (`DD` dopo il cambio
  // vista), il tasto tocca quella task e basta. È la regola che tiene l'azione
  // di massa lontana un movimento dalle righe task, invece che a zero tasti di
  // distanza — nessuno preme guardando `T91` evidenziata e ne pota altre 25.
  const frame = lastFrame(capture(`TTDD${CANC}`, PROJECT, { LOOM_DECK_ARCHIVABLE_DAYS: '1' }));
  assert.match(frame, /eliminare T\d+\?/i, `il bulk ha scavalcato la selezione: ${frame}`);
  assert.doesNotMatch(frame, /eliminare \d+ task\?/i, `bersaglio di massa su riga task: ${frame}`);
});

test('il bulk nomina le scartate, non solo le potate', { skip: SKIP }, () => {
  // Promettere 7 e farne 5 è una bugia che non compare da nessuna parte: le 2
  // restano in lista come prima, indistinguibili da un fallimento parziale.
  // Su questo repo alcune task folder hanno file ignorati/untracked, quindi lo
  // scarto a monte esiste davvero.
  const frame = lastFrame(capture(`TT${CANC}`, PROJECT, { LOOM_DECK_ARCHIVABLE_DAYS: '1' }));
  assert.match(frame, /scartate|nessuna esclusa/i, `nessuna riga di scarto: ${frame}`);
});

// ── T116 · uscita a doppio ^C ─────────────────────────────────────────────
//
// L'esito qui non è solo il frame: è se il PROCESSO sia sopravvissuto alla
// sequenza, che `pty-frame.py` dichiara in coda (`<<PROC alive|exit=N>>`). Il
// buffer di un deck vivo e quello di un deck appena morto sono indistinguibili
// senza quella riga — l'ultimo frame disegnato è lo stesso.
/** Attesa senza tasti: ogni `W` vale il pump fra due tasti (0.7s), otto
 *  superano la finestra di 5s. */
const WAIT_OVER_WINDOW = 'W'.repeat(8);

test('un ^C solo avverte e NON chiude', { skip: SKIP }, () => {
  const captured = capture(CTRL_C);
  assert.ok(alive(captured), 'il deck si è chiuso alla prima pressione');
  assert.match(lastFrame(captured), /\^C di nuovo entro/i, 'nessun avviso in riga di stato');
});

test('due ^C ravvicinati chiudono il deck', { skip: SKIP }, () => {
  const captured = capture(CTRL_C + CTRL_C);
  assert.match(captured, /<<PROC exit=0>>/, `il deck non si è chiuso: ${lastFrame(captured)}`);
});

test('oltre la finestra il secondo ^C riarma invece di chiudere', { skip: SKIP }, () => {
  // Il cuore della feature: il primo colpo SCADE. Senza questo scenario, un
  // armamento che non si disarma mai passerebbe entrambi i test sopra.
  const captured = capture(CTRL_C + WAIT_OVER_WINDOW + CTRL_C);
  assert.ok(alive(captured), 'la finestra non è scaduta: il secondo ^C ha chiuso');
  assert.match(lastFrame(captured), /\^C di nuovo entro/i, 'il secondo ^C non ha riarmato');
});

test('^C dentro un modale lo chiude e avverte, invece di restare muto', {
  skip: SKIP,
}, () => {
  // Nel detail la riga di stato non è renderizzata: armare restando lì dentro
  // darebbe un deck che sembra ignorare il tasto e poi sparisce senza avviso.
  const captured = capture(`DD\r${CTRL_C}`);
  assert.ok(alive(captured), 'il deck si è chiuso dal detail alla prima pressione');
  const frame = lastFrame(captured);
  assert.match(frame, /\^C di nuovo entro/i, `nessun avviso dopo ^C nel detail: ${frame}`);
  assert.match(frame, /t 💻/, `il detail non si è chiuso: ${frame}`);
});
