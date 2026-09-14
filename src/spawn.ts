// Effetti VERSO L'ESTERNO del deck: processi spawnati, comandi git. Nessun React
// qui — è la fase a monte del ciclo, quindi non importa nulla della vista.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LaunchEntry } from './config.js';
import type { IgnoredMode } from './purge.js';
// T161 — i cataloghi (kind, modelli, azioni) stanno in `spawn-catalog.ts`, che
// è DATO PURO e non importa questo file: la dipendenza va in un verso solo.
// Qui restano i soli effetti verso l'esterno — comporre un argv e lanciarlo.
import { MODEL_DEFAULT, PROJECT_STATUS_MODEL, type ModelKind } from './spawn-catalog.js';

// scripts/deck-run è un sibling della dir del bundle: src/ (dev, tsx) e dist/
// (build, node) stanno entrambi sotto la package root → risalita di un livello.
export const DECK_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deck-run');

/**
 * Freno agli effetti VERSO L'ESTERNO (tab Ptyxis, sessioni Claude, git commit).
 *
 * Il gate di larghezza avvia il deck vero in uno pseudo-terminale e gli manda
 * tasti — e in questa TUI un tasto è un'azione: `⏎` su una riga sessione apre
 * una tab Ptyxis, `t` un terminale, `⏎` nel modale edit committa. Ogni run dei
 * test apriva quindi finestre reali sulla macchina di chi li lanciava, in
 * qualunque progetto avesse in focus.
 *
 * Il gate va tenuto sul deck VERO (è tutto il suo valore: misura il frame che
 * VTE disegna davvero), quindi il freno sta qui: `LOOM_DECK_NO_SPAWN=1` fa
 * restituire un figlio finto e inerte invece di lanciare il processo. Non è un
 * mock del comportamento — l'azione semplicemente non avviene, e il frame che il
 * test misura resta identico.
 */
export const NO_SPAWN = process.env.LOOM_DECK_NO_SPAWN === '1';

export function spawnOut(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (!NO_SPAWN) return spawn(cmd, args, opts);
  // Figlio inerte: emette nulla, quindi i `.on('error'|'close')` dei chiamanti
  // restano appesi senza mai scattare — che è esattamente "non è successo niente".
  const fake = new EventEmitter() as ChildProcess;
  fake.unref = () => fake;
  return fake;
}

// Caratteri che una shell POSIX passa attraverso senza interpretarli: tutto il
// resto (spazi, apici, `$`, glob, non-ASCII) va quotato o il comando ricopiato
// dalla riga di stato non farebbe la stessa cosa di quello eseguito.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Un argomento come lo si scriverebbe in bash.
 *
 * Apici SINGOLI, non doppi: dentro i singoli nessun carattere resta speciale,
 * quindi non c'è da enumerare cosa sfuggire. L'unico caso da chiudere è l'apice
 * stesso, che si esce dalla stringa (`'\''`) invece di essere escapato dentro.
 *
 * Il deck non passa MAI da una shell — `spawn` senza `shell:true` consegna
 * l'argv a execve così com'è. Questo quoting esiste per la sola RESA: rende la
 * riga ricopiabile in un terminale senza cambiare di una virgola ciò che il
 * deck ha davvero eseguito.
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/**
 * Esito di uno spawn: il figlio (per l'handler d'errore) e il comando ESATTO
 * che l'ha prodotto.
 *
 * Il comando si compone qui e non nel chiamante di proposito: ricostruirlo là
 * significherebbe scrivere due volte la stessa argv, e la copia mostrata
 * divergerebbe da quella eseguita al primo flag aggiunto — cioè proprio quando
 * la riga di stato serve a capire cosa è partito davvero.
 */
export interface Spawned {
  child: ChildProcess;
  cmd: string;
}

