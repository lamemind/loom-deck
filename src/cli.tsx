#!/usr/bin/env node
import { render, Box, Text, useApp, useInput } from 'ink';
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
import { loadLaunch, type LaunchEntry } from './config.js';
import {
  applyView,
  cycleSort,
  describeSort,
  toggleHidden,
  PRI_ENTRIES,
  PROG_ENTRIES,
  type PriName,
  type ProgName,
  type SortEntry,
  type SortKey,
  type ViewState,
} from './view.js';
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
type Mode = 'normal' | 'create' | 'sort' | 'filter';

// Griglia del modale filtri: riga 0 = priorità, riga 1 = stato.
interface FilterCursor {
  row: 0 | 1;
  col: number;
}

// Modale sort a grammatica libera: un tasto per chiave, pressioni successive
// ciclano asc → desc → fuori dalla chain.
const SORT_TASTI: Record<string, SortKey> = { p: 'pri', s: 'prog', i: 'id' };

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

// Forza la presentazione emoji (larghezza 2 non-ambigua) su un glifo BMP
// text-default come ⚡ (U+26A1, range simboli U+2190–U+2BFF). Senza il variation
// selector VS16 questi glifi sono larghi-ambigui: Ink li misura 1, ma string-width
// e il terminale li disegnano 2 → la riga esce 1 colonna troppo larga, sfonda il
// pane e va a capo (righe vuote spurie). Gli emoji astrali (🔥🔵🟡…, U+1F000+) sono
// già width-2 non-ambigui e le sequenze con VS16 (✔️) sono >1 code point → intatti.
const VS16 = '️';
function forceEmojiWidth(s: string): string {
  const cps = [...s];
  if (cps.length !== 1) return s;
  const cp = cps[0].codePointAt(0)!;
  if (cp >= 0x2190 && cp <= 0x2bff) return s + VS16;
  return s;
}

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

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
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
        setNote('sessioni read-only in T27 · fork/resume → T28');
      }
    } else if (input === 'C') {
      setNote('');
      setMode('create');
    } else if (input === 'S') {
      setViewBackup(view);
      setNote('');
      setMode('sort');
    } else if (input === 'F') {
      setViewBackup(view);
      setNote('');
      setMode('filter');
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

  const selSessionId = visibleSessions[selSession]?.sessionId;
  const parentLabel = isSpot ? 'spot' : selectedTaskId ?? '—';
  const canSpawn = focus === 'tasks' && !isSpot;
  const launchHint = launch.length > 0 ? `1-${Math.min(9, launch.length)} launch · ` : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      {mode === 'create' ? (
        <Text dimColor>
          nuova task · <Text color="yellow">⏎</Text> crea · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'sort' ? (
        <Text dimColor>
          sort · <Text color="yellow">p</Text> pri <Text color="yellow">s</Text> stato{' '}
          <Text color="yellow">i</Text> id (asc→desc→off) · <Text color="yellow">⏎</Text> ok ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'filter' ? (
        <Text dimColor>
          filtri · <Text color="yellow">↑↓←→</Text> naviga · <Text color="yellow">spazio</Text>{' '}
          mostra/nascondi · <Text color="yellow">⏎</Text> ok · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : (
        <Text dimColor>
          ↑↓ naviga · ←→ pane · ⏎ {canSpawn ? 'spawn' : '—'} · C nuova · S sort · F filtri · w salva ·{' '}
          {launchHint}q esci · focus: <Text color="cyan">{focus}</Text>
        </Text>
      )}
      {mode === 'create' ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">C › </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {mode === 'sort' ? <SortModal sort={view.sort} /> : null}
      {mode === 'filter' ? <FilterModal view={view} cursor={filterCursor} /> : null}
      <Box flexDirection="row" marginTop={1}>
        <TasksPane
          tasks={viewTasks}
          total={tasks.length}
          hidden={hiddenTasks}
          view={view}
          selected={selIndex}
          spotCount={spotCount}
          childCount={childCount}
          focused={focus === 'tasks'}
          loadError={loadError}
          detail={detail}
        />
        <SessionsPane
          parentLabel={parentLabel}
          isSpot={isSpot}
          sessions={visibleSessions}
          total={childSessions.length}
          hidden={hiddenSessions}
          selectedId={selSessionId}
          focused={focus === 'sessions'}
        />
      </Box>
      {note ? <Text color="green">{note}</Text> : null}
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

function TasksPane({
  tasks,
  total,
  hidden,
  view,
  selected,
  spotCount,
  childCount,
  focused,
  loadError,
  detail,
}: {
  tasks: Task[];
  total: number;
  hidden: number;
  view: ViewState;
  selected: number;
  spotCount: number;
  childCount: Map<string, number>;
  focused: boolean;
  loadError: string;
  detail: TaskDetail | null;
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
          Il deck non finge mai una lista completa. */}
      <Text bold color={focused ? 'cyan' : undefined}>
        Tasks ({hidden > 0 ? `${tasks.length}/${total}` : tasks.length})
        {hidden > 0 ? <Text color="yellow"> · {hidden} nascoste</Text> : null}
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
              .map((e) => `−${e.glyph}`)
              .join(' ')}
          </Text>
        ) : null}
      </Text>
      {/* riga meta "spot" come PRIMA voce: sessioni non legate ad alcuna task */}
      <Text inverse={spotSelected && focused} bold={spotSelected && !focused} wrap="truncate-end">
        {spotSelected ? '▶ ' : '  '}
        ○ spot  sessioni libere{spotCount > 0 ? ` (${spotCount})` : ''}
      </Text>
      {loadError ? (
        <Text color="red" wrap="truncate-end">{loadError}</Text>
      ) : (
        tasks.map((task, i) => {
          const sel = i + 1 === selected; // +1: lo 0 è spot
          const n = childCount.get(task.id) ?? 0;
          return (
            <Text
              key={task.id}
              inverse={sel && focused}
              bold={sel && !focused}
              dimColor={!sel && isDone(task.prog)}
              wrap="truncate-end"
            >
              {sel ? '▶ ' : '  '}
              {task.id}  {forceEmojiWidth(task.pri)}  {displayProg(task.prog)}  {task.desc}
              {n > 0 ? ` (${n})` : ''}
            </Text>
          );
        })
      )}
      {detail ? <DetailPane detail={detail} /> : null}
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
}: {
  parentLabel: string;
  isSpot: boolean;
  sessions: Session[];
  total: number;
  hidden: number;
  selectedId: string | undefined;
  focused: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      width="50%"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Text bold color={focused ? 'cyan' : undefined}>
        Sessions · {parentLabel} ({total})
        {hidden > 0 ? <Text dimColor> · +{hidden} più vecchie</Text> : null}
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
              {sel ? '▶ ' : '  '}
              {isSpot ? <Text dimColor>○</Text> : <Text color="green">🔗</Text>}{' '}
              {truncate(s.title, 44)}{' '}
              <Text dimColor>· {s.gitBranch || '-'} · {relTime(s.ts)}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

function DetailPane({ detail }: { detail: TaskDetail }) {
  const meta = META_KEYS.map((k) => detail.fields[k])
    .filter(Boolean)
    .join('  ·  ');
  const commit = detail.fields['Last tracked commit'];

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>{detail.title || detail.id}</Text>
      {meta ? <Text dimColor>{meta}</Text> : null}
      {detail.description ? <Text wrap="wrap">{truncate(detail.description, 300)}</Text> : null}
      {commit ? <Text dimColor>↳ {commit}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} tasksDir={resolveTasksDir(cwd)} />);
