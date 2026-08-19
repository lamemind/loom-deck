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
/** T112 — `CANC` nella mappa di `pty-frame.py`: la sequenza è di 4 byte e
 *  scritta nuda arriverebbe come quattro tasti separati. */
const CANC = 'K';

function capture(
  keys: string,
  cwd: string = PROJECT,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
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
        ...extraEnv,
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
  // T112 — `DD` porta sulla prima task reale, `CANC` apre la conferma. La
  // conferma NOMINA l'effetto sul disco, non l'etichetta della vista.
  { name: 'purge', keys: `DD${CANC}`, expect: /eliminare/i },
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
  // La riga di stato di uno spawn è il COMANDO: `--prompt-kind` è la sua firma,
  // e non compare in nessun altro punto del frame.
  assert.doesNotMatch(frame, /--prompt-kind/);
  assert.match(frame, /preflight|checkpoint/i);
});

// T111 — l'ALFABETO del detail dopo l'arrivo del campo nota sempre attivo. I
// tre rami che questa task rimuove (cifre → modello, `g`/`G` → estremi) sono
// esattamente quelli che un merge futuro rimetterebbe senza accorgersene.
//
// Lo spawn è l'unico punto in cui il modello scelto e la nota digitata
// diventano osservabili in testo semplice: la riga di stato porta il COMANDO
// esatto, quindi entrambi come argomenti (`--model`, `--title-note`), mentre nel
// frame del detail la voce di modello attiva si distingue solo per video
// inverso, che `stripAnsi` toglie. Con NO_SPAWN il processo non parte, ma
// il sidecar SÌ — da cui il project root temporaneo: i record orfani di un test
// non hanno motivo di finire nel file di chi lo lancia.
//
// La coda del comando sopravvive al taglio anche su un terminale stretto
// (`cutMiddle` sacrifica il mezzo): è ciò che rende queste asserzioni stabili
// nonostante il path assoluto di `deck-run` in testa.
const spawnProject = mkdtempSync(join(tmpdir(), 'loom-deck-smoke-'));
if (CAN_RUN) {
  mkdirSync(join(spawnProject, 'runtime', 'tasks'), { recursive: true });
  copyFileSync(TASKS, join(spawnProject, 'runtime', 'tasks.md'));
}

test('detail: una cifra scrive nel campo nota e NON cambia modello', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r2\r', spawnProject));
  assert.match(frame, /--title-note 2/, `la cifra non è finita nella nota: ${frame}`);
  assert.match(frame, /--model opus/, `il modello è cambiato con una cifra: ${frame}`);
});

test('detail: tab resta il solo canale del modello', { skip: !CAN_RUN }, () => {
  // `T` = tab nel mapping del pty. Da `opus` (default) il giro porta a `sonnet`.
  const frame = lastFrame(capture('DD\rT\r', spawnProject));
  assert.match(frame, /--model sonnet/, `tab non ha cambiato modello: ${frame}`);
});

test('detail: g scrive invece di saltare agli estremi', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\rgg\r', spawnProject));
  assert.match(frame, /--title-note gg/, `g non è finita nella nota: ${frame}`);
});

test('detail: nota vuota → nessun flag di titolo nello spawn', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r\r', spawnProject));
  // `--title-note ''` produrrebbe un `«»` a vuoto nel titolo della tab: il flag
  // dev'essere proprio assente dal comando, non presente e vuoto.
  assert.match(frame, /--prompt-kind/, `lo spawn non è avvenuto: ${frame}`);
  assert.doesNotMatch(frame, /--title-note/, `flag di titolo a vuoto: ${frame}`);
});

test('detail: le cifre sono sparite dalle quadre del selettore modello', { skip: !CAN_RUN }, () => {
  // Un'etichetta che nomina un tasto è accoppiata al binding: `[ 1 fable ]`
  // dopo che `1` scrive nella nota dichiara un tasto che non fa più quella cosa.
  const frame = lastFrame(capture('DD\r'));
  assert.match(frame, /\[ opus \]/, `riga modello non renderizzata: ${frame}`);
  assert.doesNotMatch(frame, /\[ [1-4] /, `cifra superstite nella quadra: ${frame}`);
});

// ── T112 · l'azione distruttiva ───────────────────────────────────────────

test('CANC sul pane sessioni è inerte e lo dice', { skip: !CAN_RUN }, () => {
  // Inerzia che si annuncia, come `F` fuori dalla vista principale: un tasto
  // che non fa niente in silenzio si legge come deck bloccato.
  const frame = lastFrame(capture(`R${CANC}`));
  // `CANC ›` è il TITOLO del modale, non una parola del vocabolario: la nota di
  // inerzia contiene anch'essa «eliminare», quindi cercare quella direbbe che
  // il modale si è aperto ogni volta che il rifiuto è scritto bene.
  assert.doesNotMatch(frame, /CANC ›/, `la conferma si è aperta dal pane sbagliato: ${frame}`);
  assert.match(frame, /seleziona una task/i, `nessuna nota di inerzia: ${frame}`);
});

test('esc sulla conferma annulla e lo dice', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture(`DD${CANC}${ESC}`));
  assert.match(frame, /annullata/i, `nessuna nota di annullamento: ${frame}`);
});

test('la conferma nomina la task e l\'effetto, non la parola "archiviare"', {
  skip: !CAN_RUN,
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
  skip: !CAN_RUN,
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
  skip: !CAN_RUN,
}, () => {
  // La SELEZIONE batte la vista: scesi su una riga task (`DD` dopo il cambio
  // vista), il tasto tocca quella task e basta. È la regola che tiene l'azione
  // di massa lontana un movimento dalle righe task, invece che a zero tasti di
  // distanza — nessuno preme guardando `T91` evidenziata e ne pota altre 25.
  const frame = lastFrame(capture(`TTDD${CANC}`, PROJECT, { LOOM_DECK_ARCHIVABLE_DAYS: '1' }));
  assert.match(frame, /eliminare T\d+\?/i, `il bulk ha scavalcato la selezione: ${frame}`);
  assert.doesNotMatch(frame, /eliminare \d+ task\?/i, `bersaglio di massa su riga task: ${frame}`);
});

test('il bulk nomina le scartate, non solo le potate', { skip: !CAN_RUN }, () => {
  // Promettere 7 e farne 5 è una bugia che non compare da nessuna parte: le 2
  // restano in lista come prima, indistinguibili da un fallimento parziale.
  // Su questo repo alcune task folder hanno file ignorati/untracked, quindi lo
  // scarto a monte esiste davvero.
  const frame = lastFrame(capture(`TT${CANC}`, PROJECT, { LOOM_DECK_ARCHIVABLE_DAYS: '1' }));
  assert.match(frame, /scartate|nessuna esclusa/i, `nessuna riga di scarto: ${frame}`);
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
