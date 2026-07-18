import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Task {
  id: string;
  pri: string;
  prog: string;
  desc: string;
}

// Dettaglio letto dal task file singolo (Q1+B T20): campi header + description.
// `fields` è un dizionario grezzo dei bullet `- **Campo**: valore` così che
// futuri consumer (T21/T22) possano leggere chiavi nuove senza toccare il parser.
export interface TaskDetail {
  id: string;
  title: string;
  fields: Record<string, string>;
  description: string;
}

// D1 (preflight T20): default docs/tasks.md, override della docs-root via env
// LOOM_DECK_DOCS_ROOT (es. questo progetto usa `runtime`). No auto-detect.
export function resolveTasksPath(cwd: string = process.cwd()): string {
  const docsRoot = process.env.LOOM_DECK_DOCS_ROOT || 'docs';
  return join(cwd, docsRoot, 'tasks.md');
}

// I task file vivono in `<docsRoot>/tasks/` — sibling di tasks.md. Derivo la
// dir dallo stesso path per rispettare l'override LOOM_DECK_DOCS_ROOT.
export function resolveTasksDir(cwd: string = process.cwd()): string {
  return join(dirname(resolveTasksPath(cwd)), 'tasks');
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
    // Colonne overview: | ID | Pri | K | Prog | Task | → cells[2]=Pri (icona
    // priorità), cells[4]=Prog. K (Kind, cells[3]) non serve al deck.
    const pri = cells[2] ?? '';
    const prog = cells[4] ?? '';
    // desc = colonna finale; join per resistere a eventuali `|` nella descrizione.
    const desc = cells.slice(5, -1).join('|').trim();
    tasks.push({ id, pri, prog, desc });
  }
  return tasks;
}

export function loadTasks(path: string): Task[] {
  return parseTasks(readFileSync(path, 'utf8'));
}

// ID → path del task file: `<id>-<slug>.md` nella tasks dir. Il dash dopo l'ID
// disambigua i prefissi (`T20-` non matcha `T2-…`). Se più file matchano, primo
// in ordine. `null` se la dir non è leggibile o nessun file matcha.
export function findTaskFile(dir: string, id: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${id}-`;
  const match = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()[0];
  return match ? join(dir, match) : null;
}

// Estrae title (H1, `Task:` prefix strippato), bullet header e blocco
// `## Description`. First-match-wins per chiave: se un campo compare due volte
// (es. T15 ha una riga Progress `yyyy-MM-dd` residuo template nel body) vince la
// prima — quella dell'header. La description si ferma al successivo `## `.
export function parseTaskDetail(id: string, content: string): TaskDetail {
  let title = '';
  const fields: Record<string, string> = {};
  const descLines: string[] = [];
  let inDesc = false;

  for (const line of content.split('\n')) {
    if (!title && line.startsWith('# ')) {
      title = line.replace(/^#\s+/, '').replace(/^Task:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('## ')) {
      inDesc = /^##\s+Description\b/.test(line);
      continue;
    }
    if (inDesc) {
      descLines.push(line);
      continue;
    }
    const f = line.match(/^-\s*\*\*(.+?)\*\*:\s*(.*)$/);
    if (f) {
      const key = f[1].trim();
      if (!(key in fields)) fields[key] = f[2].trim();
    }
  }

  return { id, title, fields, description: descLines.join('\n').trim() };
}

export function loadTaskDetail(dir: string, id: string): TaskDetail | null {
  const path = findTaskFile(dir, id);
  if (!path) return null;
  try {
    return parseTaskDetail(id, readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
