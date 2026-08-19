// GATE dei dieci modi — che ognuno si APRA, si navighi e si CHIUDA.
//
// `frame-width.test.ts` misura la larghezza del frame e passa anche se un modo
// non si apre più: è cieco al comportamento per costruzione. Questo gate copre
// esattamente quel buco. Non verifica il layout — verifica che premendo il tasto
// il modo compaia a schermo, che `esc` riporti alla lista, e che i due casi di
// modale-dentro-modale (reader dentro search, `^F` dentro detail) reggano.
//
// Stessa infrastruttura pty del gate di larghezza: Ink renderizza solo su un TTY
// vero. `LOOM_DECK_NO_SPAWN=1` tiene inerti gli spawn — senza, ogni run
// aprirebbe tab Ptyxis reali sulla macchina di chi lancia i test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const PROJECT = dirname(PKG);
const TASKS = join(PROJECT, 'runtime', 'tasks.md');

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = hasPython() && existsSync(TASKS);

const CTRL_F = '\x06';
const ESC = '\x1b';

function capture(keys: string, cwd: string = PROJECT): string {
  const raw = execFileSync(
    'python3',
    [
      join(HERE, 'pty-frame.py'),
      '120',
      '44',
      cwd,
      join(PKG, 'node_modules', '.bin', 'tsx'),
      '--tsconfig',
      join(PKG, 'tsconfig.json'),
      join(PKG, 'src', 'cli.tsx'),
      '--keys',
      keys,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        LOOM_DECK_NO_SPAWN: '1',
        // La docs-root del progetto arriva da qui e non dal file config
        // (`resolveTasksPath` legge `LOOM_DECK_DOCS_ROOT`): senza, il deck
        // cerca `docs/tasks.md`, la lista task è vuota e i modi che richiedono
        // una task selezionata non si aprono affatto.
        LOOM_DECK_DOCS_ROOT: 'runtime',
      },
    },
  );
  return stripAnsi(raw);
}

/**
 * L'ULTIMO frame disegnato, cioè lo stato in cui il deck è rimasto.
 *
 * Il pty accumula ogni redraw e Ink NON emette un clear-screen fra l'uno e
 * l'altro (aggiorna per differenza finché il frame sta sotto `rows`): splittare
 * su `\x1b[2J` restituisce quindi un pezzo arbitrario, non l'ultimo stato.
 * L'ancora affidabile è l'angolo superiore della cornice, che ogni frame
 * completo disegna una volta.
 */
function lastFrame(captured: string): string {
  const at = captured.lastIndexOf('╭');
  return at >= 0 ? captured.slice(at) : captured;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Ogni voce: i tasti da battere e un frammento che DEVE comparire nel frame
// finale. Il frammento è scelto fra ciò che solo quel modo disegna.
const MODES: Array<{ name: string; keys: string; expect: RegExp }> = [
  { name: 'normal', keys: '', expect: /loom-deck/ },
  { name: 'create', keys: 'C', expect: /nuova task|create/i },
  { name: 'sort', keys: 'S', expect: /sort|ordina/i },
  { name: 'filter', keys: 'F', expect: /filtr/i },
  { name: 'search', keys: CTRL_F, expect: /ricerca|hash/i },
  { name: 'detail', keys: 'DD\r', expect: /preflight|checkpoint/i },
  { name: 'note', keys: 'RN', expect: /nota/i },
  { name: 'assign', keys: 'RA', expect: /assegn|detach/i },
  // `DD` prima di `E`: il deck apre su `≡ tutte` (D4), e le righe meta non
  // sono task — `E` lì risponde «nessuna task selezionata», correttamente.
  { name: 'edit', keys: 'DDE', expect: /priorit|progress/i },
];

for (const m of MODES) {
  test(`modo ${m.name}: si apre`, { skip: !CAN_RUN }, () => {
    const frame = capture(m.keys);
    assert.match(frame, m.expect, `il modo ${m.name} non ha disegnato il proprio frame`);
  });
}

// Il reader è l'unico modo che non si apre dalla lista: ci si arriva da dentro
// la ricerca, con `⏎` su una riga occorrenza.
test('modo reader: si apre da dentro la ricerca', { skip: !CAN_RUN }, () => {
  const frame = capture(`${CTRL_F}task\r`);
  // Nel reader la barra dice `esc torna` (alla lista), non `esc chiude`.
  assert.match(frame, /reader|esc torna/i);
});

// I due punti dove la precedenza fra i rami è già stata corretta una volta.
test('esc dal reader torna alla ricerca, non al deck', { skip: !CAN_RUN }, () => {
  // Il reader è un modale DENTRO la ricerca: `esc` smonta uno strato solo, e la
  // lista occorrenze si ritrova com'era. Se smontasse due strati si tornerebbe
  // alla lista task, cioè si perderebbe la ricerca appena fatta.
  const frame = lastFrame(capture(`${CTRL_F}task\r${ESC}`));
  assert.match(frame, /ricerca|hash/i);
});

test('^F dentro il detail apre la ricerca nel testo, non quella conversazioni', {
  skip: !CAN_RUN,
}, () => {
  const frame = lastFrame(capture(`DD\r${CTRL_F}`));
  // La ricerca conversazioni ha il campo `hash`; quella del detail no — e la
  // barra azioni del detail resta a schermo sotto il campo.
  assert.match(frame, /preflight|checkpoint/i);
});

// Gli acceleratori sono inerti dentro il detail: è l'informazione che prima
// viveva solo nell'ordine testuale delle `if`, e che ora `input-modes.ts`
// dichiara. Con NO_SPAWN un `^K` che passasse non aprirebbe una tab, ma
// scriverebbe comunque la sua nota di spawn nella riga di stato.
test('^K dentro il detail non spawna', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r\x0b'));
  assert.doesNotMatch(frame, /\^K spawn/);
  assert.match(frame, /preflight|checkpoint/i);
});

