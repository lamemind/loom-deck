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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
/** T121 — le due attivazioni del project status: genera e apri. */
const CTRL_G = '\x07';
const CTRL_O = '\x0f';

function capture(
  keys: string,
  cwd: string = PROJECT,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return stripAnsi(captureRaw(keys, cwd, extraEnv));
}

/** I byte come sono usciti dal pty. Serve solo a chi misura le SEQUENZE invece
 *  del testo — il tracking mouse acceso e poi ripristinato (T21), che
 *  `stripAnsi` cancellerebbe insieme al resto. */
function captureRaw(
  keys: string,
  cwd: string = PROJECT,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return execFileSync(
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
}

/**
 * L'ULTIMO frame INTERO disegnato, cioè lo stato in cui il deck è rimasto.
 *
 * Il pty accumula ogni redraw e Ink NON emette un clear-screen fra l'uno e
 * l'altro (aggiorna per differenza finché il frame sta sotto `rows`): splittare
 * su `\x1b[2J` restituisce quindi un pezzo arbitrario, non l'ultimo stato.
 * L'ancora sono i due angoli della cornice, che ogni frame completo disegna una
 * volta ciascuno.
 *
 * Si prende l'ultima APERTURA che ha una chiusura dopo di sé, non l'ultima in
 * assoluto: il deck ridisegna anche mentre la cattura si sta chiudendo, quindi
 * l'ultima apertura può appartenere a un redraw scritto a metà — e un frammento
 * si legge come «il modo non ha disegnato la sua riga».
 */
function lastFrame(captured: string): string {
  const end = captured.lastIndexOf('╰');
  if (end < 0) return captured;
  const at = captured.lastIndexOf('╭', end);
  return at >= 0 ? captured.slice(at, end + 1) : captured;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * T121 — cache del project status a coordinata NOTA, così il viewer si apre
 * senza spendere una generazione vera (che dura minuti e passa da una sessione
 * Claude). L'env override è il canale previsto per questo: l'unica alternativa
 * sarebbe uno scenario che non prova nulla, perché su un deck appena avviato
 * `^O` risponde «nessun recap in cache».
 */
const statusCache = join(mkdtempSync(join(tmpdir(), 'loom-deck-status-')), 'recap.md');
if (CAN_RUN) {
  writeFileSync(
    statusCache,
    '# Stato del progetto\n\nDue **task** aperte, una in `preflight`.\n',
  );
}
const STATUS_ENV = { LOOM_DECK_STATUS_FILE: statusCache };

// Ogni voce: i tasti da battere e un frammento che DEVE comparire nel frame
// finale. Il frammento è scelto fra ciò che solo quel modo disegna.
const MODES: Array<{ name: string; keys: string; expect: RegExp; env?: NodeJS.ProcessEnv }> = [
  // T121/D1 — `loom-deck` non è più nella cornice: la testata porta il project
  // status, e questo è ciò che dice «il deck ha disegnato il suo frame».
  { name: 'normal', keys: '', expect: /PROJECT STATUS/ },
  // Il viewer del recap: la sua riga hint è l'unica che nomina insieme pagina ed
  // estremi.
  { name: 'status', keys: CTRL_O, expect: /g\/G estremi/i, env: STATUS_ENV },
  { name: 'create', keys: 'C', expect: /nuova task|create/i },
  { name: 'sort', keys: 'S', expect: /sort|ordina/i },
  { name: 'filter', keys: 'F', expect: /filtr/i },
  { name: 'search', keys: CTRL_F, expect: /ricerca|hash/i },
  { name: 'detail', keys: 'DD\r', expect: /preflight|checkpoint/i },
  // T111 ha rinominato il concetto in «titolo della conversazione»: l'attesa
  // deve citare ciò che la barra disegna oggi, non il nome di prima.
  { name: 'note', keys: 'RN', expect: /titolo conversazione/i },
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
    const frame = capture(m.keys, PROJECT, m.env);
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

test('detail: la riga azione risponde alle lettere e riscrive il prompt', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture(`DD\rr\r`, spawnProject));
  assert.match(frame, /--prompt .\/loom-works:run-task/, `r non ha selezionato run: ${frame}`);
});

test('detail: una cifra sulla riga azione è inerte, non finisce in un campo', {
  skip: !CAN_RUN,
}, () => {
  // Nessuna azione ha `2` per iniziale → il tasto non ha nulla da fare, e con il
  // fuoco su una riga a scelta non esiste un campo dove ricadere.
  const frame = lastFrame(capture('DD\r2\r', spawnProject));
  assert.doesNotMatch(frame, /--title-note/, `la cifra è finita nel titolo: ${frame}`);
  assert.match(frame, /--model opus/, `il modello è cambiato con una cifra: ${frame}`);
});

test('detail: le lettere entrano nel campo solo quando la sua riga è in fuoco', {
  skip: !CAN_RUN,
}, () => {
  // `o` è l'iniziale di `open`: sulla riga azione seleziona, sulla riga titolo
  // dev'essere testo. È il caso che distingue il focus-gating da un catch-all.
  const frame = lastFrame(capture(`DD${DETAIL_TITLE_ROW}oro\r`, spawnProject));
  assert.match(frame, /--title-note oro/, `il testo non è finito nel titolo: ${frame}`);
});

test('detail: il prompt modificato a mano è quello che parte', { skip: !CAN_RUN }, () => {
  // `r` sceglie run (prompt pre-riempito col template), poi si scende sul campo
  // e si scrive in coda: quello che parte dev'essere il testo MODIFICATO, che
  // nessun `--prompt-kind` saprebbe più descrivere.
  const frame = lastFrame(capture('DD\rrDzz\r', spawnProject));
  assert.match(frame, /--prompt .\/loom-works:run-task T\d+zz./, `prompt non modificato: ${frame}`);
  assert.doesNotMatch(frame, /--prompt-kind/, `kind e prompt insieme: ${frame}`);
});

test('detail: azione open → nessun prompt iniziale allo spawn', { skip: !CAN_RUN }, () => {
  // `open` è l'azione di default e il suo campo prompt è vuoto: lo spawn passa
  // `--prompt-kind none`, non un `--prompt ''` — deck-run cadrebbe altrimenti sul
  // proprio default `recap`, cioè su un prompt che nessuno ha chiesto.
  const frame = lastFrame(capture('DD\r\r', spawnProject));
  assert.match(frame, /--prompt-kind none/, `open non ha spawnato a mani nude: ${frame}`);
  assert.doesNotMatch(frame, /--title-note/, `flag di titolo a vuoto: ${frame}`);
});

test('detail: tab non è più il canale del modello', { skip: !CAN_RUN }, () => {
  // `T` = tab nel mapping del pty. Il modello si cambia con `←→` dalla sua riga;
  // `tab` resta senza binding e non deve muovere nulla di nascosto.
  const frame = lastFrame(capture('DD\rT\r', spawnProject));
  assert.match(frame, /--model opus/, `tab ha cambiato modello: ${frame}`);
});

test('detail: la riga modello risponde a ←→ quando è in fuoco', { skip: !CAN_RUN }, () => {
  // Due `D` portano dalla riga azione a quella modello; `R` (→) avanza da `opus`
  // a `sonnet`.
  const frame = lastFrame(capture('DD\rDDR\r', spawnProject));
  assert.match(frame, /--model sonnet/, `←→ non ha cambiato modello: ${frame}`);
});

test('detail: la riga hint non nomina i tasti standard', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture('DD\r'));
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

// ── T116 · uscita a doppio ^C ─────────────────────────────────────────────
//
// L'esito qui non è solo il frame: è se il PROCESSO sia sopravvissuto alla
// sequenza, che `pty-frame.py` dichiara in coda (`<<PROC alive|exit=N>>`). Il
// buffer di un deck vivo e quello di un deck appena morto sono indistinguibili
// senza quella riga — l'ultimo frame disegnato è lo stesso.
const CTRL_C = '\x03';
/** Attesa senza tasti: ogni `W` vale il pump fra due tasti (0.7s), otto
 *  superano la finestra di 5s. */
const WAIT_OVER_WINDOW = 'W'.repeat(8);

const alive = (captured: string) => /<<PROC alive>>/.test(captured);

test('un ^C solo avverte e NON chiude', { skip: !CAN_RUN }, () => {
  const captured = capture(CTRL_C);
  assert.ok(alive(captured), 'il deck si è chiuso alla prima pressione');
  assert.match(lastFrame(captured), /\^C di nuovo entro/i, 'nessun avviso in riga di stato');
});

test('due ^C ravvicinati chiudono il deck', { skip: !CAN_RUN }, () => {
  const captured = capture(CTRL_C + CTRL_C);
  assert.match(captured, /<<PROC exit=0>>/, `il deck non si è chiuso: ${lastFrame(captured)}`);
});

test('oltre la finestra il secondo ^C riarma invece di chiudere', { skip: !CAN_RUN }, () => {
  // Il cuore della feature: il primo colpo SCADE. Senza questo scenario, un
  // armamento che non si disarma mai passerebbe entrambi i test sopra.
  const captured = capture(CTRL_C + WAIT_OVER_WINDOW + CTRL_C);
  assert.ok(alive(captured), 'la finestra non è scaduta: il secondo ^C ha chiuso');
  assert.match(lastFrame(captured), /\^C di nuovo entro/i, 'il secondo ^C non ha riarmato');
});

test('^C dentro un modale lo chiude e avverte, invece di restare muto', {
  skip: !CAN_RUN,
}, () => {
  // Nel detail la riga di stato non è renderizzata: armare restando lì dentro
  // darebbe un deck che sembra ignorare il tasto e poi sparisce senza avviso.
  const captured = capture(`DD\r${CTRL_C}`);
  assert.ok(alive(captured), 'il deck si è chiuso dal detail alla prima pressione');
  const frame = lastFrame(captured);
  assert.match(frame, /\^C di nuovo entro/i, `nessun avviso dopo ^C nel detail: ${frame}`);
  assert.match(frame, /t 💻/, `il detail non si è chiuso: ${frame}`);
});

// ── T121 · project status ─────────────────────────────────────────────────

test('^O senza cache lo dice invece di aprire un viewer vuoto', { skip: !CAN_RUN }, () => {
  // Il file non esiste: la cache assente è uno STATO del progetto, non un
  // documento da mostrare — un viewer vuoto direbbe «il recap è questo, ed è
  // nulla».
  const frame = lastFrame(
    capture(CTRL_O, PROJECT, { LOOM_DECK_STATUS_FILE: join(tmpdir(), 'loom-deck-mai-scritto.md') }),
  );
  assert.match(frame, /nessun recap in cache/i, `nessuna nota di inerzia: ${frame}`);
  assert.match(frame, /t 💻/, `il viewer si è aperto a vuoto: ${frame}`);
});

test('^O mostra il testo della cache, non un rigenerato', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture(CTRL_O, PROJECT, STATUS_ENV));
  assert.match(frame, /Due task aperte|Due .*task.* aperte/i, `testo della cache assente: ${frame}`);
  assert.match(frame, /generato alle \d\d:\d\d/i, `nessuna ora di generazione: ${frame}`);
});

