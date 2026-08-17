// Effetti VERSO L'ESTERNO del deck: processi spawnati, comandi git. Nessun React
// qui — è la fase a monte del ciclo, quindi non importa nulla della vista.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LaunchEntry } from './config.js';

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

// T56 — quale prompt iniziale riceve la sessione appena aperta. È un SIMBOLO,
// non il testo: il catalogo vive in deck-run (primitive UI-agnostico), così il
// quoting del prompt resta verificato in un posto solo e il deck non conosce le
// stringhe. Nomi identici ai valori di `--prompt-kind`.
export type PromptKind = 'none' | 'recap' | 'preflight' | 'run' | 'checkpoint';

// T66 — le azioni del detail. Non sono un catalogo nuovo: ognuna è un
// `--prompt-kind` già esistente più `checkpoint`, e tutte passano dallo stesso
// `spawnForTask` dei CTRL della lista — una superficie in più, zero percorsi di
// spawn in più.
//
// L'etichetta è distinta dal kind dove il kind è il nome del MECCANISMO e
// l'etichetta quello dell'INTENZIONE: `none` è "aprire la task a mani nude",
// `recap` è "vedere a che punto sta".
export const DETAIL_ACTIONS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: 'none', label: 'open' },
  { kind: 'preflight', label: 'preflight' },
  { kind: 'run', label: 'run' },
  { kind: 'recap', label: 'status' },
  { kind: 'checkpoint', label: 'checkpoint' },
];

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
// sessionId pinnato (T27) → il binding sidecar è deterministico allo spawn.
// Il kind è OBBLIGATORIO e non ha default qui: il default vive in deck-run (per
// le invocazioni a mano), mentre dal deck ogni tasto dichiara il proprio intento
// — un default silenzioso renderebbe indistinguibili `⏎` e `^K`.
export function deckArgs(id: string, sessionId: string, kind: PromptKind): string[] {
  return [id, '--session-id', sessionId, '--prompt-kind', kind];
}

export function spawnDeck(id: string, cwd: string, sessionId: string, kind: PromptKind) {
  const child = spawnOut(DECK_RUN, deckArgs(id, sessionId, kind), {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
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
export function resumeArgs(taskId: string | null, sessionId: string, note?: string): string[] {
  const args = taskId ? [taskId, '--resume', sessionId] : ['--no-task', '--resume', sessionId];
  if (note) args.push('--title-note', note);
  return args;
}

export function spawnDeckResume(
  taskId: string | null,
  cwd: string,
  sessionId: string,
  note?: string,
) {
  const child = spawnOut(DECK_RUN, resumeArgs(taskId, sessionId, note), {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
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
export function forkArgs(taskId: string | null, originId: string, newId: string): string[] {
  return [
    ...(taskId ? [taskId] : ['--no-task']),
    '--resume',
    originId,
    '--fork',
    '--session-id',
    newId,
  ];
}

export function spawnDeckFork(taskId: string | null, cwd: string, originId: string, newId: string) {
  const child = spawnOut(DECK_RUN, forkArgs(taskId, originId, newId), {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// T42 — sessione Claude NUDA: nessuna task, nessun prompt iniziale, nessun
// sessionId pinnato (quindi nessuna entry nel sidecar session-tasks.jsonl: senza
// task non c'è nulla da legare). Funzione separata e non un parametro opzionale
// di spawnDeck: i tre argomenti mancano tutti insieme, un `if` per ciascuno
// sporcherebbe il percorso bound. Il titolo tab resta la label loom — lo mette
// deck-run, perché il match compass è window-level e non sa nulla di task.
export function spawnClaudeEmpty(cwd: string) {
  const child = spawnOut(DECK_RUN, ['--no-task'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
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

// T30: create-task inline. Spawna CC HEADLESS (`-p`) con `--session-id` pinnato
// che invoca la skill create-task. Differenze da spawnDeck:
//  - headless (`-p`), non una tab Ptyxis interattiva → il deck osserva l'esito;
//  - `yolo` FORZATO: create-task è interattiva di default (AskUserQuestion) e in
//    `-p` non può ricevere risposte → si impianterebbe. yolo = zero domande.
//  - `--output-format stream-json` (richiede `--verbose`): l'ultima riga è
//    `{type:"result", is_error}`, segnale di completamento robusto (> exit code).
//  - detached (own process-group) → il create sopravvive alla chiusura del deck e
//    completa commit+push da sé; stdout in pipe SOLO per leggere il result event.
// Il prompt viaggia come singolo argv (no shell) → nessuna injection dal testo utente.
export function spawnCreateTask(
  text: string,
  cwd: string,
  sessionId: string,
  onResult: (ok: boolean) => void,
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
      `/loom-works:create-task yolo ${text}`,
    ],
    { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let buf = '';
  let isError: boolean | null = null;
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; is_error?: boolean };
        if (obj.type === 'result') isError = obj.is_error ?? false;
      } catch {
        // riga parziale / non-json → skip
      }
    }
  });
  // Drena stderr per non riempire il buffer pipe (deadlock del figlio).
  child.stderr?.on('data', () => {});

  child.on('error', () => onResult(false));
  child.on('close', (code) => {
    onResult(isError === null ? code === 0 : !isError);
  });
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