// I quattro percorsi di spawn di una sessione Claude interattiva differiscono
// SOLO per l'argv: stesso eseguibile, stesso detached, stesso `unref`. Il corpo
// sta qui una volta sola, così anche il comando mostrato nasce in un punto solo.
//
// stdout in PIPE e non `ignore`: è il canale su cui `deck-run` annuncia il
// comando in-tab (vedi `onInTabCommand`). Il figlio resta detached — la pipe
// serve a leggere una riga, non a possedere il processo.
function launchDeckRun(args: string[], cwd: string): Spawned {
  const child = spawnOut(DECK_RUN, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.unref();
  return { child, cmd: shellCommand(DECK_RUN, args) };
}

/** Prefisso della riga con cui `deck-run` annuncia il comando in-tab. */
export const INTAB_MARKER = 'LOOM_DECK_INTAB ';

/**
 * Il comando che gira DENTRO la tab: la sessione `claude` vera, con le env che
 * la legano a task e progetto (`LOOM_TASK`, `PTYXIS_PROFILE`), il titolo, il
 * permission mode e il prompt iniziale già quotato.
 *
 * Non si compone qui e non si può: lo compone `deck-run`, che è il primitive
 * dove vivono catalogo dei prompt, quoting, permission mode, profilo di stato e
 * titolo. Ricostruirlo nel deck sarebbe una seconda scrittura delle stesse
 * regole, che diverge al primo flag aggiunto da una parte sola — quindi
 * `deck-run` lo annuncia su stdout prima di `exec` e qui lo si legge.
 *
 * Arriva ASINCRONO, millisecondi dopo lo spawn: chi mostra il comando deve
 * avere già scritto qualcosa (il comando di `deck-run`), perché l'annuncio può
 * non arrivare affatto — spawn inerte (`LOOM_DECK_NO_SPAWN`, che non ha nemmeno
 * uno stdout), validazione degli argomenti fallita, `deck-run` morto prima
 * dell'exec.
 *
 * Dopo la riga attesa lo stdout si drena e basta: da lì in poi appartiene a
 * `ptyxis`, che ha preso il posto del processo.
 */
export function onInTabCommand(child: ChildProcess, cb: (cmd: string) => void): void {
  if (!child.stdout) return;
  let buf = '';
  let seen = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (seen) return;
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith(INTAB_MARKER)) {
        seen = true;
        cb(line.slice(INTAB_MARKER.length));
        return;
      }
    }
  });
}

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
// sessionId pinnato (T27) → il binding sidecar è deterministico allo spawn.
// Il modello ha un default (T108): i percorsi che non passano dal selettore del
// detail non devono nominarlo per forza, e l'unico valore sensato per loro è
// quello che il selettore stesso mostra all'apertura.
// T111 — `spawnNote` è la nota data alla NASCITA della conversazione, dal campo
// sempre attivo del detail — che da T161 nasce PRE-RIEMPITO col template di
// titolo dell'azione, reso sulla task aperta. Ne discende che un campo svuotato
// a mano significa «nessuna nota» e non più «usa il titolo di fallback»: il
// fallback non esiste più, perché il default è già a schermo.
// Stesso flag `--title-note` del resume (T64): il
// suffisso `«nota»` viene appeso a `TITLE` dentro deck-run PRIMA che i rami si
// separino, quindi il flag non appartiene alla ripresa — vale su ogni spawn.
// Assente quando la nota è vuota, e non passato vuoto: `--title-note ''`
// produrrebbe un `«»` a vuoto nel titolo.
// T117 — `prompt` è il TESTO letterale, e sostituisce il kind: `--prompt` e
// `--prompt-kind` sono mutuamente esclusivi in deck-run.
//
// T161 — dal deck viaggia SEMPRE il testo, mai più il simbolo. Prima gli
// acceleratori della lista passavano `--prompt-kind` e lasciavano risolvere il
// testo a `deck-run`, che consultava il proprio catalogo; il detail passava già
// il letterale. Con un override di progetto sui prompt la risoluzione deve
// stare da una parte sola, e quella parte è il deck — che è l'unico dei due a
// leggere `.claude/loom-works.json` per questo (`jq` è dipendenza opzionale di
// `deck-run`). Un percorso solo, quindi, e ciò che parte è verificabile
// sull'argv.
//
// Due conseguenze dichiarate: `--prompt-kind` resta in `deck-run` per chi lo
// invoca a mano, e `LOOM_DECK_ENTER_PROMPT` non ha più effetto sugli spawn dal
// deck (non ha mai vinto su `--prompt`).
//
// Stringa VUOTA = richiesta esplicita di nessun prompt (azione `open`, o un
// campo svuotato a mano): si esprime col kind `none`, perché senza nessun flag
// `deck-run` cadrebbe sul proprio default `recap`.
export function deckArgs(
  id: string,
  sessionId: string,
  model: ModelKind = MODEL_DEFAULT,
  spawnNote?: string,
  prompt = '',
): string[] {
  const promptArgs = prompt ? ['--prompt', prompt] : ['--prompt-kind', 'none'];
  const args = [id, '--session-id', sessionId, ...promptArgs, '--model', model];
  if (spawnNote) args.push('--title-note', spawnNote);
  return args;
}