test('la testata mostra missing finché non c\'è cache', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(
    capture('', PROJECT, { LOOM_DECK_STATUS_FILE: join(tmpdir(), 'loom-deck-mai-scritto.md') }),
  );
  assert.match(frame, /PROJECT STATUS \[ missing \]/, `stato missing non renderizzato: ${frame}`);
});

test('la testata mostra l\'ora quando la cache c\'è', { skip: !CAN_RUN }, () => {
  // Il recap sopravvive alla chiusura del deck: qui il processo nasce con la
  // cache già sul disco, che è esattamente la condizione di un deck riaperto.
  const frame = lastFrame(capture('', PROJECT, STATUS_ENV));
  assert.match(frame, /PROJECT STATUS \[ \d\d:\d\d \]/, `ora non renderizzata: ${frame}`);
});

test('^G avvia la generazione e la testata la conta', { skip: !CAN_RUN }, () => {
  // Con NO_SPAWN il figlio è inerte e non chiude mai: lo stato resta `building`,
  // che è ciò che questo scenario deve osservare.
  const frame = lastFrame(capture(CTRL_G, PROJECT, STATUS_ENV));
  assert.match(frame, /building \d+\.\.\./, `nessun contatore in testata: ${frame}`);
});

test('un secondo ^G non spawna una seconda generazione', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture(CTRL_G + CTRL_G, PROJECT, STATUS_ENV));
  assert.match(frame, /generazione già in corso/i, `il secondo ^G non è stato rifiutato: ${frame}`);
});

