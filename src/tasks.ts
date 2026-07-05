import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Task {
  id: string;
  prog: string;
  desc: string;
}

// D1 (preflight T20): default docs/tasks.md, override della docs-root via env
// LOOM_DECK_DOCS_ROOT (es. questo progetto usa `runtime`). No auto-detect.
export function resolveTasksPath(cwd: string = process.cwd()): string {
  const docsRoot = process.env.LOOM_DECK_DOCS_ROOT || 'docs';
  return join(cwd, docsRoot, 'tasks.md');
}

// Estrae le righe `| Tnn | Pri | K | Prog | Task |` della Tasks Overview.
// Il prefisso task è `T` (contratto plugin); le doc-task `D{N}` e le righe
// header/separatore non matchano `^T\d+$` → scartate. deck-run agisce solo
// su task T (run-task), quindi le D non hanno azione qui.
export function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    // cells[0] = '' (prima del primo |), cells[last] = '' (dopo l'ultimo |)
    const id = cells[1];
    if (!/^T\d+$/.test(id)) continue;
    const prog = cells[4] ?? '';
    // desc = colonna finale; join per resistere a eventuali `|` nella descrizione.
    const desc = cells.slice(5, -1).join('|').trim();
    tasks.push({ id, prog, desc });
  }
  return tasks;
}

export function loadTasks(path: string): Task[] {
  return parseTasks(readFileSync(path, 'utf8'));
}
