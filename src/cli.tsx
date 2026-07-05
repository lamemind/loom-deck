#!/usr/bin/env node
import { render, Box, Text, useApp, useInput } from 'ink';
import { useState, useEffect } from 'react';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
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

// scripts/deck-run è un sibling della dir del bundle: src/ (dev, tsx) e dist/
// (build, node) stanno entrambi sotto la package root → risalita di un livello.
const DECK_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deck-run');

const POLL_MS = 1500;

function isDone(prog: string): boolean {
  return prog.includes('✔');
}

// Spawn detached: il deck spawna ma NON contiene la sessione (la possiede
// ptyxis-agent). unref + stdio ignore → ritorna subito, la TUI resta viva.
function spawnDeck(id: string, cwd: string) {
  const child = spawn(DECK_RUN, [id], {
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

const META_KEYS = ['Priority', 'Size', 'Estimated Time', 'Progress'];

function Deck({ cwd, tasksPath, tasksDir }: { cwd: string; tasksPath: string; tasksDir: string }) {
  const { exit } = useApp();
  const { tasks, loadError } = useTasks(tasksPath);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState('');
  const detail = useTaskDetail(tasksDir, tasks[selected]?.id);

  // Dopo un refresh la lista può accorciarsi: tieni la selezione in range.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, tasks.length - 1)));
  }, [tasks.length]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelected((i) => Math.min(tasks.length - 1, i + 1));
    } else if (key.return) {
      const task = tasks[selected];
      if (task) {
        const child = spawnDeck(task.id, cwd);
        // Un errore di spawn è async: senza handler diventa uncaughtException
        // e ucciderebbe il deck. Lo intercetto per preservare l'invariante
        // "il deck resta vivo" e mostro la nota d'errore.
        child.on('error', () => setNote(`⚠ spawn ${task.id} fallito (${DECK_RUN})`));
        setNote(`⏎ spawn ${task.id} → tab CC`);
      }
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor>deck · ↑↓ naviga · ⏎ spawn · q esci</Text>
      <Box flexDirection="column" marginTop={1}>
        {loadError ? (
          <Text color="red">{loadError}</Text>
        ) : tasks.length === 0 ? (
          <Text color="yellow">nessuna task in {tasksPath}</Text>
        ) : (
          tasks.map((task, i) => {
            const sel = i === selected;
            return (
              <Text key={task.id} inverse={sel} dimColor={!sel && isDone(task.prog)} wrap="truncate-end">
                {sel ? '▶ ' : '  '}
                {task.id}  {task.prog}  {task.desc}
              </Text>
            );
          })
        )}
      </Box>
      {detail ? <DetailPane detail={detail} /> : null}
      {note ? <Text color="green">{note}</Text> : null}
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