test('il viewer scorre a riga e a pagina', { skip: !CAN_RUN }, () => {
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
  skip: !CAN_RUN,
}, () => {
  // D3 — la generazione dura minuti, quindi la finestra in cui questo caso
  // capita è larga: leggere un recap di un'ora fa è quasi sempre meglio che non
  // leggere niente, purché il viewer non lo spacci per l'ultimo.
  const frame = lastFrame(capture(CTRL_G + CTRL_O, PROJECT, STATUS_ENV));
  assert.match(frame, /versione precedente/i, `il viewer non dichiara lo stale: ${frame}`);
});

test('^G e ^O sono inerti dentro un modo capturing', { skip: !CAN_RUN }, () => {
  // Come `^K`/`^P`/`^R`: chi è dentro il detail non deve poter far partire una
  // generazione da minuti con un tasto pensato per un'altra schermata.
  const frame = lastFrame(capture(`DD\r${CTRL_G}`, PROJECT, STATUS_ENV));
  assert.doesNotMatch(frame, /building \d+/, `^G ha generato dal detail: ${frame}`);
  assert.match(frame, /preflight|checkpoint/i, `il detail si è chiuso: ${frame}`);
});

// Chiusura: ogni modale torna alla lista con `esc`, e il deck resta vivo.
for (const m of MODES.filter((x) => x.name !== 'normal')) {
  test(`modo ${m.name}: esc riporta alla lista`, { skip: !CAN_RUN }, () => {
    const frame = lastFrame(capture(`${m.keys}${ESC}`, PROJECT, m.env));
    // La riga delle surface built-in esiste SOLO in modalità normale
    // (`launchLine`): è il marcatore che dice «siamo tornati alla lista».
    assert.match(frame, /t 💻/, `${m.name} non è tornato alla lista`);
  });
}