// T111 — l'ALFABETO del detail dopo l'arrivo del campo nota sempre attivo. I
// tre rami che questa task rimuove (cifre → modello, `g`/`G` → estremi) sono
// esattamente quelli che un merge futuro rimetterebbe senza accorgersene.
//
// Lo spawn è l'unico punto in cui il modello scelto e la nota digitata
// diventano osservabili in testo semplice: la riga di stato li nomina entrambi,
// mentre nel frame del detail la voce di modello attiva si distingue solo per
// video inverso, che `stripAnsi` toglie. Con NO_SPAWN il processo non parte, ma
// il sidecar SÌ — da cui il project root temporaneo: i record orfani di un test
// non hanno motivo di finire nel file di chi lo lancia.
const spawnProject = mkdtempSync(join(tmpdir(), 'loom-deck-smoke-'));
if (CAN_RUN) {
  mkdirSync(join(spawnProject, 'runtime', 'tasks'), { recursive: true });
  copyFileSync(TASKS, join(spawnProject, 'runtime', 'tasks.md'));
}

test('detail: una cifra scrive nel campo nota e NON cambia modello', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r2\r', spawnProject));
  assert.match(frame, /«2»/, `la cifra non è finita nella nota: ${frame}`);
  assert.match(frame, /· opus/, `il modello è cambiato con una cifra: ${frame}`);
});

test('detail: tab resta il solo canale del modello', { skip: !CAN_RUN }, () => {
  // `T` = tab nel mapping del pty. Da `opus` (default) il giro porta a `sonnet`.
  const frame = lastFrame(capture('DD\rT\r', spawnProject));
  assert.match(frame, /· sonnet/, `tab non ha cambiato modello: ${frame}`);
});

test('detail: g scrive invece di saltare agli estremi', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\rgg\r', spawnProject));
  assert.match(frame, /«gg»/, `g non è finita nella nota: ${frame}`);
});

test('detail: nota vuota → nessuna maniglia nello spawn', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r\r', spawnProject));
  assert.doesNotMatch(frame, /«»/, `maniglia a vuoto: ${frame}`);
});

test('detail: le cifre sono sparite dalle quadre del selettore modello', { skip: !CAN_RUN }, () => {
  // Un'etichetta che nomina un tasto è accoppiata al binding: `[ 1 fable ]`
  // dopo che `1` scrive nella nota dichiara un tasto che non fa più quella cosa.
  const frame = lastFrame(capture('DD\r'));
  assert.match(frame, /\[ opus \]/, `riga modello non renderizzata: ${frame}`);
  assert.doesNotMatch(frame, /\[ [1-4] /, `cifra superstite nella quadra: ${frame}`);
});

// Chiusura: ogni modale torna alla lista con `esc`, e il deck resta vivo.
for (const m of MODES.filter((x) => x.name !== 'normal')) {
  test(`modo ${m.name}: esc riporta alla lista`, { skip: !CAN_RUN }, () => {
    const frame = lastFrame(capture(`${m.keys}${ESC}`));
    // La riga delle surface built-in esiste SOLO in modalità normale
    // (`launchLine`): è il marcatore che dice «siamo tornati alla lista».
    assert.match(frame, /t 💻/, `${m.name} non è tornato alla lista`);
  });
}