export function spawnDeck(
  id: string,
  cwd: string,
  sessionId: string,
  model: ModelKind = MODEL_DEFAULT,
  spawnNote?: string,
  prompt = '',
): Spawned {
  return launchDeckRun(deckArgs(id, sessionId, model, spawnNote, prompt), cwd);
}

// T49 — resume di una sessione esistente come nuova tab Ptyxis. Scoped (taskId
// presente) → `deck-run <task> --resume <sid>`: la ripresa eredita LOOM_TASK +
// titolo `· <task>` (D2 preflight, l'hook SessionStart ricarica il contesto
// task). Spot → `--no-task --resume`: resume nudo, solo label progetto. Nessun
// prompt iniziale in entrambi i casi: riprendere una conversazione significa
// continuarla, non iniettarle un messaggio (lo salta deck-run).
//
// T64 — la NOTA della conversazione (se c'è) viaggia nel titolo della tab. Più
// sessioni sulla stessa task hanno oggi titoli identici (`label · T81`): la nota
// è già ciò con cui l'utente le distingue in lista, quindi è anche ciò che
// distingue le tab. La passa il DECK e non la legge deck-run perché la nota vive
// nel sidecar `session-tasks.jsonl`, che deck-run non tocca (legge solo
// `.claude/loom-works.json`): tenerlo così evita di dare al primitive un secondo
// file da conoscere. Il titolo si congela qui — `claude --name` lo setta una
// volta sola, quindi una nota cambiata DOPO non ri-titola la tab già aperta.
//
// T148 — il modello viaggia SEMPRE, come in `deckArgs`: senza `--model`
// `deck-run` risolve il proprio default (`MODEL_DEFAULT`) e lo passa comunque
// al CLI, quindi una conversazione haiku ripresa senza il flag ripartirebbe sul
// default (P2 preflight). Qui però non c'è un default da cablare: chi
// chiama ha già risolto il valore — il modello della conversazione d'origine,
// o quello scelto al suo posto — e lo passa come argomento obbligatorio.
// La NOTA sta PRIMA di `--resume`, non in coda, ed è l'unico argomento di questa
// forma che non segue l'ordine di lettura. La ragione è la riga di stato: il
// comando ci arriva tagliato al mezzo (`noteCommand`, che tiene un terzo di
// testa e due terzi di coda), e `--title-note` è l'unico argomento a lunghezza
// LIBERA — porta il titolo della conversazione, che l'utente scrive come vuole.
// In coda si mangia i due terzi riservati, e a spingere fuori è proprio
// `--resume <uuid>`, cioè l'unica cosa che distingue una ripresa da un'altra: su
// una conversazione dal titolo lungo la riga di stato finiva per dire quale
// modello e quale titolo, mai quale conversazione. Spostata qui, la coda porta
// sempre `--resume <uuid> --model <alias>` — sessanta colonne su un budget di
// settantasei, indipendenti dal titolo. `deck-run` legge i flag in qualunque
// ordine (un solo posizionale, il TaskID), quindi lo spostamento non cambia
// niente per chi esegue.
export function resumeArgs(
  taskId: string | null,
  sessionId: string,
  model: ModelKind,
  note?: string,
): string[] {
  const args = taskId ? [taskId] : ['--no-task'];
  if (note) args.push('--title-note', note);
  args.push('--resume', sessionId, '--model', model);
  return args;
}

