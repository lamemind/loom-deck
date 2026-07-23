import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// SIDECAR sessionId ↔ taskId (T27) + sessionId ↔ origine del fork (T28).
//
// Lo store JSONL di CC NON registra LOOM_TASK/taskId: la classificazione
// spot vs scoped non può derivare dal transcript. La verità è QUESTO indice,
// che il deck popola allo spawn — quando pinna `--session-id <uuid>` (D1
// preflight) il sessionId è già noto, quindi il binding è deterministico.
//
// T28 — il sidecar ospita anche il LINEAGE del fork, per la stessa ragione:
// `--fork-session` produce un transcript che è una COPIA VERBATIM dell'origine
// (stessi uuid dei messaggi) e NON contiene da nessuna parte il sessionId di
// provenienza (verificato empiricamente). `parentUuid` incatena i messaggi
// dentro un transcript, non le sessioni fra loro: nel fork vale `null` esatto
// come nell'origine. Senza un record nostro, un fork è indistinguibile da una
// sessione qualunque — e siccome eredita il titolo, comparirebbe come riga
// gemella dell'originale.
//
// Store (D3 preflight): project-local `<root>/.claude/loom/session-tasks.jsonl`,
// JSONL append-only. Append (non read-modify-write) = concurrency-safe fra
// spawn concorrenti; last-wins in lettura copre eventuali re-pin.
//
// Il record ha entrambi i campi OPZIONALI e indipendenti: un fork di sessione
// spot porta `forkOf` senza `taskId`, un normale spawn scoped l'inverso, un
// fork di sessione scoped entrambi. I lettori filtrano per campo → i record
// scritti prima di T28 (solo taskId) restano validi, nessuna migrazione.

export interface SessionRecord {
  sessionId: string;
  /** Task a cui la sessione è legata (assente = spot). */
  taskId?: string;
  /** sessionId dell'origine, se questa sessione nasce da un fork. */
  forkOf?: string;
}

export function taskIndexPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom', 'session-tasks.jsonl');
}

export function appendSessionRecord(projectRoot: string, rec: SessionRecord): void {
  const path = taskIndexPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...rec, ts: new Date().toISOString() }) + '\n');
}

export function appendTaskBinding(projectRoot: string, sessionId: string, taskId: string): void {
  appendSessionRecord(projectRoot, { sessionId, taskId });
}

export interface SessionIndex {
  /** sessionId → taskId (solo le scoped). */
  bindings: Map<string, string>;
  /** sessionId → sessionId d'origine (solo i fork). */
  forkOf: Map<string, string>;
}

// Una sola lettura del JSONL per entrambe le mappe: il deck poll-a l'indice a
// ogni tick, leggere il file due volte raddoppierebbe l'I/O per nulla.
// Last-wins per campo (un re-pin dello stesso sessionId sovrascrive), e i due
// campi sono indipendenti — un record di solo `forkOf` non cancella un binding
// task scritto prima per lo stesso sessionId.
export function loadSessionIndex(projectRoot: string): SessionIndex {
  const bindings = new Map<string, string>();
  const forkOf = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(taskIndexPath(projectRoot), 'utf8');
  } catch {
    return { bindings, forkOf };
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { sessionId?: unknown; taskId?: unknown; forkOf?: unknown };
      if (typeof d.sessionId !== 'string') continue;
      if (typeof d.taskId === 'string') bindings.set(d.sessionId, d.taskId);
      if (typeof d.forkOf === 'string') forkOf.set(d.sessionId, d.forkOf);
    } catch {
      // riga corrotta → skip
    }
  }
  return { bindings, forkOf };
}