// ── T21 · mouse (mandata 1: superfici della riga launch) ──────────────────

/**
 * Click su una colonna della riga launch, che sta a riga 4 del terminale.
 *
 * Le colonne non sono indovinate: la riga comincia a colonna 3 (bordo +
 * padding) e i segmenti si susseguono separati da ` · ` — `t 💻` occupa 3..6,
 * `c 🤖` occupa 10..13. Scritte qui come numeri sono un CALCO che scade se la
 * riga cambia composizione, e per questo ogni scenario asserisce anche l'esito
 * dell'azione: un bersaglio spostato non passa silenziosamente.
 */
const clickLaunch = (col: number) => `@${col},4;`;

test('click su `t 💻` apre il terminale, come il tasto t', { skip: !CAN_RUN }, () => {
  const captured = capture(clickLaunch(4));
  assert.ok(alive(captured), 'il deck è morto sul click');
  assert.match(lastFrame(captured), /terminale su/i, 'il click non ha attivato la surface t');
});

test('click su `c 🤖` spawna la sessione, come il tasto c', { skip: !CAN_RUN }, () => {
  const frame = lastFrame(capture(clickLaunch(11)));
  assert.match(frame, /deck-run/, `il click non ha attivato la surface c: ${frame}`);
});

test('lo spazio fra due superfici non attiva la vicina', { skip: !CAN_RUN }, () => {
  // Colonna 8: il separatore fra `t 💻` e `c 🤖`. Un hit-test che arrotondasse
  // al segmento più vicino lancerebbe un terminale che nessuno ha chiesto.
  const frame = lastFrame(capture(clickLaunch(8)));
  assert.doesNotMatch(frame, /terminale su/i, `il separatore ha attivato t: ${frame}`);
  assert.doesNotMatch(frame, /deck-run/, `il separatore ha attivato c: ${frame}`);
});