export function spawnDeckResume(
  taskId: string | null,
  cwd: string,
  sessionId: string,
  model: ModelKind,
  note?: string,
): Spawned {
  return launchDeckRun(resumeArgs(taskId, sessionId, model, note), cwd);
}

// T28 — FORK: `deck-run <task|--no-task> --resume <origine> --fork --session-id
// <nuovo>`. Variante del resume, non una terza forma: cambia solo che CC apre un
// id nuovo (`--fork-session`) invece di riprendere a scrivere sull'origine —
// due writer sullo stesso JSONL non esistono mai, che è l'intero punto del fork.
// Il nuovo id lo genera il DECK e lo pinna, come in spawnDeck: è l'unico modo di
// conoscerlo prima che la sessione esista, e senza conoscerlo non si possono
// scrivere né il binding task né il record di lineage (il transcript del fork
// non nomina da nessuna parte la sessione d'origine).
// Nessun `--title-note` (T64): il ramo nasce con un sessionId proprio e SENZA
// nota nel sidecar — ereditare quella dell'origine metterebbe nel titolo una
// maniglia che nella lista non compare, cioè una promessa falsa. Il fork si
// distingue col suo marcatore, `· fork`.
//
// T148 — stesso obbligo di `resumeArgs`: il fork è un'altra forma di
// continuità, quindi eredita anch'esso il modello dell'origine invece del
// default fisso di uno spawn nuovo (P2 preflight).
export function forkArgs(
  taskId: string | null,
  originId: string,
  newId: string,
  model: ModelKind,
): string[] {
  return [
    ...(taskId ? [taskId] : ['--no-task']),
    '--resume',
    originId,
    '--fork',
    '--session-id',
    newId,
    '--model',
    model,
  ];
}

export function spawnDeckFork(
  taskId: string | null,
  cwd: string,
  originId: string,
  newId: string,
  model: ModelKind,
): Spawned {
  return launchDeckRun(forkArgs(taskId, originId, newId, model), cwd);
}

// T42 — sessione Claude NUDA: nessuna task, nessun prompt iniziale, nessun
// sessionId pinnato (quindi nessuna entry nel sidecar session-tasks.jsonl: senza
// task non c'è nulla da legare). Funzione separata e non un parametro opzionale
// di spawnDeck: i tre argomenti mancano tutti insieme, un `if` per ciascuno
// sporcherebbe il percorso bound. Il titolo tab resta la label loom — lo mette
// deck-run, perché il match compass è window-level e non sa nulla di task.
//
// T154 — il modello viaggia SEMPRE nell'argv (`emptyArgs`), anche sul default:
// prima di questa task il tasto `c` non lo passava affatto, e chi lo premeva
// non sceglieva né vedeva quale modello `deck-run` avrebbe risolto da sé.
// Estratta come i suoi fratelli (`deckArgs`/`resumeArgs`/`forkArgs`): tutti i
// costruttori di argv con un test proprio lo sono (P4 preflight).
export function emptyArgs(model: ModelKind): string[] {
  return ['--no-task', '--model', model];
}

export function spawnClaudeEmpty(cwd: string, model: ModelKind): Spawned {
  return launchDeckRun(emptyArgs(model), cwd);
}

