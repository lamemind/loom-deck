import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// SIDECAR sessionId ↔ taskId (T27).
//
// Lo store JSONL di CC NON registra LOOM_TASK/taskId: la classificazione
// spot vs scoped non può derivare dal transcript. La verità è QUESTO indice,
// che il deck popola allo spawn — quando pinna `--session-id <uuid>` (D1
// preflight) il sessionId è già noto, quindi il binding è deterministico.
//
// Store (D3 preflight): project-local `<root>/.claude/loom/session-tasks.jsonl`,
// JSONL append-only. Append (non read-modify-write) = concurrency-safe fra
// spawn concorrenti; last-wins in lettura copre eventuali re-pin.

export function taskIndexPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom', 'session-tasks.jsonl');
}

export function appendTaskBinding(projectRoot: string, sessionId: string, taskId: string): void {
  const path = taskIndexPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const record = { sessionId, taskId, ts: new Date().toISOString() };
  appendFileSync(path, JSON.stringify(record) + '\n');
}

// sessionId → taskId, last-wins (un re-pin dello stesso sessionId sovrascrive).
export function loadTaskBindings(projectRoot: string): Map<string, string> {
  const bindings = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(taskIndexPath(projectRoot), 'utf8');
  } catch {
    return bindings;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { sessionId?: unknown; taskId?: unknown };
      if (typeof d.sessionId === 'string' && typeof d.taskId === 'string') {
        bindings.set(d.sessionId, d.taskId);
      }
    } catch {
      // riga corrotta → skip
    }
  }
  return bindings;
}
