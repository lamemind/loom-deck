#!/usr/bin/env node
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { useState, useEffect, useMemo, useRef } from 'react';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveTasksPath,
  resolveTasksDir,
  loadTasks,
  loadTaskDetail,
  type Task,
  type TaskDetail,
} from './tasks.js';
import { discoverProjectSessions, type BodyKind, type Session } from './sessions.js';
import {
  buildRows,
  firstRowKey,
  moveRowSelection,
  rowIndexOfKey,
  searchSessions,
  selectedRow,
  DEFAULT_OPTIONS,
  MIN_QUERY,
  type Hit,
  type SearchOptions,
  type SearchResult,
  type SearchRow,
} from './search.js';
import {
  appendNote,
  appendPin,
  appendSessionRecord,
  appendTaskBinding,
  loadSessionIndex,
  type SessionIndex,
} from './task-index.js';
import {
  assembleSessionList,
  firstSelectableId,
  moveSelection,
  neighborId,
  rowIndexOf,
  rowLabel,
  selectedSession,
  sessionTitle,
  stripProjectCore,
  type SessionRow,
} from './session-list.js';
import {
  cellWidth,
  launchLegend,
  loadArchivableDays,
  loadIdentity,
  loadLaunch,
  type LaunchEntry,
} from './config.js';
import { countArchivable, SCAN_INTERVAL_MS } from './archivable.js';
import {
  assignListCapacity,
  isCompact,
  layoutBudget,
  readerCapacity,
  searchListCapacity,
  searchPreviewCapacity,
  windowRange,
  type Budget,
  type Mode as ViewportMode,
  type PreviewKind,
} from './viewport.js';
import {
  caretWindow,
  cut,
  cutParts,
  pad,
  sanitize,
  termWidth,
  wrapLines,
  wrapWithOffsets,
  type WrappedLine,
} from './width.js';
import {
  applyView,
  cycleSort,
  describeSort,
  priName,
  progName,
  toggleHidden,
  PRI_ENTRIES,
  PROG_ENTRIES,
  type PriName,
  type ProgName,
  type SortEntry,
  type SortKey,
  type ViewState,
} from './view.js';
import {
  initialDetail,
  progressText,
  writeTaskEdit,
  PRI_GLYPH,
  PRI_LABEL,
  PROG_GLYPH,
} from './task-edit.js';
import { loadView, saveView, viewFilePath } from './view-store.js';

// scripts/deck-run è un sibling della dir del bundle: src/ (dev, tsx) e dist/
// (build, node) stanno entrambi sotto la package root → risalita di un livello.
const DECK_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deck-run');

const POLL_MS = 1500;

// Cap del pane sessioni: le più recenti (ts desc), le altre restano nell'indice
// ma fuori vista. Non-silenzioso → l'header mostra quante sono nascoste.
const MAX_SESSIONS = 30;
// T59 D3 — cap dedicato alla vista "tutte": a 30 su un progetto con ~170
// conversazioni la lista sarebbe esaustiva solo sull'ultimo 17%, cioè
// contraddirebbe lo scopo della riga. 100 copre la finestra temporale utile e
// tiene comunque un tetto alle righe da attraversare con ↑↓.
const MAX_SESSIONS_ALL = 100;

// Modello task-centrico: il Tasks pane ha, oltre alle task reali, DUE righe
// meta in testa — `≡ tutte` (ogni conversazione del progetto) e `○ spot` (le
// sole NON legate ad alcuna task). La selezione nel Tasks pane è il "padre"; il
// Sessions pane mostra i suoi figli.
//
// T59 D1 — le sentinelle sono Symbol, non `null` né stringhe riservate: la
// selezione è un ENUM a tre casi (task / spot / tutte), non un flag. Un Symbol
// non può collidere con un task id e si confronta secco (`sel === ALL`); una
// stringa sentinella farebbe invece circolare un id-fantasma dentro un tipo che
// altrove significa "task id".
const SPOT = Symbol('spot');
const ALL = Symbol('all');
type Parent = string | typeof SPOT | typeof ALL; // taskId | spot | tutte

// Le righe meta occupano le prime posizioni della lista: l'indice di una task
// nella VISTA è quindi il suo indice in `viewTasks` + META_ROWS.
const ROW_ALL = 0;
const ROW_SPOT = 1;
const META_ROWS = 2;

type Focus = 'tasks' | 'sessions';

// Standard shortcut (T39): MAIUSCOLA apre un modale, minuscola è azione
// immediata, 1..9 sono le voci launch del file config. I modali catturano tutti
// i tasti: dentro, `esc` annulla e non esce dal deck.
//
// Il tipo vive in viewport.ts perché ogni modale ha un COSTO IN RIGHE che il
// budget d'altezza deve conoscere: tenerli in due posti li farebbe divergere in
// silenzio, e una modale non contabilizzata è esattamente ciò che fa sforare il
// frame.
type Mode = ViewportMode;

// Griglia del modale filtri: riga 0 = priorità, riga 1 = stato.
interface FilterCursor {
  row: 0 | 1;
  col: number;
}

// T41 — Bozza del modale edit: valori scelti, non ancora scritti su disco.
// `detail` è il progresso arbitrario (`85%`, `In Progress`, …); vuoto = default
// dello stato. `title` è il titolo della task (descrizione in tasks.md + H1 del
// task file: una cosa sola, scritta in due posti).
// Righe del modale: 0 priorità · 1 stato · 2 progresso libero · 3 titolo.
// Il titolo sta IN CODA e non in testa apposta: le righe 0-2 conservano la
// posizione che avevano, quindi `E ←→` continua a cambiare la priorità come
// prima invece di finire su un campo di testo.
// T54 — `caret` è la posizione del cursore DENTRO la riga di testo attiva,
// contata per CODE POINT: uno solo per tutto il modale, perché una riga di testo
// alla volta è editabile e portarne uno per campo vorrebbe dire tenerli
// allineati a mano a ogni modifica. Cambiando riga si riposiziona in coda al
// nuovo campo (vedi il ramo ↑↓).
interface EditDraft {
  pri: PriName;
  prog: ProgName;
  detail: string;
  title: string;
  caret: number;
}
type EditRow = 0 | 1 | 2 | 3;
const EDIT_ROWS = 4;

/** Le righe del modale edit che sono campi di TESTO (il resto è scelta ←→). */
function isTextRow(r: EditRow): r is 2 | 3 {
  return r === 2 || r === 3;
}

/** Chiave della bozza scritta dalla riga di testo `r`. */
function editField(r: 2 | 3): 'detail' | 'title' {
  return r === 2 ? 'detail' : 'title';
}

/**
 * Lunghezza in CODE POINT. Il caret ci indicizza sopra: `.length` conterebbe le
 * code unit UTF-16 e un'emoji nel titolo varrebbe 2 posizioni, cioè un cursore
 * che si ferma a metà glifo e un `slice` che lo spezza in due surrogati.
 */
function cpLen(s: string): number {
  return [...s].length;
}

/** Inserisce `ins` alla posizione `at` (code point). */
function insertAt(s: string, at: number, ins: string): string {
  const cp = [...s];
  return cp.slice(0, at).join('') + ins + cp.slice(at).join('');
}

/** Toglie il code point in posizione `at`; fuori range = stringa invariata. */
function removeAt(s: string, at: number): string {
  const cp = [...s];
  if (at < 0 || at >= cp.length) return s;
  cp.splice(at, 1);
  return cp.join('');
}

// Modale sort a grammatica libera: un tasto per chiave, pressioni successive
// ciclano asc → desc → fuori dalla chain.
const SORT_TASTI: Record<string, SortKey> = { p: 'pri', s: 'prog', i: 'id' };

// T52 — campi del modale ricerca, ciclati da Tab.
type SearchField = 'hash' | 'query';

// T52 — toggle del modale ricerca, tutti su CTRL (D2).
//
// I due campi di testo mangiano ogni lettera nuda, quindi un toggle non può
// essere una lettera semplice: resterebbero i caratteri della query. CTRL è
// l'unico livello che convive con la digitazione senza modi né navigazione.
//
// Le mnemoniche ovvie sono precluse dall'ASCII, non da una scelta di design:
// `^I` È il Tab (0x09) e `^H` È il Backspace (0x08) — stesso byte, nessuna
// distinzione possibile a valle. Quindi niente I=IA e niente H=human. Bruciati
// per lo stesso motivo `^M` (Enter), `^J` (LF), `^[` (Esc). Tutto il resto passa
// pulito, `^S`/`^Q` inclusi: il raw mode di Ink disattiva il flow-control XON/XOFF
// che altrimenti se li mangerebbe il terminale.
const SEARCH_TOGGLE_KEYS = {
  r: 'regex',
  a: 'caseSensitive',
  w: 'wholeWord',
} as const;

const SEARCH_KIND_KEYS: Record<string, BodyKind> = { b: 'ai', t: 'tool', u: 'human' };

const KIND_LABEL: Record<BodyKind, string> = { ai: 'IA', tool: 'tools', human: 'human' };

// T41 — ordine dei valori nel modale edit. Deliberatamente DIVERSO da
// PRI_ENTRIES/PROG_ENTRIES (che seguono il rango di sort): qui si sceglie un
// valore, non si ordina, quindi vince l'ordine del CICLO DI VITA — da fare →
// in corso → chiusa → bloccata. La priorità resta alta→bassa, che è già
// l'ordine naturale di lettura.
const EDIT_PRI: readonly PriName[] = ['high', 'med', 'low'];
const EDIT_PROG: readonly ProgName[] = ['todo', 'wip', 'done', 'locked'];

function isDone(prog: string): boolean {
  return prog.includes('✔');
}

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
const NO_SPAWN = process.env.LOOM_DECK_NO_SPAWN === '1';