/**
 * T134 — sessione NUDA con un prompt letterale: `deck-run --no-task --prompt
 * <testo> --model <alias>`.
 *
 * Il lavoro che apre — drenare un file inbox, srotolare l'hard-wrap di un path
 * — sta sulla DOC, non su una task (D10 preflight). Legarlo a un cappello
 * esporterebbe `LOOM_TASK`, farebbe scattare l'hook `SessionStart` che inietta
 * in contesto il task file di un lavoro spesso già chiuso, e metterebbe
 * `· T<n>` nel titolo della tab; per un file `sweep` senza cappello la strada
 * non esisterebbe nemmeno.
 *
 * Presidiata, non headless (D11): `spawnSkill` resta dov'è e non si estende
 * qui. Ne discendono due cose. Il confine presidiata / non presidiata delle
 * skill di doc smette di essere un vincolo — anche `align-doc`, che apre un
 * branch con PR, è offribile, perché c'è un umano nella tab che la guarda. E la
 * guardia d'ingresso `doc-guard.sh worktree`, che esce 2 su worktree sporco
 * sotto `inbox/`, `reference/` o `CLAUDE.md`, la incontra la sessione e la
 * mostra a chi l'ha lanciata: il deck non deve replicarla per sapere in
 * anticipo se l'azione morirebbe allo step 0.
 *
 * Il modello è passato SEMPRE, anche sul default, per la stessa ragione di
 * `permissionMode`: lo spawn resta deterministico e leggibile nel process tree
 * invece di dipendere da un default che può cambiare fra versioni.
 *
 * `sessionId` e `title` viaggiano INSIEME o non viaggiano: il titolo lo mostrano
 * due superfici — la tab Ptyxis (via `--title-note`) e la riga della lista
 * sessioni (via la nota nel sidecar, che è keyed sul sessionId) — e senza un id
 * pinnato la seconda non ha una chiave su cui scrivere. Pinnarlo è quindi ciò
 * che rende il titolo visibile in entrambe, non un binding task: una sessione
 * `--no-task` non ne ha uno, ma un NOME ce l'ha.
 *
 * Il titolo sta in TESTA all'argv, prima del prompt: la riga di stato del deck
 * taglia il comando al mezzo, e il prompt (specialmente quello cablato dello
 * srotolamento) è l'argomento più lungo — in coda al titolo lo spingerebbe
 * fuori vista. Stessa ragione dell'ordine di `resumeArgs`.
 */
export function bareArgs(
  prompt: string,
  model: ModelKind,
  sessionId?: string,
  title?: string,
): string[] {
  const args = ['--no-task'];
  if (title) args.push('--title-note', title);
  if (sessionId) args.push('--session-id', sessionId);
  args.push('--prompt', prompt, '--model', model);
  return args;
}

export function spawnBare(
  cwd: string,
  prompt: string,
  model: ModelKind,
  sessionId?: string,
  title?: string,
): Spawned {
  return launchDeckRun(bareArgs(prompt, model, sessionId, title), cwd);
}

