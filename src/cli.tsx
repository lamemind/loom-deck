#!/usr/bin/env node
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { useState, useEffect, useMemo } from 'react';
import { spawn } from 'node:child_process';
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
import { discoverProjectSessions, type Session } from './sessions.js';
import { appendTaskBinding, loadTaskBindings } from './task-index.js';
import { launchLegend, loadIdentity, loadLaunch, type LaunchEntry } from './config.js';
import {
  layoutBudget,
  normalizeEmoji,
  windowRange,
  wrapLines,
  type Budget,
  type Mode as ViewportMode,
} from './viewport.js';
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
// dello stato. Righe del modale: 0 priorità · 1 stato · 2 progresso libero.
interface EditDraft {
  pri: PriName;
  prog: ProgName;
  detail: string;
}
type EditRow = 0 | 1 | 2;

// Modale sort a grammatica libera: un tasto per chiave, pressioni successive
// ciclano asc → desc → fuori dalla chain.
const SORT_TASTI: Record<string, SortKey> = { p: 'pri', s: 'prog', i: 'id' };

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

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
// sessionId pinnato (T27) → il binding sidecar è deterministico allo spawn.
function spawnDeck(id: string, cwd: string, sessionId: string) {
  const child = spawn(DECK_RUN, [id, '--session-id', sessionId], {
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
  const child = spawn(DECK_RUN, args, { cwd, detached: true, stdio: 'ignore' });
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
  const child = spawn(DECK_RUN, ['--no-task'], {
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
  const child = spawn('bash', ['-lic', entry.command], {
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
  const child = spawn('ptyxis', args, { cwd, detached: true, stdio: 'ignore' });
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
  const child = spawn(
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
  const child = spawn('git', ['commit', '-m', message, '--', ...paths], {
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
  const [state, setState] = useState<{ sessions: Session[]; bindings: Map<string, string> }>({
    sessions: [],
    bindings: new Map(),
  });

  useEffect(() => {
    let lastSig = '';
    const reload = () => {
      let sessions: Session[];
      let bindings: Map<string, string>;
      try {
        sessions = discoverProjectSessions(projectRoot);
        bindings = loadTaskBindings(projectRoot);
      } catch {
        sessions = [];
        bindings = new Map();
      }
      const sig =
        sessions.map((s) => `${s.sessionId}:${s.ts}`).join('|') +
        '#' +
        [...bindings.entries()].map(([k, v]) => `${k}=${v}`).sort().join(',');
      if (sig === lastSig) return;
      lastSig = sig;
      setState({ sessions, bindings });
    };
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [projectRoot]);

  return state;
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

// Collassa gli spazi (description multi-paragrafo → blocco unico wrappabile) e
// tronca: il pane resta compatto e d'altezza prevedibile sotto la lista.
function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + '…' : flat;
}

// Normalizzazione larghezza glifi → `normalizeEmoji` in viewport.ts.
//
// Sostituisce il precedente `forceEmojiWidth`, che aveva l'intuizione giusta
// (timbrare il VS16) ma due limiti che lasciavano passare il difetto:
//  - agiva solo su stringhe di UN codepoint, quindi non toccava mai un testo
//    composto — la riga della legenda launch, una descrizione task con emoji
//    dentro, il titolo di una sessione;
//  - decideva per intervallo di codepoint invece che per larghezza misurata,
//    quindi avrebbe timbrato anche `↓` `↑` `−` (larghi 1) se gli fossero
//    arrivati da soli, accorciando la riga invece di allargarla.
const forceEmojiWidth = normalizeEmoji;

// Glifi LETTERALI del JSX che ricadono nella classe mal misurata (BMP largo 2
// senza VS16). I dati passano dai loader, questi no: normalizzati una volta
// qui, così nessun sito di render li scrive nudi. `↳ ○ ▸ ⏎ · − ↑ ↓` sono
// larghi 1 e restano intatti.
const CARET = normalizeEmoji('▶ ');
const CARET_OFF = '  ';

// Normalizza il marker Done per il display. `✔` (U+2714) è text-presentation-
// default: string-width — quindi Ink, sia per il layout sia per il troncamento —
// lo misura 2 (rispetta il VS16 di `✔️`), ma VTE/Ptyxis lo disegna largo 1
// (ignora il VS16). Risultato: le righe Done finivano 1 colonna più strette del
// riservato → la coda della riga (bordo destro del pane incluso) slittava a
// sinistra, sfasando il layout solo su quelle righe. `✅` (U+2705) è invece
// emoji-presentation-default → largo 2 sia per string-width sia per il terminale,
// come 🔵/🟡: colonna Prog allineata. Cambia SOLO il display: `task.prog` resta
// `✔️` così `isDone()` continua a matchare.
function displayProg(prog: string): string {
  return forceEmojiWidth(prog.replace(/✔️?/g, '✅'));
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

const META_KEYS = ['Priority', 'Size', 'Estimated Time', 'Progress'];

function Deck({ cwd, tasksPath, tasksDir }: { cwd: string; tasksPath: string; tasksDir: string }) {
  const { exit } = useApp();
  const { tasks, loadError } = useTasks(tasksPath);
  const { sessions, bindings } = useSessions(cwd);
  const [focus, setFocus] = useState<Focus>('tasks');
  // T39 — selezione KEYED SU ID, non su indice. Con una vista trasformata
  // (filtro/sort) l'indice non identifica più la stessa task: leggere l'array
  // grezzo per posizione spawnerebbe la task sbagliata, in silenzio. `null` = la
  // riga meta "spot", sempre in testa alla lista.
  const [selId, setSelId] = useState<string | null>(null);
  const [selSession, setSelSession] = useState(0);
  const [note, setNote] = useState('');
  // Modali: catturano i tasti e corto-circuitano la navigazione normale.
  // T30 create · T39 sort/filter.
  const [mode, setMode] = useState<Mode>('normal');
  const [draft, setDraft] = useState('');
  // T39 — vista corrente (filtri + sort) e sua fotografia all'apertura di un
  // modale: la lista si aggiorna dal vivo, quindi `esc` deve poter ripristinare.
  const [view, setView] = useState<ViewState>(() => loadView(cwd));
  const [viewBackup, setViewBackup] = useState<ViewState | null>(null);
  const [filterCursor, setFilterCursor] = useState<FilterCursor>({ row: 0, col: 0 });
  // T41 — bozza dell'edit (null fuori dal modale) e riga attiva della griglia.
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editRow, setEditRow] = useState<EditRow>(0);

  // Dimensioni vive del terminale: sono l'input del budget d'altezza sotto.
  const { rows, columns } = useTerminalSize();

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
  // Identità (T37): titolo delle tab terminale spawnate col tasto `t`.
  const identity = useMemo(() => loadIdentity(cwd), [cwd]);
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
  const childSessions = sessions.filter((s) => {
    const bound = bindings.get(s.sessionId);
    return selectedTaskId ? bound === selectedTaskId : !bound;
  });
  const visibleSessions = childSessions.slice(0, MAX_SESSIONS);
  const hiddenSessions = childSessions.length - visibleSessions.length;

  // T39 — selezione stabile sotto trasformazione. Se la task selezionata esce
  // dalla vista (filtro appena attivato, oppure sparita da tasks.md), si cade
  // sulla prima visibile — fallback deterministico, mai una posizione a caso.
  useEffect(() => {
    if (selId !== null && !viewTasks.some((t) => t.id === selId)) {
      setSelId(viewTasks[0]?.id ?? null);
    }
  }, [viewTasks, selId]);
  // Cambio padre → riparti dalla prima sessione figlia.
  useEffect(() => {
    setSelSession(0);
  }, [selId]);
  useEffect(() => {
    setSelSession((s) => Math.min(s, Math.max(0, visibleSessions.length - 1)));
  }, [visibleSessions.length]);

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
    setNote(`⏳ creando task… "${truncate(text, 40)}" (sid ${sid.slice(0, 8)})`);
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

  // T41 — apertura dell'edit: la bozza parte dai valori ATTUALI della task, non
  // da default. La priorità arriva dal glifo di tasks.md (già in `selTask`), lo
  // stato dal suo glifo Prog; il progresso arbitrario dal campo `Progress` del
  // task file — ma solo se è davvero custom (vedi `initialDetail`).
  function openEdit() {
    if (!selTask) return;
    const prog = progName(selTask.prog) ?? 'todo';
    setEdit({
      pri: priName(selTask.pri) ?? 'med',
      prog,
      detail: initialDetail(detail?.fields['Progress'] ?? '', prog),
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

    let res: ReturnType<typeof writeTaskEdit>;
    try {
      res = writeTaskEdit({ tasksPath, tasksDir, id: task.id, ...draft });
    } catch (e) {
      setNote(`⚠ ${task.id}: scrittura fallita (${(e as Error).message})`);
      return;
    }
    if (res.paths.length === 0) {
      setNote(`⚠ ${task.id}: nessun campo aggiornabile (riga o task file assenti)`);
      return;
    }

    const summary = `${PRI_GLYPH[draft.pri]} ${PRI_LABEL[draft.pri]} · ${res.progress}`;
    setNote(`⏳ ${task.id} → ${summary} · commit…`);
    commitTaskEdit(
      cwd,
      res.paths,
      `chore(${task.id}): pri ${PRI_LABEL[draft.pri]} · stato ${res.progress}`,
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

  useInput((input, key) => {
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

    // T41 — modale edit: griglia a 3 righe. Righe 0/1 = scelta a valore singolo
    // (←→ scorre), riga 2 = testo libero (ogni carattere stampabile entra nel
    // progresso). Come gli altri modali cattura tutto: `esc` annulla senza
    // scrivere né uscire dal deck.
    if (mode === 'edit') {
      if (key.escape) {
        setMode('normal');
        setEdit(null);
        setNote('E → edit annullato');
      } else if (key.return) {
        submitEdit();
      } else if (key.upArrow) {
        setEditRow((r) => ((r + 2) % 3) as EditRow);
      } else if (key.downArrow) {
        setEditRow((r) => ((r + 1) % 3) as EditRow);
      } else if (key.leftArrow || key.rightArrow) {
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
      } else if (editRow === 2) {
        if (key.backspace || key.delete) {
          setEdit((e) => (e ? { ...e, detail: e.detail.slice(0, -1) } : e));
        } else if (input && !key.ctrl && !key.meta) {
          setEdit((e) => (e ? { ...e, detail: e.detail + input } : e));
        }
      }
      return;
    }

    if (key.leftArrow || key.rightArrow || key.tab) {
      setFocus((f) => (f === 'tasks' ? 'sessions' : 'tasks'));
    } else if (key.upArrow) {
      if (focus === 'tasks') moveTaskSel(-1);
      else setSelSession((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      if (focus === 'tasks') moveTaskSel(1);
      else setSelSession((i) => Math.min(visibleSessions.length - 1, i + 1));
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
        const s = visibleSessions[selSession];
        if (!s) {
          setNote('nessuna sessione da riprendere');
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

  const selSessionObj = visibleSessions[selSession] ?? null;
  const selSessionId = selSessionObj?.sessionId;
  const parentLabel = isSpot ? 'spot' : selectedTaskId ?? '—';
  const canSpawn = focus === 'tasks' && !isSpot;
  const canResume = focus === 'sessions' && selSessionObj !== null;
  // Larghezza dal medesimo hook che dà l'altezza: dopo un resize la legenda si
  // ricalcola con lo stesso re-render che ridimensiona i pane.
  const legend = launchLegend(launch, columns);

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

  // Finestre di rendering. Le liste "logiche" (viewTasks, visibleSessions)
  // restano intere: navigazione, selezione e spawn continuano a ragionare su
  // quelle, la finestra è solo ciò che finisce a schermo.
  const taskWin = windowRange(viewTasks.length, selIndex - 1, budget.taskRows);
  const windowTasks = viewTasks.slice(taskWin.start, taskWin.end);
  const sessionWin = windowRange(visibleSessions.length, selSession, budget.sessionRows);
  const windowSessions = visibleSessions.slice(sessionWin.start, sessionWin.end);

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
      ) : mode === 'edit' ? (
        <Text dimColor wrap="truncate-end">
          edit · <Text color="yellow">↑↓</Text> campo · <Text color="yellow">←→</Text> valore ·{' '}
          <Text color="yellow">⏎</Text> salva+commit · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          ↑↓ naviga · ←→ pane · ⏎ {canSpawn ? 'spawn' : canResume ? 'resume' : '—'} · C nuova · E
          edit · S sort · F filtri · w salva · t term · c claude · q esci · focus:{' '}
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
      {mode === 'sort' ? <SortModal sort={view.sort} /> : null}
      {mode === 'filter' ? <FilterModal view={view} cursor={filterCursor} /> : null}
      {mode === 'edit' && edit && selTask ? (
        <EditModal id={selTask.id} draft={edit} row={editRow} />
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
          sessions={windowSessions}
          total={childSessions.length}
          hidden={hiddenSessions}
          selectedId={selSessionId}
          focused={focus === 'sessions'}
          above={sessionWin.start}
          below={visibleSessions.length - sessionWin.end}
          detail={budget.sessionDetail ? selSessionObj : null}
          firstLines={budget.sessionFirstLines}
          lastLines={budget.sessionLastLines}
          columns={columns}
        />
      </Box>
      {note ? <Text color="green" wrap="truncate-end">{normalizeEmoji(note)}</Text> : null}
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
                [{on ? 'x' : ' '}] {forceEmojiWidth(e.glyph)}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

// T41 — modale edit, in flusso come gli altri (spinge giù i pane invece di
// coprirli: la riga che stai modificando resta visibile sopra la lista).
// La riga di anteprima mostra il testo ESATTO che finirà nel campo `Progress`
// del task file — così il default (`✔️ Done at <oggi>`) non è una sorpresa.
function EditModal({ id, draft, row }: { id: string; draft: EditDraft; row: EditRow }) {
  const mark = (r: EditRow) => (row === r ? CARET : CARET_OFF);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">E › {id} · priorità e stato</Text>
      <Text>
        {mark(0)}
        <Text dimColor>pri  </Text>
        {EDIT_PRI.map((p) => (
          <Text key={p} inverse={draft.pri === p} color={draft.pri === p ? 'green' : 'gray'}>
            {'  '}
            {forceEmojiWidth(PRI_GLYPH[p])} {PRI_LABEL[p]}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(1)}
        <Text dimColor>stato</Text>
        {EDIT_PROG.map((p) => (
          <Text key={p} inverse={draft.prog === p} color={draft.prog === p ? 'green' : 'gray'}>
            {'  '}
            {forceEmojiWidth(PROG_GLYPH[p])} {p}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(2)}
        <Text dimColor>prog </Text>
        <Text>{'  '}{draft.detail}</Text>
        {row === 2 ? <Text inverse> </Text> : null}
        {!draft.detail && row !== 2 ? <Text dimColor>(default)</Text> : null}
      </Text>
      {/* normalizeEmoji SOLO qui, non dentro progressText: quel testo finisce
          nel campo `Progress` del task file, dove il glifo va scritto nudo. */}
      <Text dimColor wrap="truncate-end">
        ↳ {normalizeEmoji(progressText(draft.prog, draft.detail))}
      </Text>
    </Box>
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
              .map((e) => `−${normalizeEmoji(e.glyph)}`)
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
          return (
            <Text
              key={task.id}
              inverse={sel && focused}
              bold={sel && !focused}
              dimColor={!sel && isDone(task.prog)}
              wrap="truncate-end"
            >
              {sel ? CARET : CARET_OFF}
              {task.id}  {forceEmojiWidth(task.pri)}  {displayProg(task.prog)}  {task.desc}
              {n > 0 ? ` (${n})` : ''}
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
  sessions,
  total,
  hidden,
  selectedId,
  focused,
  above,
  below,
  detail,
  firstLines,
  lastLines,
  columns,
}: {
  parentLabel: string;
  isSpot: boolean;
  /** Solo la finestra visibile. */
  sessions: Session[];
  total: number;
  hidden: number;
  selectedId: string | undefined;
  focused: boolean;
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
        {hidden > 0 ? <Text dimColor> · +{hidden} più vecchie</Text> : null}
        {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
        {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
      </Text>
      {total === 0 ? (
        <Text color="yellow" wrap="truncate-end">
          {isSpot ? 'nessuna sessione libera' : 'nessuna sessione legata a questa task'}
        </Text>
      ) : (
        sessions.map((s) => {
          const sel = s.sessionId === selectedId;
          return (
            <Text key={s.sessionId} inverse={sel && focused} bold={sel && !focused} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              {isSpot ? <Text dimColor>○</Text> : <Text color="green">🔗</Text>}{' '}
              {truncate(s.title, 44)}{' '}
              <Text dimColor>· {s.gitBranch || '-'} · {relTime(s.ts)}</Text>
            </Text>
          );
        })
      )}
      {detail ? (
        <SessionDetailPane s={detail} firstLines={firstLines} lastLines={lastLines} columns={columns} />
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
}: {
  s: Session;
  firstLines: number;
  lastLines: number;
  columns: number;
}) {
  const width = detailTextWidth(columns);
  const first = s.customTitle && firstLines > 0 ? wrapLines(s.firstPrompt, width, firstLines) : [];
  const last = s.lastReply && lastLines > 0 ? wrapLines(s.lastReply, width, lastLines) : [];
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate-end">{s.title}</Text>
      <Text dimColor wrap="truncate-end">
        {fmtSize(s.sizeBytes)} · {s.turns} turni · {fmtDateTime(s.ts)}
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