function spawnOut(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
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
type PromptKind = 'none' | 'recap' | 'preflight' | 'run';

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
// sessionId pinnato (T27) → il binding sidecar è deterministico allo spawn.
// Il kind è OBBLIGATORIO e non ha default qui: il default vive in deck-run (per
// le invocazioni a mano), mentre dal deck ogni tasto dichiara il proprio intento
// — un default silenzioso renderebbe indistinguibili `⏎` e `^K`.
function spawnDeck(id: string, cwd: string, sessionId: string, kind: PromptKind) {
  const child = spawnOut(DECK_RUN, [id, '--session-id', sessionId, '--prompt-kind', kind], {
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
function spawnDeckResume(
  taskId: string | null,
  cwd: string,
  sessionId: string,
  note?: string,
) {
  const args = taskId ? [taskId, '--resume', sessionId] : ['--no-task', '--resume', sessionId];
  if (note) args.push('--title-note', note);
  const child = spawnOut(DECK_RUN, args, { cwd, detached: true, stdio: 'ignore' });
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
function spawnDeckFork(taskId: string | null, cwd: string, originId: string, newId: string) {
  const args = [
    ...(taskId ? [taskId] : ['--no-task']),
    '--resume',
    originId,
    '--fork',
    '--session-id',
    newId,
  ];
  const child = spawnOut(DECK_RUN, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// T42 — sessione Claude NUDA: nessuna task, nessun prompt iniziale, nessun
// sessionId pinnato (quindi nessuna entry nel sidecar session-tasks.jsonl: senza
// task non c'è nulla da legare). Funzione separata e non un parametro opzionale
// di spawnDeck: i tre argomenti mancano tutti insieme, un `if` per ciascuno
// sporcherebbe il percorso bound. Il titolo tab resta la label loom — lo mette
// deck-run, perché il match compass è window-level e non sa nulla di task.
function spawnClaudeEmpty(cwd: string) {
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
function runLaunch(entry: LaunchEntry, cwd: string) {
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
function spawnTerminal(cwd: string, title: string | null) {
  const args = title ? ['--tab', '-T', title, '-d', cwd] : ['--tab', '-d', cwd];
  const child = spawnOut('ptyxis', args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// Comando claude (override per ambienti dove non è su PATH; loom-deck → NPM).
const CLAUDE_CMD = process.env.LOOM_DECK_CLAUDE_CMD ?? 'claude';

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
function spawnCreateTask(
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
function commitTaskEdit(
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

// Dimensioni del terminale, live sul resize.
//
// Non è una comodità di layout: senza `rows` il frame non ha tetto, e un frame
// più alto del terminale fa cadere Ink nel ramo `clearTerminal` (ink.js:121)
// che su VTE/Ptyxis riversa ogni redraw nello scrollback.
//
// Il valore iniziale conta quanto il resize: una tab Ptyxis appena aperta parte
// spesso a 24 righe e riceve il SIGWINCH subito dopo. Nella finestra fra i due
// il deck disegnava già a piena altezza — motivo per cui lo scrollback risultava
// sporco fin dall'avvio, prima ancora di toccare un tasto.
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
    stdout.on('resize', onResize);
    onResize(); // allinea se il resize è arrivato prima del mount
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

// Carica tasks.md e lo ri-legge quando cambia sotto (poll su mtime). Poll
// (non fs.watch) perché i writer di tasks.md — checkpoint-task/create-task —
// riscrivono il file (probabile replace atomico), che rompe il watch sull'inode
// originale; statSync(path) segue sempre il file corrente al path.
function useTasks(tasksPath: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let lastMtime = -1;
    const reload = () => {
      try {
        const mtime = statSync(tasksPath).mtimeMs;
        if (mtime === lastMtime) return; // invariato → niente re-read
        lastMtime = mtime;
        setTasks(loadTasks(tasksPath));
        setLoadError('');
      } catch {
        lastMtime = -1; // così quando il file riappare viene ri-letto
        setTasks([]);
        setLoadError(`tasks.md non leggibile: ${tasksPath}`);
      }
    };
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [tasksPath]);

  return { tasks, loadError };
}

// Poll delle sessioni del progetto + binding sidecar. discoverProjectSessions
// ha cache mtime-keyed interna → il poll è economico; qui si evita comunque il
// re-render inutile con una signature (sessionId:ts + binding entries): setState
// solo quando cambia davvero qualcosa.
function useSessions(projectRoot: string) {
  const [state, setState] = useState<{
    sessions: Session[];
    bindings: Map<string, string>;
    forkOf: Map<string, string>;
    pinned: Map<string, number>;
    notes: Map<string, string>;
  }>({
    sessions: [],
    bindings: new Map(),
    forkOf: new Map(),
    pinned: new Map(),
    notes: new Map(),
  });
  // T50 — pin/unpin scrive il sidecar e vuole feedback IMMEDIATO, non al
  // prossimo tick del poll (1.5s): la reload è esposta via ref così il toggle la
  // richiama senza risottoscrivere l'intervallo.
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let lastSig = '';
    const reload = () => {
      let sessions: Session[];
      let index: SessionIndex;
      try {
        sessions = discoverProjectSessions(projectRoot);
        index = loadSessionIndex(projectRoot);
      } catch {
        sessions = [];
        index = { bindings: new Map(), forkOf: new Map(), pinned: new Map(), notes: new Map() };
      }
      const { bindings, forkOf, pinned, notes } = index;
      // La signature copre anche fork, pin e note: un record di lineage, un
      // toggle di pin o una nota appena scritta cambiano la lista renderizzata,
      // quindi devono forzare il re-render come farebbe un binding nuovo.
      const sig =
        sessions.map((s) => `${s.sessionId}:${s.ts}`).join('|') +
        '#' +
        [...bindings.entries()].map(([k, v]) => `${k}=${v}`).sort().join(',') +
        '#' +
        [...forkOf.entries()].map(([k, v]) => `${k}<${v}`).sort().join(',') +
        '#' +
        [...pinned.entries()].map(([k, v]) => `${k}@${v}`).sort().join(',') +
        '#' +
        [...notes.entries()].map(([k, v]) => `${k}"${v}`).sort().join(',');
      if (sig === lastSig) return;
      lastSig = sig;
      setState({ sessions, bindings, forkOf, pinned, notes });
    };
    reloadRef.current = reload;
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [projectRoot]);

  return { ...state, reload: () => reloadRef.current() };
}

// T61 — conteggio delle Done oltre soglia, su una scala di refresh TUTTA SUA.
//
// Non è appeso a POLL_MS (1,5s) come tasks.md e le sessioni: l'età di una task
// cambia una volta al giorno, e ogni giro costa la lettura di N task file più
// qualche spawn di git. Due trigger:
//
//   · quando cambia l'INSIEME delle task Done (`doneSig`) — copre l'avvio, dove
//     il primo render ha `tasks` ancora vuoto, e la chiusura di una task, dove
//     il numero deve muoversi senza aspettare ore;
//   · ogni SCAN_INTERVAL_MS — copre il caso opposto, in cui non cambia nulla
//     sul disco ed è il calendario a far scattare una task oltre soglia.
//
// `doneSig` è una stringa, non l'array: `tasks` cambia identità a ogni re-read
// di tasks.md, e usarlo come dipendenza rimetterebbe lo scan sul tick da 1,5s
// per la via di dietro.
function useArchivable(doneSig: string, tasksDir: string, projectRoot: string, days: number) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const ids = doneSig ? doneSig.split(',') : [];
    const scan = () => {
      countArchivable(ids, { tasksDir, projectRoot, days })
        .then((n) => {
          if (alive) setCount(n);
        })
        // Scan fallito (task file illeggibili, git muto) → 0, cioè segmento
        // omesso. Un contatore informativo non merita un errore a schermo.
        .catch(() => {
          if (alive) setCount(0);
        });
    };
    scan();
    const id = setInterval(scan, SCAN_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [doneSig, tasksDir, projectRoot, days]);
  return count;
}

// Legge il task file della task selezionata (Q1+B T20). On-id-change: navigare
// con ↑↓ ricarica il dettaglio; leggere un singolo file 4-9KB è I/O triviale,
// niente debounce serve per la tastiera. Il refresh del contenuto a file fermo
// (es. checkpoint aggiorna Progress) è demandato al prossimo cambio selezione.
function useTaskDetail(tasksDir: string, id: string | undefined) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  useEffect(() => {
    setDetail(id ? loadTaskDetail(tasksDir, id) : null);
  }, [tasksDir, id]);
  return detail;
}

// Glifi LETTERALI del JSX. I dati passano dai loader, che sanificano al
// confine; questi no — quindi passano da `sanitize` una volta qui, così nessun
// sito di render scrive un glifo nudo. `↳ ○ ▸ ⏎ · − ↑ ↓` sono già concordi e
// restano intatti; `▶` e `⚠` sono discordi e vengono sostituiti (`width.ts`).
const CARET = sanitize('▶ ');
const CARET_OFF = '  ';
const WARN = sanitize('⚠');
// T50 — separatore leggero fra blocco pinnate e contestuali. `─` (box-drawing) è
// largo 1 sia per string-width sia per il terminale. Corto +
// wrap="truncate-end" così non va mai a capo nel pane al 50%.
const SESSION_SEP = '─'.repeat(16);
// Prefisso del sessionId mostrato in lista: stesso dato e stessa lunghezza del
// widget `⛓ <8 char>` della statusline, così le due superfici si confrontano a
// occhio.
const SID_CHARS = 8;

/** T60 — segnaposto della colonna task su una riga senza binding. Una cella
 *  vuota di soli spazi lascerebbe un buco che si legge come "colonna finita",
 *  e la riga tornerebbe a sembrare disallineata pur non essendolo. */
const TASK_EMPTY = '·';

// Marker Done per il DISPLAY. `task.prog` resta il `✔️` letto da tasks.md —
// `isDone()` e le lookup di `view.ts` ci confrontano sopra, e `task-edit` lo
// riscrive sul file: è una chiave semantica, non testo. Qui `sanitize` lo
// traduce nel suo gemello concorde (`✅`) solo per finire nel frame.
function displayProg(prog: string): string {
  return sanitize(prog);
}

// T49 — size umana compatta per il detail pane sessione.
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// T49 — ultima attività ESTESA (giorno/mese ora:minuti) per il detail pane;
// nella riga di lista resta il relTime compatto.
function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Età relativa compatta (ms epoch → "2m"/"3h"/"5d") per il preview sessioni.
function relTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * Ripulisce un chunk di stdin prima di scriverlo in un campo di testo.
 *
 * `useInput` consegna il CHUNK letto da stdin, non un tasto: un incollaggio — o
 * una raffica piu' veloce di una read — arriva come stringa unica, byte di
 * controllo compresi. Non si vedono a schermo, ma Ink li conta nella larghezza
 * della riga, e in un campo che finisce su disco (la nota, T53) resterebbero
 * li' per sempre. Le newline diventano SPAZIO invece di sparire: incollare due
 * righe deve separare le parole, non fonderle.
 */
function sanitizeTyped(s: string): string {
  return s.replace(/[\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
}

const META_KEYS = ['Priority', 'Size', 'Estimated Time', 'Progress'];

function Deck({ cwd, tasksPath, tasksDir }: { cwd: string; tasksPath: string; tasksDir: string }) {
  const { exit } = useApp();
  const { tasks, loadError } = useTasks(tasksPath);
  // `notes` esce dall'indice come `sessionNotes`: in questo componente `note` è
  // già la riga di STATO in fondo al frame (il feedback di un'azione). Due
  // concetti diversi a una lettera di distanza sarebbero una trappola di
  // lettura — e di scrittura, visto che `setNote` compare in quasi ogni ramo.
  const {
    sessions,
    bindings,
    forkOf,
    pinned,
    notes: sessionNotes,
    reload: reloadSessions,
  } = useSessions(cwd);
  const [focus, setFocus] = useState<Focus>('tasks');
  // T39 — selezione KEYED SU ID, non su indice. Con una vista trasformata
  // (filtro/sort) l'indice non identifica più la stessa task: leggere l'array
  // grezzo per posizione spawnerebbe la task sbagliata, in silenzio.
  // T59 — e le righe meta sono sentinelle, non `null`: gli stati sono tre.
  // D4 — si apre su `≡ tutte`: la vista più ampia in cima, poi si scende verso
  // i sottoinsiemi. La selezione non è persistita (a differenza di `view`, T39),
  // quindi questo atterraggio vale a ogni avvio.
  const [sel, setSel] = useState<Parent>(ALL);
  // T50 — selezione del pane sessioni KEYED SU sessionId (non indice): la lista
  // a due gruppi + separatore è una vista trasformata, un indice grezzo punterebbe
  // alla riga sbagliata dopo un pin o un cambio di contesto (stesso trap T39).
  const [selSessionId, setSelSessionId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // Modali: catturano i tasti e corto-circuitano la navigazione normale.
  // T30 create · T39 sort/filter.
  const [mode, setMode] = useState<Mode>('normal');
  const [draft, setDraft] = useState('');
  // T53 — bozza della nota sulla conversazione selezionata. Si apre PRECARICATA
  // con la nota esistente: annotare due volte è quasi sempre correggere, non
  // riscrivere da zero, e un campo vuoto costringerebbe a ridigitare tutto per
  // cambiare una parola. Confermare il campo vuoto cancella la nota.
  const [noteDraft, setNoteDraft] = useState('');
  // T39 — vista corrente (filtri + sort) e sua fotografia all'apertura di un
  // modale: la lista si aggiorna dal vivo, quindi `esc` deve poter ripristinare.
  const [view, setView] = useState<ViewState>(() => loadView(cwd));
  const [viewBackup, setViewBackup] = useState<ViewState | null>(null);
  const [filterCursor, setFilterCursor] = useState<FilterCursor>({ row: 0, col: 0 });
  // T41 — bozza dell'edit (null fuori dal modale) e riga attiva della griglia.
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editRow, setEditRow] = useState<EditRow>(0);

  // T52 — stato del modale ricerca. VOLATILE per decisione (D4): vive in
  // memoria, quindi riaprendo il modale ritrovi query e toggle come li avevi
  // lasciati, ma un riavvio del deck riporta ai default. Niente schema nuovo su
  // `deck-view.json` e nessuna scrittura implicita su disco — che
  // contraddirebbe la regola T39 «il disco si tocca solo su `w`», qui non
  // trasportabile perché dentro il modale `w` è un carattere digitabile.
  const [searchHash, setSearchHash] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchField, setSearchField] = useState<SearchField>('query');
  const [searchOpts, setSearchOpts] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [searchSelKey, setSearchSelKey] = useState<string | null>(null);
  // Occorrenza aperta nel reader; null = reader chiuso. Tenerla separata dalla
  // selezione della lista è ciò che permette a `esc` di tornare indietro
  // trovando la lista esattamente com'era.
  const [readerRow, setReaderRow] = useState<SearchRow | null>(null);
  const [readerTop, setReaderTop] = useState(0);

  // T57 — stato del modale di assegnazione sessione → task.
  //
  // `assignSid` è la conversazione in assegnazione, FOTOGRAFATA all'apertura e
  // non riletta da `selSessionId`: il modale è fullscreen (D3), quindi il pane
  // sessioni non è più a schermo e l'oggetto dell'azione deve restare quello
  // che si è scelto — anche se un tick del poll rimescolasse la lista sotto.
  // `assignSel` è la task di destinazione: `null` è la riga `detach` (D2), che
  // sta sempre in testa e scrive un binding vuoto.
  const [assignSid, setAssignSid] = useState<string | null>(null);
  const [assignFilter, setAssignFilter] = useState('');
  const [assignSel, setAssignSel] = useState<string | null>(null);

  // Dimensioni vive del terminale: sono l'input del budget d'altezza sotto.
  const { rows, columns } = useTerminalSize();

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
  // Identità (T37): titolo delle tab terminale spawnate col tasto `t`.
  const identity = useMemo(() => loadIdentity(cwd), [cwd]);
  // T53 — il core che ogni titolo di tab porta, quindi la colonna costante da
  // togliere quando serve spazio. Hoistato qui perché ora lo consumano DUE
  // schermate (lista e ricerca): calcolarlo su ogni call site è il modo in cui
  // le due smettono di togliere la stessa cosa.
  // T58 — il core è il solo `name`, non `<emoji> <name>` come la chiave di match
  // di compass: qui non serve entropia (è un taglio cosmetico, non un matcher) e
  // il nome nudo ripulisce anche i titoli storici, scritti quando la formula
  // includeva l'owner.
  const projectCore = identity ? identity.name : null;
  // La vista è una trasformazione DERIVATA, applicata a valle del load: il
  // polling di tasks.md continua a funzionare senza saperne nulla.
  const { visible: viewTasks, hidden: hiddenTasks } = useMemo(
    () => applyView(tasks, view),
    [tasks, view],
  );

  // T61 — il conteggio guarda la lista GREZZA, non `viewTasks`: le Done fuori
  // dai filtri della vista restano archiviabili, e un contatore che cambiasse
  // filtrando direbbe qualcosa sulla vista invece che sulla task list.
  const doneSig = useMemo(
    () => tasks.filter((t) => isDone(t.prog)).map((t) => t.id).join(','),
    [tasks],
  );
  const archivableDays = useMemo(() => loadArchivableDays(cwd), [cwd]);
  const archivable = useArchivable(doneSig, tasksDir, cwd, archivableDays);

  const isSpot = sel === SPOT;
  const isAll = sel === ALL;
  const projectName = cwd.split('/').pop() || cwd;
  // Unica fonte della selezione: si legge SEMPRE dalla vista, mai dall'array
  // grezzo — è l'invariante che tiene allineati dettaglio mostrato e spawn.
  const selTask = typeof sel === 'string' ? viewTasks.find((t) => t.id === sel) ?? null : null;
  const selectedTaskId = selTask?.id ?? null;
  const selIndex = selTask ? viewTasks.indexOf(selTask) + META_ROWS : isAll ? ROW_ALL : ROW_SPOT;
  const detail = useTaskDetail(tasksDir, selectedTaskId ?? undefined);

  // Conteggio figli per task + spot (badge nel Tasks pane).
  const childCount = new Map<string, number>();
  let spotCount = 0;
  for (const s of sessions) {
    const bound = bindings.get(s.sessionId);
    if (bound) childCount.set(bound, (childCount.get(bound) ?? 0) + 1);
    else spotCount++;
  }

  // Figli della selezione: tutte le conversazioni del progetto (`≡ tutte`), le
  // sessioni bound alla task selezionata, oppure (spot) quelle senza binding.
  // sessions è già ts desc → l'ordine si eredita in tutti e tre i rami.
  // Memoizzato così `sessionRows` resta stabile fra render che non cambiano gli
  // input: l'effect di validità della selezione non rigira a vuoto.
  const childSessions = useMemo(
    () =>
      isAll
        ? sessions
        : sessions.filter((s) => {
            const bound = bindings.get(s.sessionId);
            return selectedTaskId ? bound === selectedTaskId : !bound;
          }),
    [sessions, bindings, selectedTaskId, isAll],
  );
  // T50 — lista a due gruppi: pinnate (sempre, in cima) + separatore +
  // contestuali. Dedup, cap solo sulle contestuali, righe stale per le pinnate
  // orfane. Core PURO in session-list.ts (testabile senza Ink).
  const assembled = useMemo(
    () => assembleSessionList(childSessions, sessions, pinned, isAll ? MAX_SESSIONS_ALL : MAX_SESSIONS),
    [childSessions, sessions, pinned, isAll],
  );
  const sessionRows = assembled.rows;
  const selSessionObj = selectedSession(sessionRows, selSessionId);

  // T60 — larghezze delle colonne fisse della lista sessioni, misurate sulla
  // lista INTERA e non sulla finestra visibile: derivarle dalle sole righe a
  // schermo le farebbe cambiare a ogni scroll, cioè l'opposto di una tabella.
  // La colonna task esiste solo nella vista "tutte" (altrove il binding è lo
  // stesso su ogni riga e sta già nell'header del pane), e `0` la spegne.
  const sessionCols = useMemo(() => {
    let task = 0;
    let age = 2;
    for (const r of sessionRows) {
      if (r.kind === 'separator') continue;
      // La colonna serve dove l'appartenenza NON è già scritta altrove sullo
      // schermo: nella vista "tutte" (ogni riga ha un binding proprio) e su
      // OGNI riga pinnata, in qualunque vista — una pinnata è sganciata dal
      // parent selezionato, quindi l'header del pane non parla per lei.
      if (isAll || r.kind === 'pinned') {
        const b = bindings.get(r.sessionId);
        if (b) task = Math.max(task, termWidth(b));
      }
      if (r.session) age = Math.max(age, termWidth(relTime(r.session.ts)));
    }
    // La cella vuota deve poter entrare nella colonna, o le righe spot
    // perderebbero il segnaposto e con lui l'allineamento.
    return { task: task > 0 ? Math.max(task, termWidth(TASK_EMPTY)) : 0, age };
  }, [sessionRows, bindings, isAll]);

  // T52 — ricerca EAGER: rigira a ogni carattere digitato, non su ⏎. È
  // sostenibile perché i corpi sono già in RAM dentro la cache mtime-keyed
  // dell'adapter (D5): misurato su questo progetto, 0,8 ms sui soli corpi IA e
  // ≤9 ms su tutti i tipi — sotto il tempo fra due battute. Il memo evita di
  // rifarla sui re-render che non toccano né query né opzioni (il poll delle
  // sessioni ogni 1,5s è già filtrato dalla signature in `useSessions`).
  const searchResult: SearchResult = useMemo(
    () => searchSessions(sessions, searchHash, searchQuery, searchOpts, searchExcerptWidth(columns)),
    [sessions, searchHash, searchQuery, searchOpts, columns],
  );
  // Con l'hash valorizzato la conversazione è una sola e già nominata nel campo:
  // la riga-sessione ripeterebbe un dato costante rubando una riga per gruppo.
  const searchFlat = searchHash.trim().length > 0;
  const searchRows = useMemo(
    () => buildRows(searchResult, searchFlat),
    [searchResult, searchFlat],
  );

  // T52 — riga selezionata e, se è un'occorrenza, il suo corpo wrappato per
  // l'anteprima sotto la lista. Memoizzato per (testo, larghezza): navigando
  // con le frecce si ri-wrappa solo quando cambia davvero l'occorrenza.
  const searchSelRow = useMemo(
    () => selectedRow(searchRows, searchSelKey),
    [searchRows, searchSelKey],
  );
  const searchPreviewWidth = Math.max(20, (columns || 80) - 8);
  const searchPreviewBody = useMemo(
    () =>
      searchSelRow?.kind === 'hit'
        ? wrapWithOffsets(searchSelRow.hit.text, searchPreviewWidth)
        : [],
    [searchSelRow, searchPreviewWidth],
  );

  // T52 — corpo del messaggio aperto nel reader, wrappato UNA volta per (testo,
  // larghezza). Senza memo ogni pressione di freccia rifarebbe l'a-capo di un
  // messaggio che nella coda lunga arriva a 150k char.
  const readerWidth = Math.max(20, (columns || 80) - 6);
  const readerLines = useMemo(
    () => (readerRow?.kind === 'hit' ? wrapWithOffsets(readerRow.hit.text, readerWidth) : []),
    [readerRow, readerWidth],
  );
  const readerCap = readerCapacity(rows);
  const readerMaxTop = Math.max(0, readerLines.length - readerCap);

  // T57 — righe del modale assegnazione: `null` (detach) in testa, poi le task
  // della VISTA corrente (D4 — filtri e sort inclusi, coerenza con ciò che si
  // stava leggendo a sinistra; le escluse restano contate nell'header).
  //
  // Il filtro è un substring case-insensitive su id + titolo grezzo (D5): un
  // restringimento veloce, non una ricerca — quella è `^F` e ha il suo motore.
  // Il solo id non basterebbe, perché il caso d'uso nasce proprio dal «ho
  // capito ora che questa conversazione è la task del titolo X».
  //
  // `detach` NON si filtra: è l'azione di svuotamento, non una task, e sparire
  // digitando la renderebbe raggiungibile solo a campo vuoto.
  const assignRows = useMemo<Array<Task | null>>(() => {
    const q = assignFilter.trim().toLowerCase();
    const matched = q
      ? viewTasks.filter(
          (t) => t.id.toLowerCase().includes(q) || t.rawDesc.toLowerCase().includes(q),
        )
      : viewTasks;
    return [null, ...matched];
  }, [viewTasks, assignFilter]);
  const assignCap = assignListCapacity(rows, Boolean(note));

  // T39 — selezione stabile sotto trasformazione. Se la task selezionata esce
  // dalla vista (filtro appena attivato, oppure sparita da tasks.md), si cade
  // sulla prima visibile — fallback deterministico, mai una posizione a caso.
  useEffect(() => {
    if (typeof sel === 'string' && !viewTasks.some((t) => t.id === sel)) {
      setSel(viewTasks[0]?.id ?? ALL);
    }
  }, [viewTasks, sel]);
  // T50 — la selezione (id) resta valida sotto la vista a due gruppi: se l'id
  // non è più una riga selezionabile (cambio parent, lista mutata, pin rimosso,
  // sessione sparita) cade sulla prima riga — fallback deterministico, mai una
  // posizione a caso. Sostituisce il reset-a-0 e il clamp index-based.
  useEffect(() => {
    if (rowIndexOf(sessionRows, selSessionId) < 0) {
      setSelSessionId(firstSelectableId(sessionRows));
    }
  }, [sessionRows, selSessionId]);
  // T52 — stessa invariante sulla lista occorrenze, dove è ancora più stretta:
  // la lista si RICOSTRUISCE a ogni carattere digitato, quindi la chiave
  // selezionata sparisce continuamente. Persa → prima riga, mai una posizione
  // ereditata (che qui punterebbe a un'altra conversazione, non a un'altra riga).
  useEffect(() => {
    if (rowIndexOfKey(searchRows, searchSelKey) < 0) {
      setSearchSelKey(firstRowKey(searchRows));
    }
  }, [searchRows, searchSelKey]);
  // T57 — la lista del modale si restringe a ogni carattere digitato: quando la
  // task selezionata esce dal filtro si cade sulla PRIMA TASK, non su `detach`.
  // Cadere su detach significherebbe che un `⏎` battuto di slancio dopo aver
  // digitato staccherebbe la sessione invece di assegnarla — l'esatto opposto
  // dell'intenzione. Senza match la selezione resta detach: è l'unica riga viva.
  useEffect(() => {
    if (assignSel !== null && !assignRows.some((t) => t?.id === assignSel)) {
      setAssignSel(assignRows[1]?.id ?? null);
    }
  }, [assignRows, assignSel]);

  // T30: submit dell'input box. Il taskId nasce DOPO create-task (lo assegna la
  // skill scrivendo tasks.md) → non è noto allo spawn. Il sessionId invece è
  // pinnato qui: snapshot degli id PRIMA, poi al completamento re-leggo tasks.md
  // e il diff dà il nuovo id → appendTaskBinding lega la sessione (scoped).
  function submitCreate() {
    const text = draft.trim();
    setMode('normal');
    setDraft('');
    if (!text) {
      setNote('C → create annullato (vuoto)');
      return;
    }
    const sid = randomUUID();
    const beforeIds = new Set(tasks.map((t) => t.id));
    setNote(`⏳ creando task… "${cut(text, 40)}" (sid ${sid.slice(0, 8)})`);
    const child = spawnCreateTask(text, cwd, sid, (ok) => {
      if (!ok) {
        setNote(`⚠ create-task fallito (${CLAUDE_CMD} -p)`);
        return;
      }
      let newId: string | undefined;
      try {
        newId = loadTasks(tasksPath).find((t) => !beforeIds.has(t.id))?.id;
      } catch {
        // tasks.md illeggibile → id non rilevato, sotto
      }
      if (newId) {
        appendTaskBinding(cwd, sid, newId);
        setNote(`✔ ${newId} creata · sessione scoped (sid ${sid.slice(0, 8)})`);
      } else {
        setNote(`✔ task creata (id non rilevato) · sid ${sid.slice(0, 8)}`);
      }
    });
    child.on('error', () => setNote(`⚠ create-task: '${CLAUDE_CMD}' non lanciabile`));
  }

  // T56 — apre una sessione bound alla task selezionata. Punto UNICO dei quattro
  // tasti (⏎/^K/^P/^R): fra loro cambia solo il prompt iniziale, tutto il resto
  // è identico — uuid pinnato, binding scritto PRIMA dello spawn (la sessione
  // risulta figlia della task appena il JSONL compare), handler d'errore, nota.
  // Quattro copie sarebbero quattro posti dove dimenticare il `child.on('error')`,
  // e uno spawn fallito è async: senza handler diventa uncaughtException e
  // ucciderebbe il deck, che invece deve restare vivo.
  // La guardia di focus sta qui e non nei chiamanti perché l'oggetto dell'azione
  // è la task SELEZIONATA: senza il pane task a fuoco non ce n'è una. Per `⏎` il
  // ramo è irraggiungibile (ci arriva già dentro `focus === 'tasks'`); per i tre
  // CTRL, che il ramo `key.ctrl` intercetta globalmente, è l'unico posto.
  function spawnTaskSession(kind: PromptKind, keyLabel: string) {
    if (focus !== 'tasks') {
      setNote(`${keyLabel} → spawn: seleziona una task (←→ per il pane)`);
      return;
    }
    // T59 — la guardia è "non è una task", non "è spot": le righe meta sono due
    // e nessuna delle due ha una task da aprire. Il messaggio dice quale delle
    // due, perché il motivo è diverso (vista di sola lettura vs sessioni libere).
    if (isAll || isSpot) {
      setNote(
        isAll
          ? 'tutte: vista di sola lettura, nessuna task da spawnare'
          : 'spot: sessioni libere, nessuna task da spawnare',
      );
      return;
    }
    if (!selTask) return;
    const task = selTask;
    const sid = randomUUID();
    appendTaskBinding(cwd, sid, task.id);
    const child = spawnDeck(task.id, cwd, sid, kind);
    child.on('error', () => setNote(`⚠ spawn ${task.id} fallito (${DECK_RUN})`));
    const what = kind === 'none' ? '' : ` · ${kind}`;
    setNote(`${keyLabel} spawn ${task.id}${what} → tab CC (sid ${sid.slice(0, 8)})`);
  }

  // T53 — apertura del modale nota sulla conversazione selezionata. Come
  // `openEdit`, la bozza parte dal valore ATTUALE: annotare una seconda volta è
  // quasi sempre correggere, e ripartire da vuoto costringerebbe a ridigitare
  // tutto per cambiare una parola.
  function openNote() {
    if (!selSessionId) return;
    setNoteDraft(sessionNotes.get(selSessionId) ?? '');
    setNote('');
    setMode('note');
  }

  // T53 — ⏎ nel modale nota: scrive il sidecar e ricarica subito, senza
  // attendere il tick del poll (stesso feedback immediato del pin).
  //
  // Il campo VUOTO non è un annullamento: è la CANCELLAZIONE della nota. Sono
  // due intenzioni diverse e hanno due tasti diversi — `esc` lascia tutto com'è,
  // `⏎` su campo svuotato toglie la nota. Trattare il vuoto come un no-op (come
  // fa `submitCreate`, dove però una task senza titolo non esiste) renderebbe
  // impossibile disannotare una conversazione se non con un editor sul JSONL.
  function submitNote() {
    const sid = selSessionId;
    const text = noteDraft.trim();
    setMode('normal');
    setNoteDraft('');
    if (!sid) return;
    appendNote(cwd, sid, text);
    reloadSessions();
    setNote(
      text
        ? `✎ nota su ${sid.slice(0, 8)}: "${cut(text, 40)}"`
        : `✎ nota rimossa da ${sid.slice(0, 8)}`,
    );
  }

  // T57 — apertura del modale di assegnazione. La preselezione è la task a cui
  // la sessione è GIÀ legata (riassegnare è quasi sempre correggere, e vedere da
  // dove si parte è metà dell'informazione), altrimenti la prima della vista.
  // Mai `detach`: è l'azione distruttiva della lista, e preselezionarla
  // metterebbe un `⏎` battuto di slancio a un tasto dal cancellare un binding.
  function openAssign() {
    const sid = selSessionId;
    if (!sid) return;
    const bound = bindings.get(sid);
    setAssignSid(sid);
    setAssignFilter('');
    setAssignSel(bound && viewTasks.some((t) => t.id === bound) ? bound : viewTasks[0]?.id ?? null);
    setNote('');
    setMode('assign');
  }

  // Sposta la selezione del modale sulle righe (0 = detach, 1..N = task filtrate).
  function moveAssign(delta: number) {
    const at = assignRows.findIndex((t) => (t?.id ?? null) === assignSel);
    const next = Math.max(0, Math.min(assignRows.length - 1, (at < 0 ? 0 : at) + delta));
    setAssignSel(assignRows[next]?.id ?? null);
  }

  // T57 — ⏎ nel modale: riscrive il binding nel sidecar e ricarica subito.
  //
  // Il binding retroattivo governa il FUTURO della conversazione, non il suo
  // passato: il titolo della tab è stato deciso allo spawn da `claude --name` e
  // vive nel transcript, la `LOOM_TASK` di un processo già partito non si
  // reinietta. Cambia cosa fa il prossimo `⏎ resume`, che rilegge il binding dal
  // sidecar. La nota lo dice: senza, la promessa implicita è «ho spostato la
  // conversazione» e il titolo che non cambia sembra un bug.
  //
  // Dove atterra la selezione (D6): il pane task non si muove, quindi la
  // sessione appena assegnata esce dal gruppo contestuale → si scende alla riga
  // SUCCESSIVA, catturata PRIMA della riscrittura (dopo, la riga non c'è più).
  // Due eccezioni in cui invece resta dov'è, perché non sparisce affatto: una
  // pinnata (esente dal contesto) e un'assegnazione al parent già selezionato.
  function submitAssign() {
    const sid = assignSid;
    const target = assignSel;
    setMode('normal');
    setAssignFilter('');
    if (!sid) return;
    const stays = pinned.has(sid) || target === selectedTaskId;
    const next = stays ? sid : neighborId(sessionRows, sid);
    appendTaskBinding(cwd, sid, target ?? '');
    reloadSessions();
    setSelSessionId(next);
    setNote(
      target
        ? `A ${sid.slice(0, 8)} → ${target} · vale dal prossimo ⏎ resume (titolo tab invariato)`
        : `A ${sid.slice(0, 8)} → spot · binding rimosso`,
    );
  }

  // T41 — apertura dell'edit: la bozza parte dai valori ATTUALI della task, non
  // da default. La priorità arriva dal glifo di tasks.md (già in `selTask`), lo
  // stato dal suo glifo Prog; il progresso arbitrario dal campo `Progress` del
  // task file — ma solo se è davvero custom (vedi `initialDetail`).
  //
  // Il titolo si semina dalla riga di tasks.md e non dall'H1 del task file per
  // due ragioni: è la fonte che esiste SEMPRE (un task file può mancare), ed è
  // il testo che l'utente sta guardando in lista quando preme `E`. Grezzo
  // (`rawDesc`), non sanificato: rimandare a disco la forma sanificata
  // riscriverebbe i glifi anche senza toccare il campo.
  function openEdit() {
    if (!selTask) return;
    const prog = progName(selTask.prog) ?? 'todo';
    setEdit({
      pri: priName(selTask.pri) ?? 'med',
      prog,
      detail: initialDetail(detail?.fields['Progress'] ?? '', prog),
      title: selTask.rawDesc,
      // Si apre sulla riga 0 (priorità), che non è un campo di testo: il caret
      // prende la sua posizione entrando in una riga di testo con ↑↓.
      caret: 0,
    });
    setEditRow(0);
    setNote('');
    setMode('edit');
  }

  // T41 — ⏎ nell'edit: scrive tasks.md + task file, poi committa. Il commit è
  // immediato e non confermato (scelta esplicita: l'edit è una micro-modifica,
  // la storia granulare vale più di un batch). Se nessuno dei due lati è stato
  // scritto non si committa nulla — `paths` vuoto renderebbe `git commit --`
  // un commit di TUTTO il working tree, che è l'opposto di ciò che vogliamo.
  function submitEdit() {
    const task = selTask;
    const draft = edit;
    setMode('normal');
    setEdit(null);
    if (!task || !draft) return;

    // Il titolo si scrive solo se è CAMBIATO davvero: rimandarlo identico
    // riscriverebbe comunque la cella (collassando spazi ed escape) e sporcherebbe
    // il diff di una riga per un edit di sola priorità. Vuoto → scartato: una
    // task senza descrizione in overview non è più riconoscibile.
    const title = draft.title.trim();
    const titleChanged = title.length > 0 && title !== task.rawDesc.trim();

    let res: ReturnType<typeof writeTaskEdit>;
    try {
      res = writeTaskEdit({
        tasksPath,
        tasksDir,
        id: task.id,
        pri: draft.pri,
        prog: draft.prog,
        detail: draft.detail,
        title: titleChanged ? title : undefined,
      });
    } catch (e) {
      setNote(`⚠ ${task.id}: scrittura fallita (${(e as Error).message})`);
      return;
    }
    if (res.paths.length === 0) {
      setNote(`⚠ ${task.id}: nessun campo aggiornabile (riga o task file assenti)`);
      return;
    }

    const summary = `${PRI_GLYPH[draft.pri]} ${PRI_LABEL[draft.pri]} · ${res.progress}${
      titleChanged ? ` · "${cut(sanitize(title), 32)}"` : ''
    }`;
    setNote(`⏳ ${task.id} → ${summary} · commit…`);
    commitTaskEdit(
      cwd,
      res.paths,
      `chore(${task.id}): pri ${PRI_LABEL[draft.pri]} · stato ${res.progress}${
        titleChanged ? ' · titolo' : ''
      }`,
      (ok, err) => {
        setNote(ok ? `✔ ${task.id} → ${summary} · committato` : `⚠ ${task.id} salvato, commit fallito: ${err}`);
      },
    );
  }

  // Chiusura di un modale di vista: `restore` rimette la fotografia scattata
  // all'apertura (esc = annulla), altrimenti tiene ciò che si è composto (⏎).
  function closeViewModal(restore: boolean) {
    if (restore && viewBackup) setView(viewBackup);
    setViewBackup(null);
    setMode('normal');
  }

  // Sposta la selezione di `delta` righe nella VISTA (0 = tutte, 1 = spot,
  // 2..N+1 = task visibili) e la riconverte subito in sentinella o id: l'indice
  // non sopravvive a un cambio di filtro, l'id sì.
  function moveTaskSel(delta: number) {
    const next = Math.max(0, Math.min(viewTasks.length + META_ROWS - 1, selIndex + delta));
    if (next === ROW_ALL) setSel(ALL);
    else if (next === ROW_SPOT) setSel(SPOT);
    else setSel(viewTasks[next - META_ROWS]?.id ?? SPOT);
  }

  // T52 — `⏎` contestuale al TIPO di riga: la lista ne mescola due e l'azione
  // giusta dipende da quale è selezionata. Riga sessione → resume, identico al
  // `⏎` della lista sessioni (stessa funzione, T49). Riga occorrenza → reader.
  function submitSearchRow() {
    const row = selectedRow(searchRows, searchSelKey);
    if (!row) {
      setNote(searchResult.error ? '⚠ regex non valida' : 'nessuna occorrenza selezionata');
      return;
    }
    if (row.kind === 'session') {
      const bound = bindings.get(row.session.sessionId) ?? null;
      const child = spawnDeckResume(
        bound,
        cwd,
        row.session.sessionId,
        sessionNotes.get(row.session.sessionId),
      );
      child.on('error', () => setNote(`⚠ resume fallito (${DECK_RUN})`));
      setNote(
        `⏎ resume ${row.session.sessionId.slice(0, 8)} → tab CC${bound ? ` (${bound})` : ' (spot)'}`,
      );
      return;
    }
    // D8 — il reader si apre POSIZIONATO sull'occorrenza, non in cima. Il 94%
    // dei messaggi entra in una schermata e la differenza non si vede; è sul 6%
    // lungo (p99 ≈ 88 righe, max ≈ 1547) che aprire in cima costringerebbe a
    // rifare a mano la ricerca appena fatta — cioè proprio il lavoro che questa
    // feature esiste per evitare.
    const lines = wrapWithOffsets(row.hit.text, readerWidth);
    const cap = readerCapacity(rows);
    const matchLine = lines.findIndex((l) => l.end > row.hit.matchStart);
    const maxTop = Math.max(0, lines.length - cap);
    setReaderRow(row);
    setReaderTop(
      Math.max(0, Math.min(maxTop, Math.max(0, matchLine) - Math.floor(cap / 2))),
    );
    setNote('');
    setMode('reader');
  }

  function scrollReader(delta: number) {
    setReaderTop((t) => Math.max(0, Math.min(readerMaxTop, t + delta)));
  }

  // T52 — toggle di tipo messaggio. Spegnerli tutti è uno stato lecito (lista
  // vuota, nessun errore): è l'utente che ha chiuso ogni canale, non un guasto.
  function toggleKind(kind: BodyKind) {
    setSearchOpts((o) => ({ ...o, kinds: { ...o.kinds, [kind]: !o.kinds[kind] } }));
  }

  function editSearchField(fn: (s: string) => string) {
    // La nota racconta l'esito di un'AZIONE su una lista che, con l'eager, si
    // ricostruisce a ogni carattere: appena la query cambia è già scaduta.
    // Lasciarla lì la fa leggere come se descrivesse lo stato corrente — nello
    // specifico «nessuna occorrenza selezionata» sopra una lista con una riga
    // visibilmente selezionata, cioè una contraddizione a schermo.
    setNote('');
    if (searchField === 'hash') setSearchHash(fn);
    else setSearchQuery(fn);
  }

  // `useInput` consegna il CHUNK letto da stdin, non un tasto: un incollaggio —
  // o una raffica di tasti piu' veloce di una read — arriva come stringa unica,
  // byte di controllo compresi. Due conseguenze, entrambe verificate su pty:
  //
  //  1. I byte di controllo finiscono DENTRO il campo se non li si filtra. Non
  //     si vedono, ma Ink li conta nella larghezza della riga e nessun match li
  //     soddisfa -> la ricerca smette di trovare senza dire perche'. Le newline
  //     diventano spazio invece di sparire: incollare due righe deve separare
  //     le parole, non fonderle.
  //
  //  2. Un TAB digitato subito dopo una lettera (~60 ms, cioe' battitura veloce
  //     normale) arriva incollato ad essa: `key.tab` resta falso e il ramo del
  //     cambio campo non scatta mai. Trattarlo come testo lo renderebbe uno
  //     spazio, per giunta nel campo sbagliato — e' cosi' che `70897aff` + Tab
  //     + `congelat` finiva tutto quanto nel campo hash.
  //
  // Si spezza quindi il chunk SUL TAB applicando il cambio campo in mezzo: il
  // risultato e' identico alla battitura lenta. Stessa lezione del modale sort
  // (T39), che cicla sui caratteri del chunk invece di leggerlo intero.
  function typeIntoField(chunk: string) {
    setNote('');
    const clean = sanitizeTyped;

    const parts = chunk.split('\t');
    let field = searchField;
    const add: Record<SearchField, string> = { hash: '', query: '' };
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) field = field === 'hash' ? 'query' : 'hash';
      add[field] += clean(parts[k]);
    }
    if (add.hash) setSearchHash((v) => v + add.hash);
    if (add.query) setSearchQuery((v) => v + add.query);
    setSearchField(field);
  }

  const searchCap = searchListCapacity(rows, Boolean(note));

  useInput((input, key) => {
    // T52 — MODALE DENTRO IL MODALE. `useInput` in Ink è globale e non ha
    // focus-trap: non esiste un meccanismo che confini l'input a un componente.
    // La cattura È l'ordine dei rami — quindi il reader va PRIMA della ricerca,
    // e mentre è aperto il modale ricerca resta montato sotto con la sua
    // selezione intatta, pronto a riprendere il controllo su `esc`.
    if (mode === 'reader') {
      if (key.escape) {
        setMode('search');
        setReaderRow(null);
      } else if (key.upArrow) {
        scrollReader(-1);
      } else if (key.downArrow) {
        scrollReader(1);
      } else if (key.pageUp) {
        scrollReader(-readerCap);
      } else if (key.pageDown) {
        scrollReader(readerCap);
      } else if (input === 'g') {
        // Estremi su lettera e non su Home/End: Ink RICONOSCE quelle due (le
        // mappa a 'home'/'end' nel parser) ma NON le espone — `nonAlphanumericKeys`
        // azzera l'input e nessun flag le rappresenta, quindi arrivano
        // indistinguibili da qualunque tasto ignoto. Verificato su pty reale.
        // Nel reader non c'è input di testo, quindi le lettere sono libere.
        setReaderTop(0);
      } else if (input === 'G') {
        setReaderTop(readerMaxTop);
      }
      return;
    }

    // T52 — modale ricerca. I due campi di testo mangiano ogni lettera nuda:
    // ogni comando che deve restare vivo MENTRE si digita passa da CTRL, dai
    // tasti freccia o da Tab. `esc` chiude il modale, non il deck.
    if (mode === 'search') {
      if (key.escape) {
        setMode('normal');
        setNote('');
        return;
      }
      if (key.ctrl) {
        const flag = SEARCH_TOGGLE_KEYS[input as keyof typeof SEARCH_TOGGLE_KEYS];
        if (flag) {
          setSearchOpts((o) => ({ ...o, [flag]: !o[flag] }));
          return;
        }
        const kind = SEARCH_KIND_KEYS[input];
        if (kind) toggleKind(kind);
        return; // ogni altra combo ctrl (^F incluso: siamo già dentro) = no-op
      }
      if (key.tab) {
        setSearchField((f) => (f === 'hash' ? 'query' : 'hash'));
      } else if (key.upArrow) {
        setSearchSelKey((k) => moveRowSelection(searchRows, k, -1));
      } else if (key.downArrow) {
        setSearchSelKey((k) => moveRowSelection(searchRows, k, 1));
      } else if (key.pageUp) {
        setSearchSelKey((k) => moveRowSelection(searchRows, k, -Math.max(1, searchCap)));
      } else if (key.pageDown) {
        setSearchSelKey((k) => moveRowSelection(searchRows, k, Math.max(1, searchCap)));
      } else if (key.return) {
        submitSearchRow();
      } else if (key.backspace || key.delete) {
        editSearchField((s) => s.slice(0, -1));
      } else if (input && !key.meta) {
        typeIntoField(input);
      }
      return;
    }

    // T57 — modale di assegnazione: un campo di filtro più una lista. Come
    // ricerca e nota, il campo mangia ogni lettera nuda → `^U` (kill-line delle
    // shell) per svuotarlo, e la navigazione passa dalle frecce.
    if (mode === 'assign') {
      if (key.escape) {
        setMode('normal');
        setAssignFilter('');
        setNote('A → assegnazione annullata');
      } else if (key.return) {
        submitAssign();
      } else if (key.upArrow) {
        moveAssign(-1);
      } else if (key.downArrow) {
        moveAssign(1);
      } else if (key.pageUp) {
        moveAssign(-Math.max(1, assignCap));
      } else if (key.pageDown) {
        moveAssign(Math.max(1, assignCap));
      } else if (key.ctrl) {
        // `^U` svuota; ogni altra combo è no-op. Il backspace tenuto premuto
        // cancella un carattere per CHUNK letto da stdin, non per pressione
        // (T53): senza `^U` ripulire un filtro digitato di getto sarebbe lento
        // quanto riaprire il modale.
        if (input === 'u') setAssignFilter('');
      } else if (key.backspace || key.delete) {
        setAssignFilter((f) => f.slice(0, -1));
      } else if (input && !key.meta) {
        setAssignFilter((f) => f + sanitizeTyped(input));
      }
      return;
    }

    // T30: in modalità create l'handler cattura il testo e corto-circuita la
    // navigazione normale (incl. q/esc → quit: qui esc annulla, non esce).
    if (mode === 'create') {
      if (key.escape) {
        setMode('normal');
        setDraft('');
        setNote('C → create annullato');
      } else if (key.return) {
        submitCreate();
      } else if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d + input);
      }
      return;
    }

    // T53 — modale nota. Come create, cattura il testo e corto-circuita la
    // navigazione (qui `q` è una lettera da scrivere, non il quit).
    if (mode === 'note') {
      if (key.escape) {
        setMode('normal');
        setNoteDraft('');
        setNote('N → nota annullata');
      } else if (key.return) {
        submitNote();
      } else if (key.ctrl && input === 'u') {
        // Svuota il campo in un colpo. NON è una scorciatoia di comodo: il
        // backspace tenuto premuto cancella UN carattere per CHUNK letto da
        // stdin, non per pressione (`useInput` consegna il chunk, e per una
        // raffica di DEL Ink alza `key.backspace` una volta sola) — misurato,
        // 30 pressioni → 2 caratteri. Siccome «campo vuoto» qui è l'unico modo
        // di CANCELLARE una nota, dipendere dal backspace renderebbe
        // l'operazione praticamente non eseguibile. `^U` è il kill-line delle
        // shell, quindi il gesto è già nelle dita di chi usa un terminale.
        setNoteDraft('');
      } else if (key.backspace || key.delete) {
        setNoteDraft((d) => d.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        // Sanificazione dei byte di controllo, come `typeIntoField` della
        // ricerca: `useInput` consegna il CHUNK letto da stdin, quindi un
        // incollaggio porta dentro newline e control char. Invisibili a schermo
        // ma contati da Ink nella larghezza della riga — e qui finirebbero
        // scritti su disco, dove resterebbero a sporcare la riga per sempre.
        // Le newline diventano spazio: incollare due righe deve separare le
        // parole, non fonderle.
        setNoteDraft((d) => d + sanitizeTyped(input));
      }
      return;
    }

    // T39 — modale sort a grammatica libera: la SEQUENZA di tasti È la chain.
    // Digitare `ppi` = p(asc) p(desc) i(asc) → [pri desc, id asc]. La lista si
    // riordina dal vivo a ogni pressione.
    if (mode === 'sort') {
      if (key.escape) {
        closeViewModal(true);
        setNote('S → sort annullato');
      } else if (key.return) {
        closeViewModal(false);
        setNote(`S → sort: ${describeSort(view.sort)}`);
      } else if (input) {
        // useInput consegna il CHUNK letto da stdin, non un tasto: digitando
        // veloce (o incollando) `ppi` arriva come stringa unica. Si cicla su
        // ogni carattere, così la chain esce identica a battitura lenta.
        const keys = [...input].map((ch) => SORT_TASTI[ch]).filter(Boolean);
        if (keys.length > 0) {
          setView((v) => ({ ...v, sort: keys.reduce(cycleSort, v.sort) }));
        }
      }
      return;
    }

    // T39 — modale filtri: griglia 2 righe (priorità / stato), un toggle per
    // valore. Anche qui l'effetto è immediato sulla lista.
    if (mode === 'filter') {
      const rowLen = (r: 0 | 1) => (r === 0 ? PRI_ENTRIES.length : PROG_ENTRIES.length);
      if (key.escape) {
        closeViewModal(true);
        setNote('F → filtri annullati');
      } else if (key.return) {
        closeViewModal(false);
        setNote(hiddenTasks > 0 ? `F → ${hiddenTasks} task nascoste` : 'F → nessun filtro attivo');
      } else if (key.upArrow || key.downArrow) {
        setFilterCursor((c) => {
          const row: 0 | 1 = c.row === 0 ? 1 : 0;
          return { row, col: Math.min(c.col, rowLen(row) - 1) };
        });
      } else if (key.leftArrow) {
        setFilterCursor((c) => ({ ...c, col: Math.max(0, c.col - 1) }));
      } else if (key.rightArrow) {
        setFilterCursor((c) => ({ ...c, col: Math.min(rowLen(c.row) - 1, c.col + 1) }));
      } else if (input === ' ') {
        const { row, col } = filterCursor;
        setView((v) =>
          row === 0
            ? { ...v, hiddenPri: toggleHidden<PriName>(v.hiddenPri, PRI_ENTRIES[col].name) }
            : { ...v, hiddenProg: toggleHidden<ProgName>(v.hiddenProg, PROG_ENTRIES[col].name) },
        );
      }
      return;
    }

    // T41 — modale edit: griglia a 4 righe. Righe 0/1 = scelta a valore singolo
    // (←→ scorre), righe 2/3 = testo libero (ogni carattere stampabile entra nel
    // campo). Come gli altri modali cattura tutto: `esc` annulla senza
    // scrivere né uscire dal deck.
    if (mode === 'edit') {
      if (key.escape) {
        setMode('normal');
        setEdit(null);
        setNote('E → edit annullato');
      } else if (key.return) {
        submitEdit();
      } else if (key.upArrow || key.downArrow) {
        const next = ((editRow + EDIT_ROWS + (key.upArrow ? -1 : 1)) % EDIT_ROWS) as EditRow;
        setEditRow(next);
        // Il caret segue la riga attiva e atterra in CODA al nuovo campo: è la
        // posizione da cui si continua a scrivere, ed è anche l'unica che non
        // dipende da dove stava il cursore nel campo precedente.
        setEdit((e) => (e && isTextRow(next) ? { ...e, caret: cpLen(e[editField(next)]) } : e));
      } else if ((key.leftArrow || key.rightArrow) && !isTextRow(editRow)) {
        const d = key.leftArrow ? -1 : 1;
        // Scorrimento CICLICO (wrap) e non clampato: le liste sono di 3-4 voci,
        // arrivare in fondo e ripartire costa meno di invertire direzione.
        if (editRow === 0) {
          setEdit((e) =>
            e ? { ...e, pri: EDIT_PRI[(EDIT_PRI.indexOf(e.pri) + d + EDIT_PRI.length) % EDIT_PRI.length] } : e,
          );
        } else if (editRow === 1) {
          setEdit((e) =>
            e
              ? { ...e, prog: EDIT_PROG[(EDIT_PROG.indexOf(e.prog) + d + EDIT_PROG.length) % EDIT_PROG.length] }
              : e,
          );
        }
      } else if (isTextRow(editRow)) {
        // Un solo ramo per i due campi di testo, la riga sceglie la chiave:
        // duplicarlo significherebbe tenere allineate a mano due copie della
        // stessa grammatica di input a ogni tasto aggiunto.
        const field = editField(editRow);
        if (key.ctrl) {
          // T54 — ramo CTRL ANTEPOSTO a quelli su carattere, come in modalità
          // normale: `^A` e `a` arrivano con lo stesso `input`, quindi senza
          // questa precedenza il `^A` finirebbe dentro il testo.
          //
          // `^A`/`^E` (convenzione readline) perché `Home`/`End` NON sono
          // esposte da `useInput`: arrivano come input vuoto, indistinguibili
          // da qualunque altro tasto senza nome.
          //
          // `^D` è il delete-forward, e anche qui il motivo è un limite di Ink:
          // il tasto Backspace fisico manda `\x7f` e il tasto Canc manda
          // `\x1b[3~`, ma `parseKeypress` li battezza ENTRAMBI `delete` e
          // svuota `input` — a valle sono lo stesso evento. `key.delete` va
          // quindi al backspace (il tasto che si usa davvero) e la
          // cancellazione in avanti prende il suo tasto readline.
          if (input === 'a') setEdit((e) => (e ? { ...e, caret: 0 } : e));
          else if (input === 'e') setEdit((e) => (e ? { ...e, caret: cpLen(e[field]) } : e));
          else if (input === 'd') setEdit((e) => (e ? { ...e, [field]: removeAt(e[field], e.caret) } : e));
        } else if (key.leftArrow || key.rightArrow) {
          // CLAMP agli estremi, non wrap: a inizio campo `←` non deve saltare in
          // fondo. Le liste di valori (righe 0/1) ciclano perché sono 3-4 voci;
          // un testo no — il salto sarebbe indistinguibile da uno sfarfallio.
          const d = key.leftArrow ? -1 : 1;
          setEdit((e) =>
            e ? { ...e, caret: Math.max(0, Math.min(cpLen(e[field]), e.caret + d)) } : e,
          );
        } else if (key.backspace || key.delete) {
          setEdit((e) =>
            e ? { ...e, [field]: removeAt(e[field], e.caret - 1), caret: Math.max(0, e.caret - 1) } : e,
          );
        } else if (input && !key.meta) {
          // `sanitizeTyped`: `useInput` consegna il CHUNK di stdin, quindi un
          // incollaggio porta dentro newline e byte di controllo — invisibili
          // nel campo ma contati da Ink nella larghezza della riga, e destinati
          // a finire tali e quali dentro tasks.md. Ed è per lo stesso motivo che
          // il caret avanza della LUNGHEZZA del chunk, non di uno: un incollaggio
          // entra tutto insieme.
          const ins = sanitizeTyped(input);
          setEdit((e) =>
            e ? { ...e, [field]: insertAt(e[field], e.caret, ins), caret: e.caret + cpLen(ins) } : e,
          );
        }
      }
      return;
    }

    // T52/D1 — il ramo CTRL sta PRIMA di quelli su lettera nuda e li chiude
    // tutti. `CTRL+F` e `f` nudo arrivano con lo STESSO `input` ('f'),
    // distinguibili solo da `key.ctrl`: senza questa precedenza `CTRL+F`
    // cadrebbe nel ramo fork e spawnerebbe una sessione invece di aprire la
    // ricerca. Non è un caso isolato della `f` — `^Q` finirebbe nel quit, `^T`
    // aprirebbe un terminale, `^C` … ogni lettera legata a un'azione ha la sua
    // combo omonima. Chiudere qui l'intera classe è più solido che ricordarsi
    // un `!key.ctrl` su ognuno dei rami, oggi e a ogni tasto aggiunto domani.
    if (key.ctrl) {
      if (input === 'f') {
        setNote('');
        setMode('search');
      } else if (input === 'k') {
        spawnTaskSession('recap', '^K');
      } else if (input === 'p') {
        spawnTaskSession('preflight', '^P');
      } else if (input === 'r') {
        spawnTaskSession('run', '^R');
      }
      return;
    }

    if (key.leftArrow || key.rightArrow || key.tab) {
      setFocus((f) => (f === 'tasks' ? 'sessions' : 'tasks'));
    } else if (key.upArrow) {
      if (focus === 'tasks') moveTaskSel(-1);
      else setSelSessionId((id) => moveSelection(sessionRows, id, -1));
    } else if (key.downArrow) {
      if (focus === 'tasks') moveTaskSel(1);
      else setSelSessionId((id) => moveSelection(sessionRows, id, 1));
    } else if (key.return) {
      if (focus === 'tasks') {
        // T56 — ⏎ apre la sessione a MANI NUDE: bound alla task (LOOM_TASK,
        // sessionId pinnato, binding) ma senza messaggio iniettato — il contesto
        // lo carica l'hook SessionStart, il primo messaggio lo scrive l'utente.
        // Il recap che ⏎ faceva prima è passato a ^K: resta a un tasto, ma smette
        // di essere l'unico ingresso possibile nella task.
        spawnTaskSession('none', '⏎');
      } else {
        // T49 — ⏎ su una sessione = resume in nuova tab. Il binding si rilegge
        // dal sidecar (non dal padre selezionato): vale anche per le spot.
        const s = selSessionObj;
        if (!s) {
          setNote(selSessionId ? 'pin stale: transcript non più presente' : 'nessuna sessione da riprendere');
        } else {
          const bound = bindings.get(s.sessionId) ?? null;
          const child = spawnDeckResume(bound, cwd, s.sessionId, sessionNotes.get(s.sessionId));
          child.on('error', () => setNote(`⚠ resume fallito (${DECK_RUN})`));
          setNote(
            `⏎ resume ${s.sessionId.slice(0, 8)} → tab CC${bound ? ` (${bound})` : ' (spot)'}`,
          );
        }
      }
    } else if (input === 'C') {
      setNote('');
      setMode('create');
    } else if (input === 'E') {
      // L'edit ha senso solo su una task reale: le righe meta non ne sono.
      if (!selTask) setNote('E → nessuna task selezionata');
      else openEdit();
    } else if (input === 'S') {
      setViewBackup(view);
      setNote('');
      setMode('sort');
    } else if (input === 'F') {
      setViewBackup(view);
      setNote('');
      setMode('filter');
    } else if (input === 'f') {
      // T28 — fork della sessione selezionata. Minuscola come `t`/`c` (T39):
      // azione immediata, nessun modale — la `F` maiuscola resta ai filtri.
      // Vive solo sul pane sessioni: il fork ha per oggetto una conversazione,
      // e senza focus lì non ce n'è una selezionata su cui agire.
      if (focus !== 'sessions') {
        setNote('f → fork: seleziona una sessione (←→ per il pane)');
      } else {
        const s = selSessionObj;
        if (!s) {
          setNote(selSessionId ? 'f → pin stale: niente da forkare' : 'f → nessuna sessione da forkare');
        } else {
          // L'id del ramo nasce qui, prima dello spawn: pinnandolo posso
          // scrivere subito binding e lineage. Il binding task si eredita
          // dall'origine (un ramo appartiene alla stessa task), il lineage
          // registra la provenienza che il transcript non porta.
          const newId = randomUUID();
          const bound = bindings.get(s.sessionId) ?? null;
          appendSessionRecord(cwd, {
            sessionId: newId,
            ...(bound ? { taskId: bound } : {}),
            forkOf: s.sessionId,
          });
          const child = spawnDeckFork(bound, cwd, s.sessionId, newId);
          child.on('error', () => setNote(`⚠ fork fallito (${DECK_RUN})`));
          setNote(
            `⑂ fork ${s.sessionId.slice(0, 8)} → ${newId.slice(0, 8)}${bound ? ` (${bound})` : ' (spot)'}`,
          );
        }
      }
    } else if (input === 'p') {
      // T50 — pin/unpin della conversazione selezionata. Minuscola = azione
      // immediata (convenzione T39), gemella di `f`: opera sulla riga
      // selezionata del pane sessioni, quindi vive solo lì. Vale anche su una
      // pinnata STALE (l'unico modo di spinnarla). Scrive il sidecar e ricarica
      // subito, senza attendere il tick del poll.
      if (focus !== 'sessions') {
        setNote('p → pin: seleziona una sessione (←→ per il pane)');
      } else if (!selSessionId) {
        setNote('p → nessuna sessione da pinnare');
      } else {
        const isPinned = pinned.has(selSessionId);
        appendPin(cwd, selSessionId, !isPinned);
        reloadSessions();
        setNote(`${isPinned ? 'unpin' : '📌 pin'} ${selSessionId.slice(0, 8)}`);
      }
    } else if (input === 'N') {
      // T53 — nota sulla conversazione selezionata. MAIUSCOLA perché apre un
      // modale: nel deck le minuscole sono azioni immediate (`f` fork, `p` pin,
      // `t` term, `c` claude) e le maiuscole aprono un box (`C` create, `E`
      // edit, `S` sort, `F` filtri). Vincolo di focus identico a `p`: vale anche
      // su una pinnata STALE, perché annotare «questa non c'è più, era X» è
      // proprio il caso in cui una nota serve.
      if (focus !== 'sessions') {
        setNote('N → nota: seleziona una sessione (←→ per il pane)');
      } else if (!selSessionId) {
        setNote('N → nessuna sessione da annotare');
      } else {
        openNote();
      }
    } else if (input === 'A') {
      // T57 — assegna la conversazione selezionata a una task. MAIUSCOLA perché
      // apre un modale (convenzione T39), e il modale è obbligatorio: il pane
      // task non può fare da picker, perché spostare la selezione lì cambia il
      // parent e la sessione da assegnare sparisce dalla lista sotto le mani.
      // Vincolo di focus identico a `p`/`N`, e vale anche su una pinnata STALE:
      // il binding è nostro, il transcript è di CC — riassegnare una
      // conversazione il cui transcript non c'è più resta legittimo.
      if (focus !== 'sessions') {
        setNote('A → assegna: seleziona una sessione (←→ per il pane)');
      } else if (!selSessionId) {
        setNote('A → nessuna sessione da assegnare');
      } else {
        openAssign();
      }
    } else if (input === 't') {
      const title = identity ? `🖥️ ${identity.name} [term]` : null;
      const child = spawnTerminal(cwd, title);
      child.on('error', () => setNote('⚠ t → ptyxis non lanciabile'));
      setNote(`t → terminale su ${projectName}`);
    } else if (input === 'c') {
      // Minuscola = azione immediata (convenzione T39), gemella di `t`: entrambe
      // aprono una surface del cappello senza passare da un modale. `C` (create
      // task) resta distinta — stessa lettera, ma la maiuscola è per i modali.
      const child = spawnClaudeEmpty(cwd);
      child.on('error', () => setNote(`⚠ c → spawn claude fallito (${DECK_RUN})`));
      setNote(`c → claude nuda su ${projectName} (nessuna task)`);
    } else if (input === 'w') {
      // Salvataggio ESPLICITO: comporre una vista non tocca il disco, così
      // sperimentare non sporca lo stato persistito.
      try {
        saveView(cwd, view);
        setNote(`w → vista salvata (${viewFilePath(cwd)})`);
      } catch {
        setNote('⚠ salvataggio vista fallito');
      }
    } else if (input && /^[1-9]$/.test(input)) {
      const entry = launch[Number(input) - 1];
      if (!entry) {
        setNote(`${input} → nessuna voce launch (${launch.length} configurate)`);
      } else {
        const child = runLaunch(entry, cwd);
        child.on('error', () => setNote(`⚠ ${entry.label}: '${entry.command}' non lanciabile`));
        setNote(`${input} → ${entry.label} su ${projectName}`);
      }
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  const parentLabel = isAll ? 'tutte' : isSpot ? 'spot' : selectedTaskId ?? '—';
  const canSpawn = focus === 'tasks' && selTask !== null;
  const canResume = focus === 'sessions' && selSessionObj !== null;
  // T50 — il pin agisce su qualunque riga selezionata (anche stale, per
  // spinnarla); basta il focus sul pane e una selezione.
  const canPin = focus === 'sessions' && selSessionId !== null;
  // Le due surface built-in del cappello stanno in testa alla riga launch, non
  // fra i tasti: hanno la stessa natura delle voci `launch` — fire-once, cwd =
  // project root, nessuno stato — e la differenza è solo che sono universali
  // (nessun progetto le dichiara) invece che custom. Emoji del menu compass:
  // 🤖 = nuova sessione claude. Per il terminale compass usa 🖥️, che nel frame
  // Ink NON passa — `sanitize` lo sostituisce (VTE lo disegna largo 1,
  // string-width dice 2: discordante, invariante ① di width.ts) e resterebbe un
  // `·` muto. 💻 è il gemello concorde; il `sanitize` qui rende il vincolo
  // automatico invece che da ricordare.
  const surfaceLegend = sanitize('t 💻 · c 🤖');
  // Larghezza dal medesimo hook che dà l'altezza: dopo un resize la legenda si
  // ricalcola con lo stesso re-render che ridimensiona i pane. Le celle delle
  // surface (più il ` · ` che le separa dalle voci) sono già spese sulla riga →
  // vanno riservate, o le voci launch la sfonderebbero di quel tanto.
  const legend = launchLegend(launch, columns, cellWidth(surfaceLegend) + 3);

  // Legenda della modalità normale. Elenca SOLO i tasti che fanno qualcosa qui e
  // ora: le voci contestuali compaiono quando il pane a fuoco le rende possibili
  // e altrimenti spariscono, invece di annunciarsi inerti con un `—`.
  // Fuori: navigazione (`↑↓` `←→`) e uscita (`q`), universali in qualunque TUI, e
  // l'indicatore `focus:` — il pane a fuoco si vede già dall'evidenziazione, e
  // ridirlo a parole costava colonne su una riga che tronca in silenzio.
  const keyLegend = sanitize(
    [
      ...(canSpawn ? ['⏎/^K/^P/^R spawn'] : canResume ? ['⏎ resume'] : []),
      ...(canResume ? ['f fork'] : []),
      ...(canPin ? ['p pin', 'N nota', 'A assegna'] : []),
      '^F cerca',
      'C nuova',
      'E edit',
      'S sort',
      'F filtri',
      'w salva',
    ].join(' · '),
  );

  // ── T57 · schermata di assegnazione ─────────────────────────────────────
  // Sostitutiva come ricerca e reader (D3): la lista task non entra in un box
  // sopra i due pane, e prendendo l'intero frame non costa nulla al loro budget.
  // Conseguenza obbligata della scelta: la sessione in assegnazione non è più
  // visibile, quindi va RIPETUTA nel titolo — senza, non si sa più su cosa si
  // sta agendo.
  if (mode === 'assign') {
    if (isCompact(assignCap)) {
      return (
        <Text wrap="truncate-end">
          <Text bold color="cyan">loom-deck</Text>
          <Text dimColor>
            {' '}· assegna · terminale {rows}×{columns}: troppo basso, allarga · esc annulla
          </Text>
        </Text>
      );
    }
    const at = assignRows.findIndex((t) => (t?.id ?? null) === assignSel);
    const win = windowRange(assignRows.length, at, assignCap);
    const s = assignSid ? sessions.find((x) => x.sessionId === assignSid) ?? null : null;
    // Etichetta della conversazione: la nota umana se c'è (è il nome con cui la
    // riconosci), altrimenti la stessa derivazione della ricerca. Su una pinnata
    // stale non resta nulla: il titolo si accontenta dell'hash.
    const label =
      (assignSid ? sessionNotes.get(assignSid) : '') ||
      (s ? conversationLabel(s, projectCore, assignSid ? bindings.get(assignSid) : undefined) : '');
    return (
      <AssignScreen
        sessionId={assignSid ?? ''}
        label={label}
        current={assignSid ? bindings.get(assignSid) ?? null : null}
        filter={assignFilter}
        rows={assignRows.slice(win.start, win.end)}
        selected={assignSel}
        matched={assignRows.length - 1}
        hidden={hiddenTasks}
        above={win.start}
        below={assignRows.length - win.end}
        childCount={childCount}
        columns={columns}
        note={note}
      />
    );
  }

  // ── T52 · schermate sostitutive ─────────────────────────────────────────
  // Ricerca e reader sono gli unici modali che NON stanno in flusso sopra i
  // pane: una lista di occorrenze non entra in un box da 4 righe. Prendono
  // l'intero frame, quindi escono di qui — il budget dei due pane sotto non
  // serve nemmeno calcolarlo, e la loro altezza la distribuiscono
  // `searchListCapacity` / `readerCapacity`.
  if (mode === 'search' || mode === 'reader') {
    const hit = mode === 'reader' && readerRow?.kind === 'hit' ? readerRow.hit : null;
    // Terminale sotto la cornice: riga singola invece del box, per lo stesso
    // motivo del `budget.compact` del deck — un frame più alto di `rows` fa
    // pulire lo schermo a Ink a ogni redraw, e il poll lo versa nello scrollback.
    if (isCompact(hit ? readerCap : searchCap)) {
      return (
        <Text wrap="truncate-end">
          <Text bold color="cyan">loom-deck</Text>
          <Text dimColor>
            {' '}· {hit ? 'reader' : 'ricerca'} · terminale {rows}×{columns}: troppo basso, allarga ·{' '}
            esc {hit ? 'torna' : 'chiude'}
          </Text>
        </Text>
      );
    }
    if (hit) {
      // Niente `windowRange`: quella centra la finestra su una SELEZIONE, qui
      // la posizione è lo scroll che l'utente muove a mano. Il clamp serve
      // comunque — un resize può accorciare il testo sotto uno scroll già dato.
      const start = Math.min(readerTop, readerMaxTop);
      return (
        <ReaderScreen
          hit={hit}
          lines={readerLines.slice(start, start + readerCap)}
          top={start}
          total={readerLines.length}
          capacity={readerCap}
          bound={bindings.get(hit.sessionId) ?? null}
        />
      );
    }
    const selIdx = rowIndexOfKey(searchRows, searchSelKey);
    const win = windowRange(searchRows.length, selIdx, searchCap);
    // Anteprima dell'occorrenza selezionata: prende le righe che la lista non
    // usa. Con molti risultati `spare` è 0 e il pannello non esiste — la lista
    // se le riprende tutte, che è la priorità giusta quando c'è molto da
    // scorrere. La finestra si CENTRA sul match (`windowRange`), così il
    // contesto arriva da entrambi i lati.
    const spare = searchPreviewCapacity(searchCap, win.end - win.start);
    let preview = null;
    if (spare >= 1 && searchSelRow?.kind === 'hit') {
      const h = searchSelRow.hit;
      const mline = Math.max(0, searchPreviewBody.findIndex((l) => l.end > h.matchStart));
      const pw = windowRange(searchPreviewBody.length, mline, spare);
      preview = {
        hit: h,
        lines: searchPreviewBody.slice(pw.start, pw.end),
        from: pw.start,
        total: searchPreviewBody.length,
        ts: sessions.find((s) => s.sessionId === h.sessionId)?.ts ?? 0,
      };
    }
    return (
      <SearchScreen
        preview={preview}
        hash={searchHash}
        query={searchQuery}
        field={searchField}
        opts={searchOpts}
        result={searchResult}
        rows={searchRows.slice(win.start, win.end)}
        selectedKey={searchSelKey}
        selectedKind={selectedRow(searchRows, searchSelKey)?.kind ?? null}
        above={win.start}
        below={searchRows.length - win.end}
        capacity={searchCap}
        bindings={bindings}
        pinned={pinned}
        sessionNotes={sessionNotes}
        projectCore={projectCore}
        columns={columns}
        note={note}
      />
    );
  }

  // ── Budget d'altezza ────────────────────────────────────────────────────
  // Il frame deve restare sotto `rows`, sempre: oltre quella soglia Ink smette
  // di aggiornare per differenza e pulisce lo schermo a ogni redraw, che su
  // Ptyxis significa un frame intero versato nello scrollback per ogni tick del
  // poll. Tutto ciò che varia in altezza (le due liste e la descrizione del
  // dettaglio) riceve qui la propria capienza.
  // Le surface built-in `t`/`c` la rendono sempre presente in modalità normale:
  // non dipende più da quante voci `launch` il progetto dichiara.
  const launchLine = mode === 'normal';
  const detailParts = detail ? detailMetaOf(detail) : null;
  // T70 — un solo blocco preview, sotto i due pane, e il FOCUS decide cosa
  // contiene: a sinistra la task selezionata, a destra la conversazione. È il
  // focus e non la selezione perché il blocco è uno — averne due significava
  // pagare due cornici per mostrare contemporaneamente il dettaglio di una cosa
  // che si sta guardando e di una che non si sta guardando.
  // `none` quando non c'è contenuto (riga meta selezionata, task file assente,
  // pin stale): il blocco sparisce del tutto, non resta una cornice vuota.
  const previewKind: PreviewKind =
    focus === 'tasks' ? (detail ? 'task' : 'none') : selSessionObj ? 'session' : 'none';
  const budget: Budget = layoutBudget({
    rows,
    mode,
    launchLine,
    noteLine: Boolean(note),
    preview: previewKind,
    detailMetaLines: detailParts?.metaLines ?? 0,
    // Riservo righe di anteprima solo per i blocchi che davvero renderizzano: il
    // primo prompt aggiunge info solo con un titolo custom (senza, titolo ===
    // primo prompt); l'ultima risposta solo se il modello ha già risposto.
    sessionHasFirstPreview: previewKind === 'session' && Boolean(selSessionObj?.customTitle),
    sessionHasLastPreview: previewKind === 'session' && Boolean(selSessionObj?.lastReply),
  });

  // Finestre di rendering. Le liste "logiche" (viewTasks, sessionRows)
  // restano intere: navigazione, selezione e spawn continuano a ragionare su
  // quelle, la finestra è solo ciò che finisce a schermo.
  const taskWin = windowRange(viewTasks.length, selIndex - META_ROWS, budget.taskRows);
  const windowTasks = viewTasks.slice(taskWin.start, taskWin.end);
  const selRowIndex = rowIndexOf(sessionRows, selSessionId);
  const sessionWin = windowRange(sessionRows.length, selRowIndex, budget.sessionRows);
  const windowRows = sessionRows.slice(sessionWin.start, sessionWin.end);

  // Sotto la soglia minima il layout a box non entra a nessun costo: si scende
  // a una riga sola. Perdere il deck per un terminale basso è meglio che
  // sporcare la cronologia del terminale a ogni poll.
  if (budget.compact) {
    return (
      <Text wrap="truncate-end">
        <Text bold color="cyan">loom-deck</Text>
        <Text dimColor>
          {' '}· {viewTasks.length} task · sel {selectedTaskId ?? parentLabel} · terminale {rows}×
          {columns}: troppo basso, allarga
        </Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      {mode === 'create' ? (
        <Text dimColor wrap="truncate-end">
          nuova task · <Text color="yellow">⏎</Text> crea · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'sort' ? (
        <Text dimColor wrap="truncate-end">
          sort · <Text color="yellow">p</Text> pri <Text color="yellow">s</Text> stato{' '}
          <Text color="yellow">i</Text> id (asc→desc→off) · <Text color="yellow">⏎</Text> ok ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'filter' ? (
        <Text dimColor wrap="truncate-end">
          filtri · <Text color="yellow">↑↓←→</Text> naviga · <Text color="yellow">spazio</Text>{' '}
          mostra/nascondi · <Text color="yellow">⏎</Text> ok · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'note' ? (
        <Text dimColor wrap="truncate-end">
          nota conversazione · <Text color="yellow">^U</Text> svuota ·{' '}
          <Text color="yellow">⏎</Text> salva (vuoto = rimuove) ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'edit' ? (
        <Text dimColor wrap="truncate-end">
          edit · <Text color="yellow">↑↓</Text> campo · <Text color="yellow">←→</Text> valore, o
          cursore sul testo · <Text color="yellow">^A/^E</Text> inizio/fine ·{' '}
          <Text color="yellow">^D</Text> canc · <Text color="yellow">⏎</Text> salva+commit ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {keyLegend}
        </Text>
      )}
      {/* T43 — riga delle surface: prima le due built-in (`t`/`c`), poi la mappa
          indice→launch del progetto. Presente in tutta la modalità normale, non
          più solo con voci configurate: `t` e `c` esistono ovunque, quindi la
          riga non è mai vuota. */}
      {mode === 'normal' ? (
        <Text dimColor wrap="truncate-end">
          {surfaceLegend}
          {legend.shown ? ` · ${legend.shown}` : ''}
          {legend.overflow > 0 ? (
            <Text color="yellow"> · +{legend.overflow} fuori riga</Text>
          ) : null}
          {legend.unreachable > 0 ? (
            <Text color="yellow"> · {legend.unreachable} oltre la 9ª (non raggiungibili)</Text>
          ) : null}
        </Text>
      ) : null}
      {mode === 'create' ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">C › </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {/* T53 — gemello del box create. Il cursore sta in coda al testo (append
          only, come create): un cursore mobile vorrebbe gestire frecce e Home/End,
          e `Home`/`End` non sono nemmeno esposte da `useInput`. */}
      {mode === 'note' ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">✎ › </Text>
          <Text>{noteDraft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {mode === 'sort' ? <SortModal sort={view.sort} /> : null}
      {mode === 'filter' ? <FilterModal view={view} cursor={filterCursor} /> : null}
      {mode === 'edit' && edit && selTask ? (
        <EditModal id={selTask.id} draft={edit} row={editRow} columns={columns} />
      ) : null}
      <Box flexDirection="row" marginTop={1}>
        <TasksPane
          tasks={windowTasks}
          filtered={viewTasks.length}
          total={tasks.length}
          hidden={hiddenTasks}
          archivable={archivable}
          view={view}
          selected={selIndex}
          spotCount={spotCount}
          allCount={sessions.length}
          childCount={childCount}
          focused={focus === 'tasks'}
          loadError={loadError}
          windowStart={taskWin.start}
          above={taskWin.start}
          below={viewTasks.length - taskWin.end}
          columns={columns}
        />
        <SessionsPane
          parentLabel={parentLabel}
          isSpot={isSpot}
          isAll={isAll}
          bindings={bindings}
          taskW={sessionCols.task}
          ageW={sessionCols.age}
          rows={windowRows}
          total={assembled.pinnedCount + assembled.contextTotal}
          pinnedCount={assembled.pinnedCount}
          hidden={assembled.contextHidden}
          selectedId={selSessionId ?? undefined}
          focused={focus === 'sessions'}
          above={sessionWin.start}
          below={sessionRows.length - sessionWin.end}
          columns={columns}
          forkOf={forkOf}
          sessionNotes={sessionNotes}
          projectCore={projectCore}
        />
      </Box>
      {/* T70 — blocco preview UNICO, a piena larghezza, sotto le due liste.
          Renderizzato solo con contenuto E spazio: `budget.preview` copre il
          secondo, `previewKind` il primo. */}
      {budget.preview && previewKind === 'task' && detail ? (
        <PreviewPane
          kind="task"
          detail={detail}
          maxLines={budget.detailLines}
          columns={columns}
        />
      ) : budget.preview && previewKind === 'session' && selSessionObj ? (
        <PreviewPane
          kind="session"
          s={selSessionObj}
          firstLines={budget.sessionFirstLines}
          lastLines={budget.sessionLastLines}
          columns={columns}
          origin={forkOf.get(selSessionObj.sessionId) ?? null}
          note={sessionNotes.get(selSessionObj.sessionId) ?? ''}
        />
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

const SORT_UI: Record<SortKey, string> = { pri: 'pri', prog: 'stato', id: 'id' };

// Modali resi IN FLUSSO (come l'input box di create), non in overlay assoluto:
// spingono giù i pane invece di coprirli, così la lista che stai filtrando
// resta sempre visibile mentre la componi.
function SortModal({ sort }: { sort: SortEntry[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">S › sort chain</Text>
      {sort.length === 0 ? (
        <Text dimColor>nessuna chiave · resta l'ordine per id ↑</Text>
      ) : (
        <Text>
          {sort
            .map((e, i) => `${i + 1}. ${SORT_UI[e.key]} ${e.dir === 'asc' ? '↑' : '↓'}`)
            .join('    ')}
        </Text>
      )}
    </Box>
  );
}

function FilterModal({ view, cursor }: { view: ViewState; cursor: FilterCursor }) {
  const rows = [
    { label: 'pri  ', entries: PRI_ENTRIES, hidden: new Set<string>(view.hiddenPri) },
    { label: 'stato', entries: PROG_ENTRIES, hidden: new Set<string>(view.hiddenProg) },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">F › filtri</Text>
      {rows.map((row, r) => (
        <Text key={row.label}>
          <Text dimColor>{row.label}</Text>
          {row.entries.map((e, c) => {
            const on = !row.hidden.has(e.name);
            const here = cursor.row === r && cursor.col === c;
            return (
              <Text key={e.name} inverse={here} color={on ? 'green' : 'gray'} dimColor={!on}>
                {'  '}
                [{on ? 'x' : ' '}] {sanitize(e.glyph)}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Campo di testo del modale edit: finestra ancorata al caret + cursore inverso
 * nella posizione REALE.
 *
 * Il cursore non è più uno spazio inverso appiccicato in coda ma la cella `at`
 * della finestra — cioè il carattere su cui il caret sta davvero. Fuori fuoco
 * (`focused` falso) il caret non si disegna e la finestra si ancora in fondo,
 * che è la vista utile per un campo che non si sta scrivendo.
 */
function EditTextField({
  label,
  value,
  caret,
  focused,
  cols,
}: {
  label: string;
  value: string;
  caret: number;
  focused: boolean;
  cols: number;
}) {
  const win = caretWindow(value, focused ? caret : cpLen(value), cols);
  return (
    <>
      <Text dimColor>{label}</Text>
      <Text>
        {'  '}
        {sanitize(win.head)}
      </Text>
      {/* Fuori fuoco `at` è solo la cella virtuale di fine campo: disegnarla
          aggiungerebbe al testo uno spazio che non gli appartiene. */}
      {focused ? <Text inverse>{sanitize(win.at)}</Text> : null}
      <Text>{sanitize(win.tail)}</Text>
    </>
  );
}

// T41 — modale edit, in flusso come gli altri (spinge giù i pane invece di
// coprirli: la riga che stai modificando resta visibile sopra la lista).
// La riga di anteprima mostra il testo ESATTO che finirà nel campo `Progress`
// del task file — così il default (`✔️ Done at <oggi>`) non è una sorpresa.
function EditModal({
  id,
  draft,
  row,
  columns,
}: {
  id: string;
  draft: EditDraft;
  row: EditRow;
  columns: number;
}) {
  const mark = (r: EditRow) => (row === r ? CARET : CARET_OFF);
  // Budget dei campi di testo, DERIVATO da `columns` (mai una costante): il box
  // del modale è ANNIDATO nella cornice del deck, quindi le cornici da scalare
  // sono due — root (bordo 2 + paddingX 2) e modale (bordo 2 + paddingX 2) — più
  // caret 2, etichetta 6, gap 2 e cursore 1. Totale 19.
  // Un titolo di tasks.md arriva a ~64 caratteri: senza taglio la riga va a capo
  // dentro il box, che si alza di una riga e sfonda il budget verticale (invariante ③).
  const fieldBudget = Math.max(8, columns - 19);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">E › {id} · titolo, priorità e stato</Text>
      <Text>
        {mark(0)}
        <Text dimColor>pri   </Text>
        {EDIT_PRI.map((p) => (
          <Text key={p} inverse={draft.pri === p} color={draft.pri === p ? 'green' : 'gray'}>
            {'  '}
            {sanitize(PRI_GLYPH[p])} {PRI_LABEL[p]}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(1)}
        <Text dimColor>stato </Text>
        {EDIT_PROG.map((p) => (
          <Text key={p} inverse={draft.prog === p} color={draft.prog === p ? 'green' : 'gray'}>
            {'  '}
            {sanitize(PROG_GLYPH[p])} {p}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(2)}
        <EditTextField
          label="prog  "
          value={draft.detail}
          caret={draft.caret}
          focused={row === 2}
          cols={fieldBudget}
        />
        {!draft.detail && row !== 2 ? <Text dimColor>(default)</Text> : null}
      </Text>
      {/* Il titolo è UNO ma vive in due posti: la colonna Task di tasks.md e
          l'H1 del task file. Il modale ne mostra uno solo perché sono la stessa
          informazione — tenerli separati sarebbe l'invito a farli divergere. */}
      <Text>
        {mark(3)}
        <EditTextField
          label="titolo"
          value={draft.title}
          caret={draft.caret}
          focused={row === 3}
          cols={fieldBudget}
        />
      </Text>
      {/* sanitize SOLO qui, non dentro progressText: quel testo finisce
          nel campo `Progress` del task file, dove il glifo va scritto nudo. */}
      <Text dimColor wrap="truncate-end">
        ↳ {sanitize(progressText(draft.prog, draft.detail))}
      </Text>
    </Box>
  );
}

// T52 — marcatore compatto del tipo di corpo sulla riga-occorrenza. Due
// caratteri ASCII e non un'emoji: con più toggle accesi la colonna deve
// allinearsi, e i glifi BMP larghi 2 sono proprio la classe che Ink e il
// terminale misurano diversamente (vedi width.ts).
const KIND_TAG: Record<BodyKind, string> = { ai: 'ai', tool: 'tl', human: 'hu' };
const KIND_COLOR: Record<BodyKind, string> = { ai: 'cyan', tool: 'gray', human: 'green' };

/**
 * Larghezza dell'estratto, DERIVATA dalle colonne del terminale.
 *
 * Una costante qui è spazio buttato a ogni riga: su un terminale a 190 colonne
 * un estratto fisso a 50 lascia il match con ~20 caratteri di contesto per lato
 * quando potrebbe averne 80 — e il contesto attorno al match è l'unica ragione
 * per cui si legge la riga invece di aprire il reader.
 *
 * Scomposizione delle colonne consumate dalla cornice e dal prefisso di riga:
 *   4  box esterno (2 bordi + 2 padding)
 *   4  box lista   (2 bordi + 2 padding)
 *   2  caret
 *   4  indice del record
 *   4  spazio + tag del kind (2 caratteri) + spazio
 * Prudente per costruzione: sottostimare tronca un carattere in più,
 * sovrastimare manderebbe la riga a capo e sfonderebbe il budget d'altezza.
 */
function searchExcerptWidth(columns: number): number {
  return Math.max(30, (columns || 80) - 18);
}

/** Titolo della conversazione sulla riga-gruppo: prende ciò che avanza dopo le
 *  colonne a larghezza fissa (caret, pin, hash, task, conteggio, data). */
function searchTitleWidth(columns: number): number {
  return Math.max(24, (columns || 80) - 56);
}

/**
 * Cosa scrivere sulla riga-gruppo per distinguere una conversazione dall'altra.
 *
 * Non basta `session.title`: quel titolo è la label della tab Ptyxis, cioè
 * `<emoji> <name>` più un eventuale suffisso. Su una lista tutta dello
 * stesso progetto (D3) è una COLONNA COSTANTE — tre righe su quattro
 * identiche, che è esattamente il difetto che la riga-gruppo doveva evitare.
 *
 * Si toglie quindi il core `<name>` con tutto ciò che lo precede (noto dal file
 * config), e se ciò
 * che resta è vuoto o duplica la task già mostrata nella sua colonna, si
 * ripiega sul primo prompt — l'unica cosa che davvero identifica quella
 * conversazione e non un'altra.
 */
function conversationLabel(s: Session, core: string | null, bound: string | undefined): string {
  let t = stripProjectCore(s.title, core);
  if (bound && t === bound) t = '';
  return t || s.firstPrompt || '(senza titolo)';
}

/**
 * Riga di toggle del modale ricerca.
 *
 * La mappa tasto→significato è SEMPRE a schermo: `^R` da solo è opaco quanto lo
 * era il range `1-9` delle launch prima di T43.
 *
 * Lo stato acceso/spento passa da `[x]`/`[ ]`, non dal solo colore — stessa
 * convenzione del modale filtri. Il colore è ridondanza, non l'informazione: su
 * un terminale monocromo, o in una cattura di testo, sei toggle tutti uguali
 * non direbbero più quali sono attivi.
 */
function ToggleHint({ opts }: { opts: SearchOptions }) {
  const flag = (on: boolean, key: string, label: string) => (
    <Text key={key} color={on ? 'green' : 'gray'} dimColor={!on} bold={on}>
      {'  '}
      {key}[{on ? 'x' : ' '}] {label}
    </Text>
  );
  return (
    <Text wrap="truncate-end">
      {flag(opts.regex, '^R', 'regex')}
      {flag(opts.caseSensitive, '^A', 'Aa')}
      {flag(opts.wholeWord, '^W', 'word')}
      <Text dimColor>{'  │'}</Text>
      {flag(opts.kinds.ai, '^B', 'IA')}
      {flag(opts.kinds.tool, '^T', 'tools')}
      {flag(opts.kinds.human, '^U', 'human')}
    </Text>
  );
}

/** Intestazione della lista: dice sempre quanto NON si sta vedendo (regex rotta,
 *  query troppo corta, occorrenze tagliate dal cap, righe fuori finestra). */
function SearchListHeader({
  result,
  query,
  above,
  below,
}: {
  result: SearchResult;
  query: string;
  above: number;
  below: number;
}) {
  if (result.error) {
    return (
      <Text color="red" wrap="truncate-end">
        {WARN} regex non valida · {result.error}
      </Text>
    );
  }
  if (result.idle) {
    return (
      <Text dimColor wrap="truncate-end">
        {query.length === 0
          ? 'digita la chiave da cercare'
          : `almeno ${MIN_QUERY} caratteri (${query.length})`}
      </Text>
    );
  }
  if (result.shown === 0) {
    return (
      <Text color="yellow" wrap="truncate-end">
        nessuna occorrenza
      </Text>
    );
  }
  return (
    <Text bold wrap="truncate-end">
      {result.shown} occorrenze in {result.sessionCount} conversazioni
      {result.hidden > 0 ? <Text color="yellow"> · +{result.hidden} oltre il cap</Text> : null}
      {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
      {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
    </Text>
  );
}

/**
 * Schermata di ricerca full-text (T52).
 *
 * Due campi + toggle + lista di occorrenze. Con l'hash vuoto la lista è
 * raggruppata per conversazione: la riga-gruppo NON ripete il nome del progetto
 * (D3: sono tutte dello stesso progetto, sarebbe una colonna costante) e usa lo
 * spazio per ciò che distingue davvero una conversazione — hash, task legata,
 * titolo, data.
 */
/** Anteprima dell'occorrenza selezionata, già finestrata dal chiamante. */
interface SearchPreview {
  hit: Hit;
  lines: WrappedLine[];
  /** Indice della prima riga mostrata, nel corpo intero. */
  from: number;
  total: number;
  /** Ultima attività della conversazione (ms epoch); 0 = non risolta. */
  ts: number;
}

function SearchScreen({
  preview,
  hash,
  query,
  field,
  opts,
  result,
  rows,
  selectedKey,
  selectedKind,
  above,
  below,
  capacity,
  bindings,
  pinned,
  sessionNotes,
  projectCore,
  columns,
  note,
}: {
  /** null = nessuna occorrenza selezionata, o nessuna riga avanzata. */
  preview: SearchPreview | null;
  hash: string;
  query: string;
  field: SearchField;
  opts: SearchOptions;
  result: SearchResult;
  /** Solo la finestra visibile della lista. */
  rows: SearchRow[];
  selectedKey: string | null;
  /** Tipo della riga selezionata: decide cosa promette `⏎` nell'hint. */
  selectedKind: SearchRow['kind'] | null;
  above: number;
  below: number;
  capacity: number;
  bindings: Map<string, string>;
  pinned: Map<string, number>;
  /** T53 — sessionId → nota umana (solo le sessioni annotate). */
  sessionNotes: Map<string, string>;
  /** `name` del progetto: prefisso da togliere ai titoli di tab. */
  projectCore: string | null;
  columns: number;
  note: string;
}) {
  const enter =
    selectedKind === 'session' ? 'resume' : selectedKind === 'hit' ? 'leggi' : '—';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        ricerca · <Text color="yellow">tab</Text> campo · <Text color="yellow">↑↓</Text> naviga ·{' '}
        <Text color="yellow">⏎</Text> {enter} · <Text color="yellow">esc</Text> chiudi
      </Text>
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>hash   </Text>
          <Text color={field === 'hash' ? 'yellow' : undefined}>{hash}</Text>
          {field === 'hash' ? <Text inverse> </Text> : null}
          {!hash ? <Text dimColor>  (vuoto = tutte le conversazioni)</Text> : null}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>chiave </Text>
          <Text color={field === 'query' ? 'yellow' : undefined}>{query}</Text>
          {field === 'query' ? <Text inverse> </Text> : null}
        </Text>
        <ToggleHint opts={opts} />
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <SearchListHeader result={result} query={query} above={above} below={below} />
        {rows.slice(0, Math.max(0, capacity)).map((row) => {
          const sel = row.key === selectedKey;
          if (row.kind === 'session') {
            const s = row.session;
            const bound = bindings.get(s.sessionId);
            const rowNote = sessionNotes.get(s.sessionId);
            const noteShown = rowNote ? cut(rowNote, 24) : '';
            // `+3` = i due caporali e lo spazio che li separa dall'etichetta.
            // Il pavimento non è cosmetico: senza, un terminale stretto manda
            // l'argomento di `cut` sotto zero, cioè un budget negativo.
            // La nota si misura con `termWidth`, non con `.length`: contiene
            // testo umano, emoji compresi.
            const restWidth = Math.max(
              8,
              searchTitleWidth(columns) - (noteShown ? termWidth(noteShown) + 3 : 0),
            );
            return (
              <Text key={row.key} inverse={sel} wrap="truncate-end">
                {sel ? CARET : CARET_OFF}
                {pinned.has(s.sessionId) ? <Text color="yellow">📌</Text> : <Text dimColor>○</Text>}{' '}
                <Text color="cyan">{s.sessionId.slice(0, 8)}</Text>
                <Text dimColor> · </Text>
                {bound ?? <Text dimColor>spot</Text>}
                <Text dimColor> · </Text>
                {/* T53 — la nota precede l'etichetta derivata: se l'hai scritta
                    è perché è il nome con cui riconosci quella conversazione, e
                    non ritrovarla qui col nome che ha in lista sarebbe il
                    difetto peggiore proprio dentro la ricerca. */}
                {noteShown ? <Text color="yellow" bold>«{noteShown}» </Text> : null}
                <Text dimColor={Boolean(noteShown)}>
                  {cut(conversationLabel(s, projectCore, bound), restWidth)}
                </Text>
                <Text dimColor>
                  {'  '}({row.hitCount}
                  {row.hidden > 0 ? `+${row.hidden}` : ''}) {fmtDateTime(s.ts)}
                </Text>
              </Text>
            );
          }
          const h = row.hit;
          return (
            <Text key={row.key} inverse={sel} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              <Text dimColor>{String(h.idx).padStart(4)}</Text>{' '}
              <Text color={KIND_COLOR[h.kind]}>{KIND_TAG[h.kind]}</Text>{' '}
              {/* Invariante ③: `excerptAround` ritaglia il contesto per indice
                  di carattere (deve, per non spostare gli offset del match), e
                  un estratto pieno di emoji vale più colonne di quante ne ha
                  chieste. Il taglio a colonne si fa qui, all'ultimo momento. */}
              {cut(h.excerpt, searchExcerptWidth(columns))}
            </Text>
          );
        })}
      </Box>
      {preview ? <SearchPreviewPane p={preview} /> : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

/**
 * Anteprima dell'occorrenza selezionata, sotto la lista.
 *
 * Riempie le righe che la lista non usa: con pochi risultati il terminale
 * resterebbe vuoto per tre quarti, e il contesto attorno al match è proprio
 * ciò che serve per decidere se è l'occorrenza giusta. Nel caso comune evita
 * del tutto di aprire il reader.
 *
 * Si aggiorna navigando con le frecce, e la finestra è centrata sul match:
 * stessa `windowRange` della lista, stessa evidenziazione del reader
 * (`ReaderLine`) — nessuna primitiva nuova.
 */
function SearchPreviewPane({ p }: { p: SearchPreview }) {
  const last = Math.min(p.total, p.from + p.lines.length);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text dimColor wrap="truncate-end">
        record {p.hit.idx} · {KIND_LABEL[p.hit.kind]}
        {p.ts ? ` · ${fmtDateTime(p.ts)}` : ''} · righe {p.from + 1}-{last} di {p.total} ·{' '}
        <Text color="yellow">⏎</Text> apre il reader
      </Text>
      {p.lines.map((l, i) => (
        <ReaderLine key={p.from + i} line={l} from={p.hit.matchStart} to={p.hit.matchEnd} />
      ))}
    </Box>
  );
}

/**
 * Reader fullscreen (T52 · D8).
 *
 * Mostra il messaggio INTERO che contiene l'occorrenza, aperto già posizionato
 * sul match e con il match evidenziato. È un `mode` a sé, catturato prima del
 * ramo `search`: il modale ricerca resta montato sotto e su `esc` si ritrova
 * con query, toggle e selezione intatti.
 */
function ReaderScreen({
  hit,
  lines,
  top,
  total,
  capacity,
  bound,
}: {
  hit: Hit;
  /** Solo la finestra visibile del testo wrappato. */
  lines: WrappedLine[];
  top: number;
  total: number;
  capacity: number;
  bound: string | null;
}) {
  const last = Math.min(total, top + capacity);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        reader · <Text color="cyan">{hit.sessionId.slice(0, 8)}</Text> · record {hit.idx} ·{' '}
        {KIND_LABEL[hit.kind]}
        {bound ? ` · ${bound}` : ''} · righe {total === 0 ? 0 : top + 1}-{last} di {total}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">PgUp/PgDn</Text> pagina ·{' '}
        <Text color="yellow">g</Text> inizio · <Text color="yellow">G</Text> fine ·{' '}
        <Text color="yellow">esc</Text> torna alla lista
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {lines.map((l, i) => (
          <ReaderLine key={top + i} line={l} from={hit.matchStart} to={hit.matchEnd} />
        ))}
      </Box>
    </Box>
  );
}

/** Una riga del reader, con la sola porzione di match evidenziata. Gli offset
 *  sono quelli del testo sorgente, quindi un match a cavallo dell'a-capo si
 *  colora su entrambe le righe senza casi speciali. */
function ReaderLine({ line, from, to }: { line: WrappedLine; from: number; to: number }) {
  const a = Math.max(0, Math.min(line.text.length, from - line.start));
  const b = Math.max(0, Math.min(line.text.length, to - line.start));
  if (b <= a) {
    return <Text wrap="truncate-end">{line.text || ' '}</Text>;
  }
  return (
    <Text wrap="truncate-end">
      {line.text.slice(0, a)}
      <Text backgroundColor="yellow" color="black">
        {line.text.slice(a, b)}
      </Text>
      {line.text.slice(b)}
    </Text>
  );
}

/**
 * Larghezza del testo dentro la lista della schermata di assegnazione: box
 * esterno (2 bordi + 2 padding) + box lista (2 bordi + 2 padding).
 *
 * Invariante ③ (`width.ts`): il taglio lo fa il chiamante. Delegarlo a
 * `wrap="truncate-end"` passerebbe da `cli-truncate`, che restituisce una riga
 * più larga di quella chiesta di una colonna per emoji — e quelle colonne
 * finiscono sopra il bordo, che sparisce dalla riga.
 */
function assignTextWidth(columns: number): number {
  return Math.max(20, (columns || 80) - 8);
}

/**
 * Schermata di assegnazione di una conversazione a una task (T57).
 *
 * Fullscreen sostitutiva (D3) come la ricerca: la lista task non entra in un
 * box sopra i due pane. Da lì discende che l'oggetto dell'azione — la sessione
 * selezionata, che non è più a schermo — va ripetuto nel titolo.
 *
 * L'header della lista conta le task escluse dai filtri della vista (D4): la
 * scelta di mostrare `viewTasks` e non tutte le task ha come prezzo noto che un
 * filtro può nascondere proprio il bersaglio, e quel prezzo non deve essere
 * silenzioso — stessa convenzione del `+N più vecchie` del pane sessioni.
 */
function AssignScreen({
  sessionId,
  label,
  current,
  filter,
  rows,
  selected,
  matched,
  hidden,
  above,
  below,
  childCount,
  columns,
  note,
}: {
  sessionId: string;
  /** Nota umana o etichetta derivata; '' = solo l'hash (pinnata stale). */
  label: string;
  /** Task a cui la sessione è legata ORA; null = spot. */
  current: string | null;
  filter: string;
  /** Solo la finestra visibile: `null` = riga detach. */
  rows: Array<Task | null>;
  /** Task selezionata; `null` = riga detach. */
  selected: string | null;
  /** Task che passano il filtro (detach escluso). */
  matched: number;
  /** Task fuori dai filtri della VISTA (non del campo di questo modale). */
  hidden: number;
  above: number;
  below: number;
  childCount: Map<string, number>;
  columns: number;
  note: string;
}) {
  const width = assignTextWidth(columns);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      {/* `↑↓` non è in legenda: la navigazione è universale in qualunque TUI e
          qui le colonne servono a dire su COSA si sta agendo — l'unica cosa che
          la schermata sostitutiva ha tolto da sotto gli occhi. */}
      <Text dimColor wrap="truncate-end">
        assegna <Text color="cyan">{sessionId.slice(0, 8)}</Text>
        {label ? ` «${cut(sanitize(label), Math.max(10, Math.floor(width / 4)))}»` : ''} · ora{' '}
        {current ? <Text color="green">{current}</Text> : 'spot'} · <Text color="yellow">⏎</Text>{' '}
        assegna · <Text color="yellow">^U</Text> pulisci · <Text color="yellow">esc</Text> annulla
      </Text>
      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>filtro </Text>
          <Text color="yellow">{cut(filter, Math.max(8, width - 24))}</Text>
          <Text inverse> </Text>
          {!filter ? <Text dimColor>  (id o titolo)</Text> : null}
        </Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {matched} task
          {hidden > 0 ? <Text color="yellow"> · +{hidden} fuori dai filtri</Text> : null}
          {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
          {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
        </Text>
        {rows.map((task) => {
          // T57/D2 — `detach` è una VOCE della lista, non un tasto a parte: un
          // solo gesto (`A`), un solo modale. Speculare alla riga meta `spot`
          // del pane task, e nominata con l'AZIONE («detach») invece che con lo
          // stato d'arrivo — è ciò che si sta per fare.
          if (!task) {
            const sel = selected === null;
            // Le colonne fisse (caret + `○ detach` + i due spazi) sono 12: solo
            // la glossa si taglia, così su un terminale stretto resta comunque
            // il nome dell'azione invece di un moncone di frase.
            return (
              <Text key="detach" inverse={sel} wrap="truncate-end">
                {sel ? CARET : CARET_OFF}
                ○ detach  {cut('la sessione torna spot', width - 12)}
              </Text>
            );
          }
          const sel = selected === task.id;
          const n = childCount.get(task.id) ?? 0;
          const head = `${CARET_OFF}${task.id}  ${sanitize(task.pri)}  ${displayProg(task.prog)}  `;
          const tail = n > 0 ? ` (${n})` : '';
          const desc = cut(task.desc, Math.max(4, width - termWidth(head) - termWidth(tail)));
          return (
            <Text key={task.id} inverse={sel} dimColor={!sel && isDone(task.prog)} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              {task.id}  {sanitize(task.pri)}  {displayProg(task.prog)}  {desc}
              {tail}
            </Text>
          );
        })}
      </Box>
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

/**
 * Header del pane task, tagliato QUI e non da Ink — stesso motivo del gemello
 * `SessionsHeader`, con una differenza di rischio: qui i segmenti sono tutti
 * ASCII più le frecce `↑↓` (larghe 1), quindi `cli-truncate` oggi darebbe la
 * riga giusta per caso. Il taglio resta del deck perché la correttezza non deve
 * dipendere dall'alfabeto che capita nella riga: il primo glifo largo 2 che
 * entrasse in un segmento nuovo riaprirebbe il difetto in silenzio, e a
 * scoprirlo sarebbe il bordo del pane a schermo.
 *
 * `truncate-end` taglia dalla coda, e `cutParts` conserva l'ordine: l'ultimo
 * segmento resta il primo a cedere il posto (vedi T61 sotto, `archiviabili` in
 * coda ai contatori della vista corrente).
 */
function TasksHeader({
  filtered,
  total,
  hidden,
  above,
  below,
  archivable,
  focused,
  columns,
}: {
  filtered: number;
  total: number;
  hidden: number;
  above: number;
  below: number;
  archivable: number;
  focused: boolean;
  columns: number;
}) {
  const segments: Array<{ text: string; color?: string; dim?: boolean }> = [
    { text: `Tasks (${hidden > 0 ? `${filtered}/${total}` : filtered})` },
    ...(hidden > 0 ? [{ text: ` · ${hidden} nascoste`, color: 'yellow' }] : []),
    ...(above > 0 ? [{ text: ` · ↑${above}`, dim: true }] : []),
    ...(below > 0 ? [{ text: ` · ↓${below}`, dim: true }] : []),
    ...(archivable > 0 ? [{ text: ` · ${archivable} archiviabili`, dim: true }] : []),
  ];
  const shown = cutParts(
    segments.map((s) => s.text),
    paneTextWidth(columns),
  );
  return (
    <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
      {segments.map((seg, i) =>
        shown[i] ? (
          <Text key={i} color={seg.color} dimColor={seg.dim}>
            {shown[i]}
          </Text>
        ) : null,
      )}
    </Text>
  );
}

function TasksPane({
  tasks,
  filtered,
  total,
  hidden,
  view,
  selected,
  spotCount,
  allCount,
  childCount,
  focused,
  loadError,
  windowStart,
  above,
  below,
  columns,
  archivable,
}: {
  /** Solo la finestra visibile, non la lista completa. */
  tasks: Task[];
  /** Task superstiti ai filtri — NON `tasks.length`, che è la sola finestra. */
  filtered: number;
  total: number;
  hidden: number;
  /** T61 — Done oltre soglia d'età; 0 = segmento omesso. */
  archivable: number;
  view: ViewState;
  /** Indice nella lista COMPLETA (0 = riga "tutte", 1 = riga spot). */
  selected: number;
  spotCount: number;
  /** T59 — conversazioni totali del progetto (badge della riga "tutte"). */
  allCount: number;
  childCount: Map<string, number>;
  focused: boolean;
  loadError: string;
  /** Offset della finestra nella lista completa. */
  windowStart: number;
  /** Task fuori finestra sopra / sotto. */
  above: number;
  below: number;
  columns: number;
}) {
  const allSelected = selected === ROW_ALL;
  const spotSelected = selected === ROW_SPOT;
  return (
    <Box
      flexDirection="column"
      width="50%"
      marginRight={1}
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {/* Truncation MAI silenziosa: con un filtro attivo il conteggio delle
          nascoste è sempre a schermo, come `+N più vecchie` per le sessioni.
          Il deck non finge mai una lista completa.

          Le task fuori finestra sono un secondo tipo di invisibile, distinto
          dalle filtrate: non sono escluse dalla vista, solo oltre il bordo del
          terminale. Il contatore ↑↓ sta nell'header perché una riga dedicata
          costerebbe proprio la riga di lista che sta segnalando come mancante.

          T61 — `archiviabili` va IN CODA e in dimColor, non accanto a
          `nascoste`. Il colore: `yellow` su `nascoste` avverte che la vista è
          distorta da un filtro, mentre le Done oltre soglia non alterano ciò
          che stai guardando — sono informative, non urgenti. La posizione:
          `truncate-end` taglia dalla fine, quindi l'ultimo segmento è il primo
          a sparire su un terminale stretto, ed è giusto che a cedere il posto
          sia questo e non i contatori della vista corrente. */}
      <TasksHeader
        filtered={filtered}
        total={total}
        hidden={hidden}
        above={above}
        below={below}
        archivable={archivable}
        focused={focused}
        columns={columns}
      />
      {/* La riga sort/filtri è tutta dim: un pezzo solo, quindi `cut` basta e
          `cutParts` sarebbe cerimonia. Ma il taglio va fatto lo stesso QUI — i
          filtri elencano i glifi di priorità e stato (`−🔥 −⚡`), larghi 2, cioè
          la stessa condizione che sull'header delle sessioni faceva sparire il
          bordo. Si sanifica PRIMA di misurare (invariante ①: `✔` largo 1 diventa
          `✅` largo 2, e chi taglia deve contare le colonne disegnate). */}
      <Text dimColor wrap="truncate-end">
        {cut(
          sanitize(
            `sort: ${describeSort(view.sort)}` +
              (view.hiddenPri.length + view.hiddenProg.length > 0
                ? ' · filtri: ' +
                  [
                    ...PRI_ENTRIES.filter((e) => view.hiddenPri.includes(e.name)),
                    ...PROG_ENTRIES.filter((e) => view.hiddenProg.includes(e.name)),
                  ]
                    .map((e) => `−${e.glyph}`)
                    .join(' ')
                : ''),
          ),
          paneTextWidth(columns),
        )}
      </Text>
      {/* T59 — riga meta "tutte" come PRIMA voce: ogni conversazione del
          progetto, scoped e spot insieme. È l'unica vista da cui una sessione
          legata a una task è raggiungibile senza sapere a quale. */}
      <Text inverse={allSelected && focused} bold={allSelected && !focused} wrap="truncate-end">
        {allSelected ? CARET : CARET_OFF}
        ≡ tutte le sessioni{allCount > 0 ? ` (${allCount})` : ''}
      </Text>
      {/* riga meta "spot": sessioni non legate ad alcuna task */}
      <Text inverse={spotSelected && focused} bold={spotSelected && !focused} wrap="truncate-end">
        {spotSelected ? CARET : CARET_OFF}
        ○ spot  sessioni libere{spotCount > 0 ? ` (${spotCount})` : ''}
      </Text>
      {loadError ? (
        <Text color="red" wrap="truncate-end">{loadError}</Text>
      ) : (
        tasks.map((task, i) => {
          // windowStart riporta l'indice di finestra a quello della lista
          // completa, su cui è keyata la selezione. +META_ROWS: le prime due
          // righe sono le meta.
          const sel = windowStart + i + META_ROWS === selected;
          const n = childCount.get(task.id) ?? 0;
          // Invariante ③: la descrizione è l'unico pezzo a lunghezza libera, e
          // si taglia QUI sul budget che resta dopo le colonne fisse. Lasciarlo
          // fare a `truncate-end` significa passare da `cli-truncate`, che
          // restituisce una riga più larga del pane (una colonna per emoji) e
          // quindi scrive sopra il bordo. Le parti fisse si misurano con
          // `termWidth`: `task.id` è `T9` o `T52`, i due glifi valgono 2 ciascuno.
          const head = `${CARET_OFF}${task.id}  ${sanitize(task.pri)}  ${displayProg(task.prog)}  `;
          const tail = n > 0 ? ` (${n})` : '';
          const desc = cut(
            task.desc,
            Math.max(4, paneTextWidth(columns) - termWidth(head) - termWidth(tail)),
          );
          return (
            <Text
              key={task.id}
              inverse={sel && focused}
              bold={sel && !focused}
              dimColor={!sel && isDone(task.prog)}
              wrap="truncate-end"
            >
              {sel ? CARET : CARET_OFF}
              {task.id}  {sanitize(task.pri)}  {displayProg(task.prog)}  {desc}
              {tail}
            </Text>
          );
        })
      )}
    </Box>
  );
}

/**
 * Header del pane sessioni, tagliato QUI e non da Ink.
 *
 * `📌{pinnedCount}` è un glifo largo 2 in mezzo alla riga: con
 * `wrap="truncate-end"` il taglio passava da `cli-truncate`, che indicizza per
 * code point con un budget in colonne e restituiva una riga larga 45 su un
 * budget di 44 — la colonna in più finiva sopra il bordo destro del pane, che
 * spariva dalla riga (invariante ③ di `width.ts`).
 *
 * I segmenti restano segmenti fino al render: il taglio è della RIGA (budget
 * condiviso, `cutParts`), la resa è del pezzo. Il giallo su `📌N` distingue le
 * pinnate dal resto dell'header e non è decorazione.
 */
function SessionsHeader({
  parentLabel,
  total,
  pinnedCount,
  hidden,
  above,
  below,
  focused,
  columns,
}: {
  parentLabel: string;
  total: number;
  pinnedCount: number;
  hidden: number;
  above: number;
  below: number;
  focused: boolean;
  columns: number;
}) {
  const segments: Array<{ text: string; color?: string; dim?: boolean }> = [
    { text: `Sessions · ${parentLabel} (${total})` },
    ...(pinnedCount > 0 ? [{ text: ` · 📌${pinnedCount}`, color: 'yellow' }] : []),
    ...(hidden > 0 ? [{ text: ` · +${hidden} più vecchie`, dim: true }] : []),
    ...(above > 0 ? [{ text: ` · ↑${above}`, dim: true }] : []),
    ...(below > 0 ? [{ text: ` · ↓${below}`, dim: true }] : []),
  ];
  const shown = cutParts(
    segments.map((s) => s.text),
    paneTextWidth(columns),
  );
  return (
    <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
      {segments.map((seg, i) =>
        shown[i] ? (
          <Text key={i} color={seg.color} dimColor={seg.dim}>
            {shown[i]}
          </Text>
        ) : null,
      )}
    </Text>
  );
}

function SessionsPane({
  parentLabel,
  isSpot,
  isAll,
  bindings,
  taskW,
  ageW,
  rows,
  total,
  pinnedCount,
  hidden,
  selectedId,
  focused,
  above,
  below,
  columns,
  forkOf,
  sessionNotes,
  projectCore,
}: {
  parentLabel: string;
  isSpot: boolean;
  /** T59 — vista "tutte": la lista mescola scoped e spot, quindi il marker di
   *  riga non può più venire dal parent (vedi il render sotto). */
  isAll: boolean;
  /** T59 — sessionId → taskId, letto dal sidecar. Serve SOLO alla vista "tutte",
   *  l'unica dove l'appartenenza non è desumibile dal parent selezionato. */
  bindings: Map<string, string>;
  /** T60 — larghezza della colonna task; 0 = colonna assente. Fuori dalla vista
   *  "tutte" la cella si riempie solo sulle righe pinnate: le contestuali
   *  condividono il binding dell'header, e ripeterlo N volte direbbe ciò che
   *  l'header dice una. */
  taskW: number;
  /** T60 — larghezza della colonna data, ancorata al margine destro. */
  ageW: number;
  /** T50 — solo la finestra visibile della lista a due gruppi (pinnate +
   *  separatore + contestuali). */
  rows: SessionRow[];
  total: number;
  /** T50 — quante delle `total` sono pinnate (badge 📌 nell'header). */
  pinnedCount: number;
  hidden: number;
  selectedId: string | undefined;
  focused: boolean;
  /** T28 — sessionId → origine, per marcare i rami nella lista. */
  forkOf: Map<string, string>;
  /** Sessioni fuori finestra sopra / sotto. */
  above: number;
  below: number;
  columns: number;
  /** T53 — sessionId → nota umana (solo le sessioni annotate). */
  sessionNotes: Map<string, string>;
  /** `name` del progetto: il prefisso che la nota fa sparire. */
  projectCore: string | null;
}) {
  return (
    <Box
      flexDirection="column"
      width="50%"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <SessionsHeader
        parentLabel={parentLabel}
        total={total}
        pinnedCount={pinnedCount}
        hidden={hidden}
        above={above}
        below={below}
        focused={focused}
        columns={columns}
      />
      {total === 0 ? (
        <Text color="yellow" wrap="truncate-end">
          {isAll
            ? 'nessuna conversazione nel progetto'
            : isSpot
              ? 'nessuna sessione libera'
              : 'nessuna sessione legata a questa task'}
        </Text>
      ) : (
        rows.map((row, i) => {
          // T50 — separatore leggero fra pinnate e contestuali: riga dim, non un
          // box pesante (coerente con lo styling delle Done dimmate).
          if (row.kind === 'separator') {
            return (
              <Text key={`sep${i}`} dimColor wrap="truncate-end">
                {SESSION_SEP}
              </Text>
            );
          }
          const sel = row.sessionId === selectedId;
          // T50 — pin stale: transcript sparito, nessuna Session da mostrare.
          // Riga navigabile e spinnabile (`p`), marcata, mai un crash.
          if (row.kind === 'pinned' && row.stale) {
            // T60 — anche qui la nota si taglia sul budget DERIVATO, non su un
            // 30 inchiodato: su un pane stretto quel valore fisso mandava la
            // riga oltre il bordo, e a ripararla arrivava `cli-truncate` (che
            // sfora di una colonna per emoji e mangia il bordo stesso).
            const staleNote = sessionNotes.get(row.sessionId);
            // La riga stale è libera (niente colonne: non ha né titolo né
            // data), ma il binding va detto lo stesso — è una pinnata, quindi
            // l'header del pane non ne dice l'appartenenza.
            const staleTask = bindings.get(row.sessionId) ?? null;
            const staleW = Math.max(
              0,
              paneTextWidth(columns) -
                (2 /* caret */ +
                  termWidth(`${WARN} pin stale `) +
                  SID_CHARS +
                  (staleTask ? termWidth(staleTask) + 1 : 0) +
                  3 /* spazio + caporali */),
            );
            return (
              <Text
                key={row.sessionId}
                inverse={sel && focused}
                bold={sel && !focused}
                dimColor
                wrap="truncate-end"
              >
                {sel ? CARET : CARET_OFF}
                <Text color="yellow">{WARN}</Text> pin stale{' '}
                <Text dimColor>{row.sessionId.slice(0, SID_CHARS)}</Text>
                {staleTask ? <Text color="green"> {staleTask}</Text> : null}
                {/* T53 — su una riga stale la nota è l'UNICA cosa rimasta che
                    dica cosa fosse quella conversazione: il transcript non c'è
                    più, quindi non esiste titolo né primo prompt da mostrare. */}
                {staleNote ? <Text color="yellow"> «{cut(staleNote, staleW)}»</Text> : null}
              </Text>
            );
          }
          const s = row.session as Session; // non-stale → session presente
          const isPinnedRow = row.kind === 'pinned';
          // T28 — un ramo eredita il titolo dell'origine: senza marcatore le due
          // righe sarebbero identiche a occhio.
          const forked = forkOf.has(s.sessionId);
          // T59 D2 — nella vista "tutte" il marker è PER-SESSIONE (binding letto
          // dal sidecar) e non deciso dal parent: la lista mescola scoped e spot,
          // quindi un marker uniforme mentirebbe su metà delle righe. E il solo
          // glifo direbbe *che* la conversazione è legata senza dire *a cosa* —
          // informazione monca proprio qui, l'unica vista dove l'appartenenza
          // non è scritta da nessun'altra parte dello schermo: da qui la colonna
          // task accanto, che esiste solo in questa vista.
          const bound = bindings.get(s.sessionId) ?? null;
          const linked = isAll ? Boolean(bound) : !isSpot;
          // Stesso motivo per cui la colonna esiste: una pinnata resta in lista
          // qualunque sia il parent selezionato, quindi l'header non ne dice
          // l'appartenenza e la cella va riempita anche fuori dalla vista
          // "tutte". Sulle contestuali, dove l'header parla già, resta vuota —
          // ma la cella è comunque larga `taskW`, o le colonne a destra
          // slitterebbero riga per riga.
          const taskCell = isAll || isPinnedRow ? (bound ?? TASK_EMPTY) : '';
          // T60 — colonne VERE: ogni cella fissa è larga esattamente quanto
          // dichiara, riempita di spazi con `pad` (che misura in colonne, non in
          // caratteri). Il marker va portato a 2 anche quando è `○`, largo 1:
          // era lui a far slittare a sinistra di una colonna tutta la riga di
          // ogni sessione spot.
          const age = relTime(s.ts);
          // Il taglio del titolo è ciò che RESTA, calcolato per sottrazione: le
          // colonne fisse sono note, quindi l'unica cella elastica prende il
          // resto. Pavimento `0` e non un minimo di cortesia — è un tetto, non
          // una preferenza: alzarlo sopra lo spazio reale fa uscire la riga dal
          // pane e le mangia il bordo (invariante ③).
          const titleW = Math.max(
            0,
            paneTextWidth(columns) -
              (2 /* caret */ +
                2 /* marker */ +
                1 /* gutter */ +
                SID_CHARS +
                1 /* gutter */ +
                (taskW > 0 ? taskW + 1 : 0) +
                1 /* gutter prima della data */ +
                ageW),
          );
          // T28 — `⑂` sta DENTRO la cella titolo, non in una colonna sua: una
          // colonna dedicata costerebbe 2 spazi vuoti su ogni riga non-fork, e
          // metterlo fuori cella sposterebbe il bordo del titolo solo sui rami —
          // cioè rimetterebbe lo slittamento che le colonne tolgono.
          const forkMark = forked ? '⑂ ' : '';
          const inner = Math.max(0, titleW - termWidth(forkMark));
          // T60 — il testo arriva già ripulito di ciò che le colonne accanto
          // dicono già (progetto e task id): senza, la cella conterrebbe
          // `🧵 loom-works · T59` accanto a una colonna che dice `T59`.
          const label = rowLabel(
            sessionTitle(s, projectCore, bound),
            sessionNotes.get(s.sessionId),
            inner,
          );
          const used =
            (label.note ? termWidth(label.note) + 2 : 0) +
            (label.note && label.rest ? 1 : 0) +
            termWidth(label.rest);
          return (
            <Text key={s.sessionId} inverse={sel && focused} bold={sel && !focused} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              {isPinnedRow ? (
                <Text color="yellow">{pad('📌', 2)}</Text>
              ) : linked ? (
                <Text color="green">{pad('🔗', 2)}</Text>
              ) : (
                <Text dimColor>{pad('○', 2)}</Text>
              )}{' '}
              <Text color="cyan">{s.sessionId.slice(0, SID_CHARS)}</Text>{' '}
              {taskW > 0 ? (
                <>
                  <Text color={bound && taskCell ? 'green' : undefined} dimColor={!bound}>
                    {pad(taskCell, taskW)}
                  </Text>
                  {' '}
                </>
              ) : null}
              {forkMark ? <Text color="magenta">{forkMark}</Text> : null}
              {label.note ? (
                <Text color="yellow" bold>«{label.note}»</Text>
              ) : null}
              {label.note && label.rest ? ' ' : null}
              {label.rest ? <Text dimColor={Boolean(label.note)}>{label.rest}</Text> : null}
              {' '.repeat(Math.max(0, inner - used))}{' '}
              <Text dimColor>{pad(age, ageW, 'right')}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

/**
 * T70 — blocco preview UNICO, a piena larghezza, sotto le due liste.
 *
 * Sostituisce i due pannelli che stavano in fondo a ciascun pane. Tre cose
 * cambiano insieme, e sono la ragione del blocco unico:
 *
 *  · **una cornice invece di due** — le righe di cornice (marginTop + 2 bordi)
 *    si pagavano due volte per mostrare due dettagli di cui se ne guarda uno;
 *  · **piena larghezza** — dentro un pane al 50% il testo aveva ~40 colonne, e
 *    una descrizione di task ci finiva spezzata in 4 righe di moncone;
 *  · **segue il focus** — a sinistra la task, a destra la conversazione. Il
 *    contenuto è quello dell'oggetto su cui si sta agendo, non di entrambi.
 *
 * Il box è qui e i due corpi sono componenti separati: la cornice (e quindi il
 * costo in righe che `layoutBudget` conta) è una sola, scritta una volta sola.
 */
type PreviewProps =
  | { kind: 'task'; detail: TaskDetail; maxLines: number; columns: number }
  | {
      kind: 'session';
      s: Session;
      firstLines: number;
      lastLines: number;
      columns: number;
      /** T28 — id d'origine se la sessione è un ramo, altrimenti null. */
      origin: string | null;
      /** T53 — nota umana; '' = nessuna. */
      note: string;
    };

function PreviewPane(p: PreviewProps) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {p.kind === 'task' ? (
        <TaskPreview detail={p.detail} maxLines={p.maxLines} columns={p.columns} />
      ) : (
        <SessionPreview
          s={p.s}
          firstLines={p.firstLines}
          lastLines={p.lastLines}
          columns={p.columns}
          origin={p.origin}
          note={p.note}
        />
      )}
    </Box>
  );
}

// T49 — corpo della preview sessione. Tutti i campi vengono dal parse già
// cached dell'adapter (mtime-keyed): non costa I/O al movimento di selezione.
// Mostra "da dove parte, dove è arrivata": il primo prompt utente (`» `) e
// l'ultima risposta del modello (`« `). L'anteprima del primo prompt compare
// SOLO con un titolo custom — senza, il titolo È già il primo prompt e la riga
// lo duplicherebbe (D4 preflight). Le righe rese non superano mai il riservato
// dal budget (`firstLines`/`lastLines`); renderne meno è sicuro (frame più corto).
function SessionPreview({
  s,
  firstLines,
  lastLines,
  columns,
  origin,
  note,
}: {
  s: Session;
  firstLines: number;
  lastLines: number;
  columns: number;
  origin: string | null;
  note: string;
}) {
  const width = previewTextWidth(columns);
  const first = s.customTitle && firstLines > 0 ? wrapLines(s.firstPrompt, width, firstLines) : [];
  const last = s.lastReply && lastLines > 0 ? wrapLines(s.lastReply, width, lastLines) : [];
  return (
    <>
      {/* T53 — la nota va sulla riga del titolo, non su una propria: le righe
          FISSE del blocco sono contate dal budget d'altezza (SESSION_DETAIL_FIXED)
          e una riga in più sforerebbe senza passare da `layoutBudget`. Qui il
          titolo resta INTERO anche con la nota — a differenza della lista, nel
          blocco lo spazio c'è e il prefisso non si ripete su N righe. */}
      <Text bold wrap="truncate-end">
        <Text color="cyan">{s.sessionId.slice(0, SID_CHARS)}</Text>{' '}
        {note ? <Text color="yellow">«{note}» </Text> : null}
        <Text dimColor={Boolean(note)}>{s.title}</Text>
      </Text>
      {/* La provenienza va IN CODA alla riga meta esistente, non su una riga
          propria: il budget d'altezza conta le righe fisse del blocco e una
          riga in più le sforerebbe senza passare da layoutBudget. */}
      {/* T60 — il branch è sceso qui dalla riga di lista: era `master` su quasi
          ogni riga, cioè 8 colonne × N che non distinguevano nulla. Nel
          blocco costa 0 righe in più (la meta è già una riga fissa contata da
          SESSION_DETAIL_FIXED) e resta consultabile dove serve davvero. */}
      <Text dimColor wrap="truncate-end">
        {fmtSize(s.sizeBytes)} · {s.turns} turni · {fmtDateTime(s.ts)} · {s.gitBranch || '-'}
        {origin ? ` · ⑂ da ${origin.slice(0, 8)}` : ''}
      </Text>
      {first.map((line, i) => (
        <Text key={`f${i}`} dimColor wrap="truncate-end">
          {i === 0 ? '» ' : '  '}
          {line}
        </Text>
      ))}
      {last.map((line, i) => (
        <Text key={`l${i}`} dimColor wrap="truncate-end">
          {i === 0 ? '« ' : '  '}
          {line}
        </Text>
      ))}
    </>
  );
}

/**
 * Righe non-wrappabili del dettaglio (titolo + meta + commit) e loro conteggio.
 * Estratto dal componente perché il budget deve saperlo PRIMA di renderizzare:
 * sono righe fisse che tolgono spazio alla descrizione.
 */
function detailMetaOf(detail: TaskDetail) {
  const meta = META_KEYS.map((k) => detail.fields[k])
    .filter(Boolean)
    .join('  ·  ');
  const commit = detail.fields['Last tracked commit'] ?? '';
  return { meta, commit, metaLines: 1 + (meta ? 1 : 0) + (commit ? 1 : 0) };
}

/**
 * T70 — larghezza utile del testo dentro il blocco preview, che è a PIENA
 * larghezza: box esterno (2 bordi + 2 padding) → box preview (2 bordi + 2
 * padding). Niente più `/2`: il blocco non vive più dentro un pane al 50%,
 * quindi una riga di descrizione dispone del doppio delle colonne.
 *
 * Volutamente prudente: sottostimare tronca qualche carattere in più,
 * sovrastimare farebbe andare a capo una riga e sforare il tetto d'altezza.
 */
function previewTextWidth(columns: number) {
  return Math.max(10, (columns || 80) - 8);
}

/**
 * Larghezza del TESTO dentro un pane al 50%: box esterno (2 bordi + 2 padding)
 * → metà → bordo + padding del pane.
 *
 * Invariante ③ (`width.ts`): chi renderizza una riga a lunghezza libera la
 * taglia PRIMA con questa larghezza. Delegarlo a `wrap="truncate-end"`
 * significa passare da `cli-truncate`, che indicizza per code point e restituisce
 * una riga più larga di quella chiesta — una colonna per ogni emoji astrale a
 * sinistra del taglio. Quelle colonne finiscono sopra il bordo del pane, che
 * sparisce dalla riga: è la sminchiatura visibile a schermo.
 */
function paneTextWidth(columns: number) {
  return Math.max(20, Math.floor(((columns || 80) - 4) / 2) - 4);
}

/** Corpo della preview task: titolo, meta, descrizione wrappata, commit. */
function TaskPreview({
  detail,
  maxLines,
  columns,
}: {
  detail: TaskDetail;
  maxLines: number;
  columns: number;
}) {
  const { meta, commit } = detailMetaOf(detail);
  // Wrap calcolato qui, non delegato a `<Text wrap="wrap">`: il budget ha
  // riservato ESATTAMENTE `maxLines` righe, e un wrap deciso da Ink a runtime
  // ne produrrebbe un numero che il budget non conosce — cioè il frame torna a
  // sforare e il bug si riapre da questa singola casella di testo.
  const lines = wrapLines(detail.description ?? '', previewTextWidth(columns), maxLines);

  return (
    <>
      <Text bold wrap="truncate-end">{detail.title || detail.id}</Text>
      {meta ? <Text dimColor wrap="truncate-end">{meta}</Text> : null}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      {commit ? <Text dimColor wrap="truncate-end">↳ {commit}</Text> : null}
    </>
  );
}

const cwd = process.cwd();
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} tasksDir={resolveTasksDir(cwd)} />);