// T39/T32: voce `launch` custom del file config, eseguita con cwd = project root.
// Spawn detached come spawnDeck: il deck lancia ma non possiede il processo.
// Shell login+interattiva (bash -lic) perché i comandi tipici sono alias o
// funzioni di ~/.bashrc (`codium`=alias flatpak, `idea`=funzione) — con `bash -c`
// non risolverebbero. Il comando NON è input utente: viene dal file committato
// `.claude/loom-works.json`, fidato quanto un custom-command Ptyxis (contratto
// esplicito in project-config-architecture.md). La project root arriva via cwd,
// non interpolata nella stringa.
export function runLaunch(entry: LaunchEntry, cwd: string) {
  const child = spawnOut('bash', ['-lic', entry.command], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// T37 — surface STANDARD LAUNCH `terminal`: built-in e universale (nessuna
// dichiarazione in `launch[]`), ma di natura launch — fire-once, nessuno stato.
// Il deck gira già DENTRO una tab Ptyxis → `--tab` mette il terminale accanto a
// sé nella stessa finestra, invece di sparpagliare finestre.
// Nessun `-- CMD`: l'azione È aprire la shell (differenza dalle launch custom,
// che eseguono un comando dentro `bash -lic`).
// `-T <title>` con la chiave `🖥️ <name>` tiene la finestra matchabile da compass
// anche mentre la tab attiva è il terminale; senza identità nel file config si
// spawna senza titolo (la surface resta funzionante, il progetto risulta assente
// dal radar finché quella tab è in primo piano).
export function terminalArgs(cwd: string, title: string | null): string[] {
  return title ? ['--tab', '-T', title, '-d', cwd] : ['--tab', '-d', cwd];
}

export function spawnTerminal(cwd: string, title: string | null) {
  const child = spawnOut('ptyxis', terminalArgs(cwd, title), {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// Comando claude (override per ambienti dove non è su PATH; loom-deck → NPM).
export const CLAUDE_CMD = process.env.LOOM_DECK_CLAUDE_CMD ?? 'claude';

// T30: invocazione di una skill del plugin da CC HEADLESS (`-p`), con
// `--session-id` pinnato. È la TERZA strada per eseguire uno script del plugin
// da un consumer che non ha `CLAUDE_PLUGIN_ROOT`: il path version-pinned della
// cache lo risolve il processo Claude, e il deck non lo nomina mai.
//  - headless (`-p`), non una tab Ptyxis interattiva → il deck osserva l'esito;
//  - `--output-format stream-json` (richiede `--verbose`): l'ultima riga è
//    `{type:"result", is_error}`, segnale di completamento robusto (> exit code);
//  - detached (own process-group) → il lavoro sopravvive alla chiusura del deck
//    e completa i commit da sé; stdout in pipe SOLO per leggere il result event.
// Il prompt viaggia come singolo argv (no shell) → nessuna injection dal testo.
//
// `detail` è il testo finale del result event, troncato dal chiamante: senza,
// un fallimento arriva come booleano nudo e la riga di stato può solo dire "non
// ha funzionato" — che su un'operazione distruttiva non basta a sapere se
// qualcosa è stato rimosso.
function spawnSkill(
  prompt: string,
  cwd: string,
  sessionId: string,
  onResult: (ok: boolean, detail: string) => void,
  extraArgs: string[] = [],
) {
  const child = spawnOut(
    CLAUDE_CMD,
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      sessionId,
      ...extraArgs,
      prompt,
    ],
    { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let buf = '';
  let isError: boolean | null = null;
  let detail = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown };
        if (obj.type === 'result') {
          isError = obj.is_error ?? false;
          if (typeof obj.result === 'string') detail = obj.result;
        }
      } catch {
        // riga parziale / non-json → skip
      }
    }
  });
  // Drena stderr per non riempire il buffer pipe (deadlock del figlio).
  child.stderr?.on('data', () => {});

  child.on('error', () => onResult(false, `'${CLAUDE_CMD}' non lanciabile`));
  child.on('close', (code) => {
    onResult(isError === null ? code === 0 : !isError, detail);
  });
  return child;
}

// T30: create-task inline. `yolo` FORZATO: create-task è interattiva di default
// (AskUserQuestion) e in `-p` non c'è nessuno che risponda → la sessione
// resterebbe appesa. yolo = zero domande.
export function spawnCreateTask(
  text: string,
  cwd: string,
  sessionId: string,
  onResult: (ok: boolean) => void,
) {
  return spawnSkill(`/loom-works:create-task yolo ${text}`, cwd, sessionId, (ok) => onResult(ok));
}

// T112 — potatura ordinata a `loom-works:clean-tasks`. Modo A della skill (ID
// espliciti), MAI il modo B (`--days`): passarle una soglia d'età le farebbe
// ricalcolare il bersaglio con la propria regola, che è già la copia divergibile
// di quella del deck (D6 preflight). Il bersaglio lo decide il deck e la skill
// lo esegue.
//
// `yolo` come in create-task, e per la stessa ragione con una posta più alta:
// `clean-tasks` chiede conferma quando fra i target ci sono task non-Done, e in
// headless quella domanda non ha nessuno che risponda. Il token dichiara che la
// conferma è già stata raccolta dal chiamante — qui, dal modale del deck.
//
// `--ignored-files` viaggia solo quando la scelta keep/purge è stata fatta
// davvero (una singola task con superstiti): passarlo sempre significherebbe
// deciderlo di default su un'operazione che perde file.
export function cleanTasksPrompt(ids: string[], ignored: IgnoredMode | null): string {
  const flag = ignored ? ` --ignored-files ${ignored}` : '';
  return `/loom-works:clean-tasks yolo${flag} ${ids.join(' ')}`;
}

export function cleanTasksArgs(
  ids: string[],
  sessionId: string,
  ignored: IgnoredMode | null,
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    sessionId,
    cleanTasksPrompt(ids, ignored),
  ];
}

/** Bersaglio vuoto → nessuno spawn e `null`: un `clean-tasks` senza SPEC esce 1
 *  e il deck riporterebbe un fallimento per un'operazione mai chiesta. */
