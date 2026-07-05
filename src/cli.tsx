#!/usr/bin/env node
import { render, Box, Text, useApp, useInput } from 'ink';
import { useState, useEffect } from 'react';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTasksPath, loadTasks, type Task } from './tasks.js';

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

function Deck({ cwd, tasksPath }: { cwd: string; tasksPath: string }) {
  const { exit } = useApp();
  const { tasks, loadError } = useTasks(tasksPath);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState('');

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
      {note ? <Text color="green">{note}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} />);