test('un click fuori dalla riga launch è inerte', { skip: !CAN_RUN }, () => {
  // Mandata 1: le liste non sono cliccabili. Riga 6 è dentro il pane task.
  const frame = lastFrame(capture('@4,6;'));
  assert.doesNotMatch(frame, /terminale su/i, `una riga estranea ha attivato t: ${frame}`);
});

test('col modale aperto il click non scrive nel campo né attiva la surface', {
  skip: !CAN_RUN,
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

test('la rotella scorre il project status di tre righe per tacca', { skip: !CAN_RUN }, () => {
  // Cache più alta del terminale, come per `↑↓`: con un recap corto la
  // posizione non si muove e lo scenario passerebbe senza provare niente.
  const long = join(mkdtempSync(join(tmpdir(), 'loom-deck-wheel-')), 'lungo.md');
  writeFileSync(
    long,
    Array.from({ length: 200 }, (_, i) => `riga numero ${i} del recap`).join('\n'),
  );
  const env = { LOOM_DECK_STATUS_FILE: long };
  const down = linesAt(lastFrame(capture(`${CTRL_O}${WHEEL_DOWN}`, PROJECT, env)));
  assert.equal(down, 4, 'una tacca giù non ha scorso tre righe');
  // Due giù e una su: la rotella torna indietro, e non è un `PgUp` travestito.
  const back = linesAt(
    lastFrame(capture(`${CTRL_O}${WHEEL_DOWN}${WHEEL_DOWN}${WHEEL_UP}`, PROJECT, env)),
  );
  assert.equal(back, 4, 'una tacca su non ha riavvolto tre righe');
});

test('nel detail la rotella scorre il testo, non il fuoco fra i campi', { skip: !CAN_RUN }, () => {
  // T117: `↑↓` nel detail muovono il fuoco fra le quattro righe dell'area di
  // compilazione. Una rotella che sintetizzasse `↓` sposterebbe il fuoco e
  // lascerebbe il testo fermo — il contrario di quello che la mano ha chiesto.
  const start = lastFrame(capture('DD\r'));
  const after = lastFrame(capture(`DD\r${WHEEL_DOWN}`));
  assert.equal(linesAt(start), 1);
  assert.equal(linesAt(after), 4, `il testo del detail non è scorso: ${after}`);
  // Il fuoco è ancora sulla riga `azione`, che porta il caret; `↓` l'avrebbe
  // spostato sulla riga del prompt.
  assert.match(after, /▸ azione/, `il fuoco ha lasciato la riga azione: ${after}`);
});

test('sulla lista la rotella non muove la selezione', { skip: !CAN_RUN }, () => {
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

test('col modale aperto la rotella non scrive nel campo', { skip: !CAN_RUN }, () => {
  // Stesso difetto del click: la sequenza `[<65;10;10M` è TESTO per `useInput`
  // e senza filtro finirebbe nel titolo della task che si sta creando.
  const frame = lastFrame(capture(`C${WHEEL_DOWN}${WHEEL_UP}`));
  assert.match(frame, /C ›/, `il modale create non è aperto: ${frame}`);
  assert.doesNotMatch(frame, /\[<|64;|65;/, `la sequenza rotella è finita nel campo: ${frame}`);
});

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

test('click su una riga task la seleziona senza aprire il detail', { skip: !CAN_RUN }, () => {
  // Riga 13 = terza task della finestra (9 `≡`, 10 `○`, 11 prima task).
  const target = taskIdAtRow(lastFrame(capture('')), 13);
  const after = lastFrame(capture('@10,13;'));
  assert.equal(selectedTask(after), target, `il caret non è sulla riga cliccata: ${after}`);
  // D2: solo fuoco. La lista è ancora a schermo e `⏎` aprirebbe il detail ora.
  assert.match(after, /t 💻/, `il click ha lasciato la lista: ${after}`);
  assert.match(after, /⏎ detail/, `il fuoco non è sul pane task: ${after}`);
});

test('click su una riga meta riporta la selezione su di lei', { skip: !CAN_RUN }, () => {
  // Da una task (tre `↓`) si torna su `○ spot` (riga 10) con un click.
  const frame = lastFrame(capture('DDD@10,10;'));
  assert.match(frame, /▸ ○ spot/, `la riga spot non è selezionata: ${frame}`);
});

test('click sulla riga sort del pane task è inerte', { skip: !CAN_RUN }, () => {
  const base = selectedTask(lastFrame(capture('DDD')));
  assert.equal(selectedTask(lastFrame(capture('DDD@10,8;'))), base);
});

test('click su una conversazione porta fuoco e selezione sul pane sessioni', { skip: !CAN_RUN }, () => {
  // Riga 10 = terza conversazione (il corpo del pane sessioni parte da riga 8).
  // Colonna 70: dentro il pane destro a qualunque larghezza ≥ 100.
  const target = sessionAtRow(lastFrame(capture('')), 10);
  const after = lastFrame(capture('@70,10;'));
  const line = after.split('\n').find((l) => l.includes(target)) ?? '';
  // Il caret precede l'hash sulla stessa riga senza un bordo in mezzo: il
  // caret del pane task, a sinistra, è separato da `│ │`.
  assert.match(line, new RegExp(`▸[^│]*${target}`), `il caret non è sulla conversazione cliccata: ${line}`);
  assert.match(after, /⏎ resume/, `il fuoco non è passato al pane sessioni: ${after}`);
});

test('click su una voce dell\'header attiva quella vista', { skip: !CAN_RUN }, () => {
  // La colonna di `nascoste` si legge dal frame: tutto ciò che la precede sulla
  // riga 7 è largo 1, quindi indice + 1 = colonna. Scriverla come numero sarebbe
  // un calco della larghezza di `Tasks (N/M)`, che cambia con le task.
  const line = lastFrame(capture('')).split('\n')[6] ?? '';
  const at = line.indexOf('nascoste');
  assert.ok(at > 0, `la voce nascoste non è nell'header: ${line}`);
  const after = lastFrame(capture(`@${at + 1},7;`));
  assert.match(after, /vista task: \d+ nascoste/, `la vista non è cambiata: ${after}`);
});

test('click sulla vista già attiva non muove la selezione', { skip: !CAN_RUN }, () => {
  // `Tasks` comincia a colonna 5 (bordo + padding del pane): un click lì con
  // una task selezionata deve lasciarla dov'è, non riportarla su `≡ tutte`.
  const base = selectedTask(lastFrame(capture('DDD')));
  assert.equal(selectedTask(lastFrame(capture('DDD@6,7;'))), base);
});

test('il tracking si accende all\'avvio e si spegne all\'uscita', { skip: !CAN_RUN }, () => {
  // Un tracking lasciato acceso non è cosmetico: il terminale continua a
  // mandare sequenze a chi prende il posto del deck, che le stampa come testo.
  // Si misura sui BYTE, non sul frame — `stripAnsi` cancellerebbe la prova.
  const raw = captureRaw(CTRL_C + CTRL_C);
  assert.match(raw, /\x1b\[\?1000h/, 'il tracking non è stato acceso');
  assert.match(raw, /\x1b\[\?1006h/, 'la modalità SGR non è stata accesa');
  const off = raw.lastIndexOf('\x1b[?1000l');
  assert.ok(off > raw.indexOf('\x1b[?1000h'), 'il tracking non è stato spento all\'uscita');
});