export function spawnCleanTasks(
  ids: string[],
  cwd: string,
  sessionId: string,
  ignored: IgnoredMode | null,
  onResult: (ok: boolean, detail: string) => void,
): ChildProcess | null {
  if (ids.length === 0) return null;
  return spawnSkill(cleanTasksPrompt(ids, ignored), cwd, sessionId, onResult);
}

// T121 — recap di progetto in headless. Qui il `detail` del result event NON è
// un messaggio d'errore da troncare come per `create-task`/`clean-tasks`: è il
// DELIVERABLE, cioè il testo intero della skill, e chi chiama lo scrive su
// disco. Una skill read-only invocata in `-p` è una funzione che ritorna testo.
//
// `--permission-mode auto` e nessun token `yolo` (D4): le due cautele coprono
// cause di stallo diverse e non sono intercambiabili. `yolo` toglie le domande
// che la skill pone da sé, e `recap-status-project` non ne ha; il modo
// permissivo toglie le richieste di permesso che il CLI pone su un tool, e
// quelle in `-p` non hanno nessuno che risponda — il processo resterebbe appeso
// senza emettere niente, cioè con l'indicatore che conta all'infinito.
//
// T161 — modello e prompt arrivano dal CHIAMANTE, risolti sul catalogo delle
// azioni: erano gli ultimi due valori che questa funzione sceglieva da sé
// (`PROJECT_STATUS_MODEL` e la stringa della skill), e con l'override di
// progetto il default deve stare in un posto solo insieme a quello delle altre
// dieci azioni. Il `--permission-mode auto` invece resta qui: non è una
// preferenza ma la condizione perché un `-p` non resti appeso.
export function spawnProjectStatus(
  cwd: string,
  sessionId: string,
  onResult: (ok: boolean, detail: string) => void,
  model: ModelKind = PROJECT_STATUS_MODEL,
  prompt = '/loom-works:recap-status-project',
) {
  return spawnSkill(prompt, cwd, sessionId, onResult, [
    '--permission-mode',
    'auto',
    '--model',
    model,
  ]);
}

// Comando della notifica desktop. L'override esiste per il collaudo del ramo
// «binario assente»: su una macchina dove `notify-send` c'è, quel ramo non è
// altrimenti raggiungibile — e non provarlo significherebbe scoprire su una
// macchina altrui che un ENOENT non agganciato porta via la TUI.
export const NOTIFY_CMD = process.env.LOOM_DECK_NOTIFY_CMD ?? 'notify-send';

// T121 — notifica desktop di fine generazione. La generazione dura minuti e chi
// l'ha chiesta nel frattempo guarda altrove; la notifica di GNOME persiste nel
// cassetto, quindi raggiunge anche chi torna dieci minuti dopo — cosa che un
// suono non fa.
//
// Il listener su `error` è OBBLIGATORIO e non difensivo: un `error` non
// agganciato su un `ChildProcess` diventa un'eccezione non catturata e abbatte
// il deck, quindi senza di lui l'assenza di `notify-send` ucciderebbe la TUI.
// Agganciato, la degradazione è MUTA (D6): un binario assente è una proprietà
// stabile della macchina, e dirlo a ogni generazione sarebbe lo stesso messaggio
// a ogni giro su una funzione che non è il deliverable.
export function notifyDone(title: string, body: string) {
  const child = spawnOut(NOTIFY_CMD, ['--app-name=loom-deck', title, body], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref?.();
  return child;
}

// T41 — Commit dell'edit. `git commit -- <paths>` committa lo stato working-tree
// SOLO di quei path, ignorando l'index: se l'utente ha altro in stage (o altri
// file sporchi) non finisce dentro per errore. NON detached: è un'operazione
// veloce e il suo esito va riportato nella nota. stderr raccolto per dire perché
// ha fallito (identità git assente, hook che rifiuta, …) invece di un generico ⚠.
export function commitTaskEdit(
  cwd: string,
  paths: string[],
  message: string,
  onResult: (ok: boolean, err: string) => void,
) {
  const child = spawnOut('git', ['commit', '-m', message, '--', ...paths], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });
  child.on('error', () => onResult(false, 'git non lanciabile'));
  child.on('close', (code) => onResult(code === 0, err.trim().split('\n')[0] ?? ''));
  return child;
}
