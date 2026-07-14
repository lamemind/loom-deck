#!/usr/bin/env node
import { render, Box, Text, useApp, useInput } from 'ink';
import { useState, useEffect } from 'react';
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

// Editor esterni: aprono l'IDE sulla project root. Il comando risolve attraverso
// la shell login+interattiva dell'utente (bash -lic) → alias/funzioni in ~/.bashrc
// (es. `codium`=alias flatpak, `idea`=funzione) risolvono come nel terminale.
// Override via env per ambienti senza quegli alias (loom-deck è destinato a NPM).
const EDITOR_CMD = {
  codium: process.env.LOOM_DECK_EDITOR_CODIUM ?? 'codium',
  idea: process.env.LOOM_DECK_EDITOR_IDEA ?? 'idea',
};

// Spawn detached come spawnDeck: il deck lancia ma non possiede l'IDE. La project
// root arriva via $PWD (spawn cwd) → niente interpolazione di path, zero injection.
function openEditor(cmd: string, cwd: string) {
  const child = spawn('bash', ['-lic', `${cmd} "$PWD"`], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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
  // selParent ∈ [0, tasks.length]: l'indice 0 è la riga meta "spot" (prima voce),
  // gli indici 1..tasks.length sono le task reali (task = selParent-1).
  const [selParent, setSelParent] = useState(0);
  const [selSession, setSelSession] = useState(0);
  const [note, setNote] = useState('');

  const isSpot = selParent === 0;
  const projectName = cwd.split('/').pop() || cwd;
  const selectedTaskId = isSpot ? null : tasks[selParent - 1]?.id ?? null;
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

  // Dopo un refresh le liste possono accorciarsi: tieni le selezioni in range
  // (max index = tasks.length; spot è sempre l'indice 0).
  useEffect(() => {
    setSelParent((s) => Math.min(s, tasks.length));
  }, [tasks.length]);
  // Cambio padre → riparti dalla prima sessione figlia.
  useEffect(() => {
    setSelSession(0);
  }, [selParent]);
  useEffect(() => {
    setSelSession((s) => Math.min(s, Math.max(0, visibleSessions.length - 1)));
  }, [visibleSessions.length]);

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab) {
      setFocus((f) => (f === 'tasks' ? 'sessions' : 'tasks'));
    } else if (key.upArrow) {
      if (focus === 'tasks') setSelParent((i) => Math.max(0, i - 1));
      else setSelSession((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      if (focus === 'tasks') setSelParent((i) => Math.min(tasks.length, i + 1));
      else setSelSession((i) => Math.min(visibleSessions.length - 1, i + 1));
    } else if (key.return) {
      if (focus === 'tasks') {
        if (isSpot) {
          setNote('spot: sessioni libere, nessuna task da spawnare');
        } else {
          const task = tasks[selParent - 1];
          if (task) {
            // sessionId pinnato lato deck → binding sidecar scritto PRIMA dello
            // spawn: la sessione risulta figlia della task appena il JSONL compare.
            const sid = randomUUID();
            appendTaskBinding(cwd, sid, task.id);
            const child = spawnDeck(task.id, cwd, sid);
            // Un errore di spawn è async: senza handler diventa uncaughtException
            // e ucciderebbe il deck. Lo intercetto per preservare l'invariante
            // "il deck resta vivo" e mostro la nota d'errore.
            child.on('error', () => setNote(`⚠ spawn ${task.id} fallito (${DECK_RUN})`));
            setNote(`⏎ spawn ${task.id} → tab CC (sid ${sid.slice(0, 8)})`);
          }
        }
      } else {
        setNote('sessioni read-only in T27 · fork/resume → T28');
      }
    } else if (input === 'C') {
      const child = openEditor(EDITOR_CMD.codium, cwd);
      child.on('error', () => setNote(`⚠ codium: '${EDITOR_CMD.codium}' non lanciabile`));
      setNote(`C → codium su ${projectName}`);
    } else if (input === 'I') {
      const child = openEditor(EDITOR_CMD.idea, cwd);
      child.on('error', () => setNote(`⚠ idea: '${EDITOR_CMD.idea}' non lanciabile`));
      setNote(`I → idea su ${projectName}`);
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  const selSessionId = visibleSessions[selSession]?.sessionId;
  const parentLabel = isSpot ? 'spot' : selectedTaskId ?? '—';
  const canSpawn = focus === 'tasks' && !isSpot;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor>
        ↑↓ naviga · ←→ pane · ⏎ {canSpawn ? 'spawn' : '—'} · C codium · I idea · q esci ·
        focus: <Text color="cyan">{focus}</Text>
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <TasksPane
          tasks={tasks}
          selected={selParent}
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

function TasksPane({
  tasks,
  selected,
  spotCount,
  childCount,
  focused,
  loadError,
  detail,
}: {
  tasks: Task[];
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
      <Text bold color={focused ? 'cyan' : undefined}>
        Tasks ({tasks.length})
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
              {task.id}  {task.prog}  {task.desc}
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
