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
  rowIndexOf,
  rowLabel,
  selectedSession,
  stripProjectCore,
  type SessionRow,
} from './session-list.js';
import { launchLegend, loadIdentity, loadLaunch, type LaunchEntry } from './config.js';
import {
  isCompact,
  layoutBudget,
  readerCapacity,
  searchListCapacity,
  searchPreviewCapacity,
  windowRange,
  type Budget,
  type Mode as ViewportMode,
} from './viewport.js';
import {
  caretWindow,
  cut,
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

// Modello task-centrico: il Tasks pane ha, oltre alle task reali, una riga
// meta "spot" (sentinella) che raccoglie le sessioni NON legate ad alcuna task.
// La selezione nel Tasks pane è il "padre"; il Sessions pane mostra i suoi figli.
const SPOT = Symbol('spot');
type Parent = string | typeof SPOT; // taskId | spot

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

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
// sessionId pinnato (T27) → il binding sidecar è deterministico allo spawn.
function spawnDeck(id: string, cwd: string, sessionId: string) {
  const child = spawnOut(DECK_RUN, [id, '--session-id', sessionId], {
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
function spawnDeckResume(taskId: string | null, cwd: string, sessionId: string) {
  const args = taskId ? [taskId, '--resume', sessionId] : ['--no-task', '--resume', sessionId];
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
// `-T <title>` col core `<owner> <name>` tiene la finestra matchabile da compass
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
  // grezzo per posizione spawnerebbe la task sbagliata, in silenzio. `null` = la
  // riga meta "spot", sempre in testa alla lista.
  const [selId, setSelId] = useState<string | null>(null);
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

  // Dimensioni vive del terminale: sono l'input del budget d'altezza sotto.
  const { rows, columns } = useTerminalSize();

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
  // Identità (T37): titolo delle tab terminale spawnate col tasto `t`.
  const identity = useMemo(() => loadIdentity(cwd), [cwd]);
  // T53 — `<owner> <name>`: il core che ogni titolo di tab porta, quindi la
  // colonna costante da togliere quando serve spazio. Hoistato qui perché ora
  // lo consumano DUE schermate (lista e ricerca): calcolarlo su ogni call site
  // è il modo in cui le due smettono di togliere la stessa cosa.
  const projectCore = identity ? `${identity.owner} ${identity.name}` : null;
  // La vista è una trasformazione DERIVATA, applicata a valle del load: il
  // polling di tasks.md continua a funzionare senza saperne nulla.
  const { visible: viewTasks, hidden: hiddenTasks } = useMemo(
    () => applyView(tasks, view),
    [tasks, view],
  );

  const isSpot = selId === null;
  const projectName = cwd.split('/').pop() || cwd;
  // Unica fonte della selezione: si legge SEMPRE dalla vista, mai dall'array
  // grezzo — è l'invariante che tiene allineati dettaglio mostrato e spawn.
  const selTask = selId === null ? null : viewTasks.find((t) => t.id === selId) ?? null;
  const selectedTaskId = selTask?.id ?? null;
  const selIndex = selTask ? viewTasks.indexOf(selTask) + 1 : 0;
  const detail = useTaskDetail(tasksDir, selectedTaskId ?? undefined);

  // Conteggio figli per task + spot (badge nel Tasks pane).
  const childCount = new Map<string, number>();
  let spotCount = 0;
  for (const s of sessions) {
    const bound = bindings.get(s.sessionId);
    if (bound) childCount.set(bound, (childCount.get(bound) ?? 0) + 1);
    else spotCount++;
  }

  // Figli della selezione: sessioni bound alla task selezionata, oppure (spot)
  // le sessioni senza binding. sessions è già ts desc → l'ordine si eredita.
  // Memoizzato così `sessionRows` resta stabile fra render che non cambiano gli
  // input: l'effect di validità della selezione non rigira a vuoto.
  const childSessions = useMemo(
    () =>
      sessions.filter((s) => {
        const bound = bindings.get(s.sessionId);
        return selectedTaskId ? bound === selectedTaskId : !bound;
      }),
    [sessions, bindings, selectedTaskId],
  );
  // T50 — lista a due gruppi: pinnate (sempre, in cima) + separatore +
  // contestuali. Dedup, cap solo sulle contestuali, righe stale per le pinnate
  // orfane. Core PURO in session-list.ts (testabile senza Ink).
  const assembled = useMemo(
    () => assembleSessionList(childSessions, sessions, pinned, MAX_SESSIONS),
    [childSessions, sessions, pinned],
  );
  const sessionRows = assembled.rows;
  const selSessionObj = selectedSession(sessionRows, selSessionId);

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

  // T39 — selezione stabile sotto trasformazione. Se la task selezionata esce
  // dalla vista (filtro appena attivato, oppure sparita da tasks.md), si cade
  // sulla prima visibile — fallback deterministico, mai una posizione a caso.
  useEffect(() => {
    if (selId !== null && !viewTasks.some((t) => t.id === selId)) {
      setSelId(viewTasks[0]?.id ?? null);
    }
  }, [viewTasks, selId]);
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

  // Sposta la selezione di `delta` righe nella VISTA (0 = spot, 1..N = task
  // visibili) e la riconverte subito in id: l'indice non sopravvive a un
  // cambio di filtro, l'id sì.
  function moveTaskSel(delta: number) {
    const next = Math.max(0, Math.min(viewTasks.length, selIndex + delta));
    setSelId(next === 0 ? null : viewTasks[next - 1]?.id ?? null);
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
      const child = spawnDeckResume(bound, cwd, row.session.sessionId);
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
        if (isSpot) {
          setNote('spot: sessioni libere, nessuna task da spawnare');
        } else if (selTask) {
          // sessionId pinnato lato deck → binding sidecar scritto PRIMA dello
          // spawn: la sessione risulta figlia della task appena il JSONL compare.
          const sid = randomUUID();
          appendTaskBinding(cwd, sid, selTask.id);
          const child = spawnDeck(selTask.id, cwd, sid);
          // Un errore di spawn è async: senza handler diventa uncaughtException
          // e ucciderebbe il deck. Lo intercetto per preservare l'invariante
          // "il deck resta vivo" e mostro la nota d'errore.
          child.on('error', () => setNote(`⚠ spawn ${selTask.id} fallito (${DECK_RUN})`));
          setNote(`⏎ spawn ${selTask.id} → tab CC (sid ${sid.slice(0, 8)})`);
        }
      } else {
        // T49 — ⏎ su una sessione = resume in nuova tab. Il binding si rilegge
        // dal sidecar (non dal padre selezionato): vale anche per le spot.
        const s = selSessionObj;
        if (!s) {
          setNote(selSessionId ? 'pin stale: transcript non più presente' : 'nessuna sessione da riprendere');
        } else {
          const bound = bindings.get(s.sessionId) ?? null;
          const child = spawnDeckResume(bound, cwd, s.sessionId);
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
      // L'edit ha senso solo su una task reale: la riga meta "spot" non ne è una.
      if (isSpot || !selTask) setNote('E → nessuna task selezionata');
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
    } else if (input === 't') {
      const title = identity ? `🖥️ ${identity.owner} ${identity.name} [term]` : null;
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

  const parentLabel = isSpot ? 'spot' : selectedTaskId ?? '—';
  const canSpawn = focus === 'tasks' && !isSpot;
  const canResume = focus === 'sessions' && selSessionObj !== null;
  // T50 — il pin agisce su qualunque riga selezionata (anche stale, per
  // spinnarla); basta il focus sul pane e una selezione.
  const canPin = focus === 'sessions' && selSessionId !== null;
  // Larghezza dal medesimo hook che dà l'altezza: dopo un resize la legenda si
  // ricalcola con lo stesso re-render che ridimensiona i pane.
  const legend = launchLegend(launch, columns);

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
  const launchLine = mode === 'normal' && launch.length > 0;
  const detailParts = detail ? detailMetaOf(detail) : null;
  const budget: Budget = layoutBudget({
    rows,
    mode,
    launchLine,
    noteLine: Boolean(note),
    hasDetail: Boolean(detail),
    detailMetaLines: detailParts?.metaLines ?? 0,
    // T49 — il detail pane sessione esiste solo con il focus sul pane: è
    // l'hover, non uno stato persistente; navigando le task non ruba righe.
    hasSessionDetail: canResume,
    // Riservo righe di preview solo per i blocchi che davvero renderizzano: il
    // primo prompt aggiunge info solo con un titolo custom (senza, titolo ===
    // primo prompt); l'ultima risposta solo se il modello ha già risposto.
    sessionHasFirstPreview: canResume && Boolean(selSessionObj?.customTitle),
    sessionHasLastPreview: canResume && Boolean(selSessionObj?.lastReply),
  });

  // Finestre di rendering. Le liste "logiche" (viewTasks, sessionRows)
  // restano intere: navigazione, selezione e spawn continuano a ragionare su
  // quelle, la finestra è solo ciò che finisce a schermo.
  const taskWin = windowRange(viewTasks.length, selIndex - 1, budget.taskRows);
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
          {' '}· {viewTasks.length} task · sel {selectedTaskId ?? 'spot'} · terminale {rows}×
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
          ↑↓ naviga · ←→ pane · ⏎ {canSpawn ? 'spawn' : canResume ? 'resume' : '—'}
          {canResume ? ' · f fork' : ''}{canPin ? ' · p pin · N nota' : ''} · ^F cerca · C nuova · E edit ·
          S sort · F filtri · w salva · t term · c claude · q esci · focus:{' '}
          <Text color="cyan">{focus}</Text>
        </Text>
      )}
      {/* T43 — riga dedicata alla mappa indice→launch. Nessuna voce configurata
          → riga assente e footer identico a prima (nessuna regressione). */}
      {mode === 'normal' && launch.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          launch {legend.shown}
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
          view={view}
          selected={selIndex}
          spotCount={spotCount}
          childCount={childCount}
          focused={focus === 'tasks'}
          loadError={loadError}
          detail={detail}
          windowStart={taskWin.start}
          above={taskWin.start}
          below={viewTasks.length - taskWin.end}
          detailLines={budget.detailLines}
          columns={columns}
        />
        <SessionsPane
          parentLabel={parentLabel}
          isSpot={isSpot}
          rows={windowRows}
          total={assembled.pinnedCount + assembled.contextTotal}
          pinnedCount={assembled.pinnedCount}
          hidden={assembled.contextHidden}
          selectedId={selSessionId ?? undefined}
          focused={focus === 'sessions'}
          above={sessionWin.start}
          below={sessionRows.length - sessionWin.end}
          detail={budget.sessionDetail ? selSessionObj : null}
          firstLines={budget.sessionFirstLines}
          lastLines={budget.sessionLastLines}
          columns={columns}
          forkOf={forkOf}
          sessionNotes={sessionNotes}
          projectCore={projectCore}
        />
      </Box>
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
 * `<emoji> <owner> <name>` più un eventuale suffisso. Su una lista tutta dello
 * stesso progetto (D3) è una COLONNA COSTANTE — tre righe su quattro
 * identiche, che è esattamente il difetto che la riga-gruppo doveva evitare.
 *
 * Si toglie quindi il core `<owner> <name>` (noto dal file config), e se ciò
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
  /** `<owner> <name>` del progetto: prefisso da togliere ai titoli di tab. */
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

function TasksPane({
  tasks,
  filtered,
  total,
  hidden,
  view,
  selected,
  spotCount,
  childCount,
  focused,
  loadError,
  detail,
  windowStart,
  above,
  below,
  detailLines,
  columns,
}: {
  /** Solo la finestra visibile, non la lista completa. */
  tasks: Task[];
  /** Task superstiti ai filtri — NON `tasks.length`, che è la sola finestra. */
  filtered: number;
  total: number;
  hidden: number;
  view: ViewState;
  /** Indice nella lista COMPLETA (0 = riga spot). */
  selected: number;
  spotCount: number;
  childCount: Map<string, number>;
  focused: boolean;
  loadError: string;
  detail: TaskDetail | null;
  /** Offset della finestra nella lista completa. */
  windowStart: number;
  /** Task fuori finestra sopra / sotto. */
  above: number;
  below: number;
  /** Righe di descrizione concesse al dettaglio; 0 = pannello omesso. */
  detailLines: number;
  columns: number;
}) {
  const spotSelected = selected === 0;
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
          costerebbe proprio la riga di lista che sta segnalando come mancante. */}
      <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
        Tasks ({hidden > 0 ? `${filtered}/${total}` : filtered})
        {hidden > 0 ? <Text color="yellow"> · {hidden} nascoste</Text> : null}
        {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
        {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        sort: {describeSort(view.sort)}
        {view.hiddenPri.length + view.hiddenProg.length > 0 ? (
          <Text>
            {' '}· filtri:{' '}
            {[
              ...PRI_ENTRIES.filter((e) => view.hiddenPri.includes(e.name)),
              ...PROG_ENTRIES.filter((e) => view.hiddenProg.includes(e.name)),
            ]
              .map((e) => `−${sanitize(e.glyph)}`)
              .join(' ')}
          </Text>
        ) : null}
      </Text>
      {/* riga meta "spot" come PRIMA voce: sessioni non legate ad alcuna task */}
      <Text inverse={spotSelected && focused} bold={spotSelected && !focused} wrap="truncate-end">
        {spotSelected ? CARET : CARET_OFF}
        ○ spot  sessioni libere{spotCount > 0 ? ` (${spotCount})` : ''}
      </Text>
      {loadError ? (
        <Text color="red" wrap="truncate-end">{loadError}</Text>
      ) : (
        tasks.map((task, i) => {
          // windowStart riporta l'indice di finestra a quello della lista
          // completa, su cui è keyata la selezione. +1: lo 0 è spot.
          const sel = windowStart + i + 1 === selected;
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
      {/* detailLines a 0 = il budget non ha spazio per il pannello: si omette
          del tutto, non si rende una cornice vuota che ruberebbe altre righe. */}
      {detail && detailLines > 0 ? (
        <DetailPane detail={detail} maxLines={detailLines} columns={columns} />
      ) : null}
    </Box>
  );
}

function SessionsPane({
  parentLabel,
  isSpot,
  rows,
  total,
  pinnedCount,
  hidden,
  selectedId,
  focused,
  above,
  below,
  detail,
  firstLines,
  lastLines,
  columns,
  forkOf,
  sessionNotes,
  projectCore,
}: {
  parentLabel: string;
  isSpot: boolean;
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
  /** T49 — sessione nel detail pane; null = pannello omesso (dal budget). */
  detail: Session | null;
  /** Righe di preview del primo prompt concesse dal budget. */
  firstLines: number;
  /** Righe di preview dell'ultima risposta del modello. */
  lastLines: number;
  columns: number;
  /** T53 — sessionId → nota umana (solo le sessioni annotate). */
  sessionNotes: Map<string, string>;
  /** `<owner> <name>` del progetto: il prefisso che la nota fa sparire. */
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
      <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
        Sessions · {parentLabel} ({total})
        {pinnedCount > 0 ? <Text color="yellow"> · 📌{pinnedCount}</Text> : null}
        {hidden > 0 ? <Text dimColor> · +{hidden} più vecchie</Text> : null}
        {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
        {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
      </Text>
      {total === 0 ? (
        <Text color="yellow" wrap="truncate-end">
          {isSpot ? 'nessuna sessione libera' : 'nessuna sessione legata a questa task'}
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
                <Text dimColor>{row.sessionId.slice(0, 8)}</Text>
                {/* T53 — su una riga stale la nota è l'UNICA cosa rimasta che
                    dica cosa fosse quella conversazione: il transcript non c'è
                    più, quindi non esiste titolo né primo prompt da mostrare. */}
                {sessionNotes.get(row.sessionId) ? (
                  <Text color="yellow"> «{cut(sessionNotes.get(row.sessionId)!, 30)}»</Text>
                ) : null}
              </Text>
            );
          }
          const s = row.session as Session; // non-stale → session presente
          const isPinnedRow = row.kind === 'pinned';
          // T28 — un ramo eredita il titolo dell'origine: senza marcatore le due
          // righe sarebbero identiche a occhio. `⑂` sta PRIMA del titolo, dove
          // la troncatura non arriva mai.
          const forked = forkOf.has(s.sessionId);
          // T53 — con una nota il prefisso di progetto sparisce e le sue colonne
          // passano alla nota; senza, il titolo resta com'è (vedi `rowLabel`).
          //
          // Invariante ③: il budget è DERIVATO da `columns`, non inchiodato.
          // Con un valore fisso (erano 44) su un terminale stretto la riga
          // superava il pane, e a troncarla finiva `cli-truncate` — che sfora
          // di una colonna per emoji e si mangia il bordo destro.
          const meta = ` · ${s.gitBranch || '-'} · ${relTime(s.ts)}`;
          const labelBudget = Math.max(
            12,
            paneTextWidth(columns) -
              (2 /* caret */ + 2 /* icona */ + 1 /* spazio */ + (forked ? 2 : 0)) -
              termWidth(meta) -
              1 /* spazio prima del meta */,
          );
          const label = rowLabel(
            s.title,
            sessionNotes.get(s.sessionId),
            projectCore,
            labelBudget,
          );
          return (
            <Text key={s.sessionId} inverse={sel && focused} bold={sel && !focused} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              {isPinnedRow ? (
                <Text color="yellow">📌</Text>
              ) : isSpot ? (
                <Text dimColor>○</Text>
              ) : (
                <Text color="green">🔗</Text>
              )}{' '}
              {forked ? <Text color="magenta">⑂ </Text> : null}
              {label.note ? (
                <Text color="yellow" bold>«{label.note}»</Text>
              ) : null}
              {label.note && label.rest ? ' ' : null}
              {label.rest ? <Text dimColor={Boolean(label.note)}>{label.rest}</Text> : null}{' '}
              <Text dimColor>· {s.gitBranch || '-'} · {relTime(s.ts)}</Text>
            </Text>
          );
        })
      )}
      {detail ? (
        <SessionDetailPane
          s={detail}
          firstLines={firstLines}
          lastLines={lastLines}
          columns={columns}
          origin={forkOf.get(detail.sessionId) ?? null}
          note={sessionNotes.get(detail.sessionId) ?? ''}
        />
      ) : null}
    </Box>
  );
}

// T49 — detail pane della sessione selezionata (hover), gemello del DetailPane
// task. Tutti i campi vengono dal parse già cached dell'adapter (mtime-keyed):
// il pannello non costa I/O al movimento di selezione. Mostra "da dove parte,
// dove è arrivata": il primo prompt utente (`» `) e l'ultima risposta del
// modello (`« `). La preview del primo prompt compare SOLO con un titolo custom
// — senza, il titolo È già il primo prompt e la riga lo duplicherebbe (D4
// preflight). Le righe rese non superano mai il riservato dal budget
// (`firstLines`/`lastLines`); renderne meno è sicuro (frame più corto).
function SessionDetailPane({
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
  /** T28 — id d'origine se la sessione è un ramo, altrimenti null. */
  origin: string | null;
  /** T53 — nota umana; '' = nessuna. */
  note: string;
}) {
  const width = detailTextWidth(columns);
  const first = s.customTitle && firstLines > 0 ? wrapLines(s.firstPrompt, width, firstLines) : [];
  const last = s.lastReply && lastLines > 0 ? wrapLines(s.lastReply, width, lastLines) : [];
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {/* T53 — la nota va sulla riga del titolo, non su una propria: le righe
          FISSE del pannello sono contate dal budget d'altezza (SESSION_DETAIL_FIXED)
          e una riga in più sforerebbe senza passare da `layoutBudget`. Qui il
          titolo resta INTERO anche con la nota — a differenza della lista, nel
          pannello lo spazio c'è e il prefisso non si ripete su N righe. */}
      <Text bold wrap="truncate-end">
        {note ? <Text color="yellow">«{note}» </Text> : null}
        <Text dimColor={Boolean(note)}>{s.title}</Text>
      </Text>
      {/* La provenienza va IN CODA alla riga meta esistente, non su una riga
          propria: il budget d'altezza conta le righe fisse del pannello e una
          riga in più le sforerebbe senza passare da layoutBudget. */}
      <Text dimColor wrap="truncate-end">
        {fmtSize(s.sizeBytes)} · {s.turns} turni · {fmtDateTime(s.ts)}
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
    </Box>
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
 * Larghezza utile del testo di descrizione, ricavata dalle colonne del
 * terminale: box esterno (2 bordi + 2 padding) → pane al 50% → box dettaglio
 * (2 bordi + 2 padding).
 *
 * Volutamente prudente: sottostimare tronca qualche carattere in più,
 * sovrastimare farebbe andare a capo una riga e sforare il tetto d'altezza.
 */
function detailTextWidth(columns: number) {
  return Math.max(10, Math.floor(((columns || 80) - 4) / 2) - 9);
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

function DetailPane({
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
  const lines = wrapLines(detail.description ?? '', detailTextWidth(columns), maxLines);

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate-end">{detail.title || detail.id}</Text>
      {meta ? <Text dimColor wrap="truncate-end">{meta}</Text> : null}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      {commit ? <Text dimColor wrap="truncate-end">↳ {commit}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} tasksDir={resolveTasksDir(cwd)} />);
