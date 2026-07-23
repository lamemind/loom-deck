import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { normalizeEmoji } from './viewport.js';

// ADAPTER ISOLATO sullo store interno di Claude Code (T27).
//
// CC persiste ogni sessione come transcript JSONL in
// `~/.claude/projects/<project-hash>/<sessionId>.jsonl`. Lo schema è STORE
// INTERNO, NON contratto pubblico: può cambiare a un update. Tutto l'accesso
// allo store vive QUI — se lo schema rompe, si fixa questo solo file.
//
// Campi live confermati (verifica preflight T27): sessionId su OGNI riga;
// cwd/gitBranch solo su type ∈ {attachment,user,assistant} (assenti su
// queue-operation/last-prompt) → scan della prima riga che li porta, non riga 0.
// customTitle vive su record dedicati `type:custom-title`, ripetuti, e può
// comparire a fine file quando il titolo è settato mid-sessione → last-wins.

export interface Session {
  sessionId: string;
  cwd: string;
  gitBranch: string;
  parentUuid: string | null;
  title: string;
  ts: number; // ordering key = file mtimeMs
  path: string;
  /** Dimensione del transcript su disco (stat, non parse). */
  sizeBytes: number;
  /** Turni = messaggi user con testo estraibile. Esclude i record type:user
   *  che portano solo tool_result (stesso type, ma non sono prompt umani). */
  turns: number;
  /** Titolo custom esplicito ('' se mai settato) — il campo `title` è la
   *  derivata display (custom || primo prompt || placeholder). */
  customTitle: string;
  /** Primo prompt utente, già ripulito (preview nel detail pane T49). */
  firstPrompt: string;
}

export interface SessionGroup {
  branch: string;
  sessions: Session[];
}

// CC codifica la project dir sostituendo ogni char non-alfanumerico con '-'
// (verificato: `/home/lamemind/cc-host` → `-home-lamemind-cc-host`). È LOSSY
// (un '-' nel path e un '/' collassano nello stesso char) → il forward è
// deterministico ma non reversibile; per questo filtriamo comunque per cwd.
export function projectDirName(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

// Collassa whitespace/newline e strippa i tag XML-ish dei wrapper comando CC
// (`<command-name>`, `<local-command-*>`, …) per una preview leggibile.
function cleanPreview(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUserText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return cleanPreview(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const t = cleanPreview((block as { text: string }).text);
        if (t) return t;
      }
    }
  }
  return '';
}

// Cache mtime-keyed: re-parse solo i file cambiati. Steady-state di una TUI che
// poll-a resta economico anche con decine di sessioni multi-MB. Lo stato vive
// dentro l'adapter così l'invariante "unico modulo che tocca lo store" regge.
const cache = new Map<string, { mtime: number; session: Session | null }>();

function parseSessionFile(path: string, mtime: number, sizeBytes: number): Session | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let sessionId = basename(path).replace(/\.jsonl$/, '');
  let cwd = '';
  let gitBranch = '';
  let parentUuid: string | null = null;
  let customTitle = '';
  let firstUserText = '';
  let turns = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d.sessionId === 'string' && d.sessionId) sessionId = d.sessionId;
    if (!cwd && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
    if (!gitBranch && typeof d.gitBranch === 'string' && d.gitBranch) gitBranch = d.gitBranch;
    if (parentUuid === null && typeof d.parentUuid === 'string' && d.parentUuid) {
      parentUuid = d.parentUuid;
    }
    if (typeof d.customTitle === 'string' && d.customTitle) customTitle = d.customTitle; // last-wins
    if (d.type === 'user') {
      // T49: turno = prompt umano. I tool_result viaggiano anch'essi come
      // type:user ma senza blocchi text → extractUserText '' li esclude.
      const t = extractUserText(d.message);
      if (t) {
        turns++;
        if (!firstUserText) firstUserText = t;
      }
    }
  }

  if (!cwd) return null; // nessuna riga con cwd → non è una sessione di progetto valida

  return {
    sessionId,
    cwd,
    gitBranch,
    parentUuid,
    title: normalizeEmoji(customTitle || firstUserText || '(senza titolo)'),
    ts: mtime,
    path,
    sizeBytes,
    turns,
    customTitle,
    firstPrompt: firstUserText,
  };
}

// Discovery read-only delle sessioni del SOLO progetto corrente (D2 preflight
// T27): legge la project dir calcolata dal forward-transform, filtra per cwd
// (difesa contro le collisioni lossy del naming), ordina per ts desc.
export function discoverProjectSessions(projectRoot: string): Session[] {
  const dir = join(claudeProjectsRoot(), projectDirName(projectRoot));
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const out: Session[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(dir, f);
    seen.add(path);
    let mtime: number;
    let sizeBytes: number;
    try {
      const st = statSync(path);
      mtime = st.mtimeMs;
      sizeBytes = st.size;
    } catch {
      continue;
    }
    const cached = cache.get(path);
    let session: Session | null;
    if (cached && cached.mtime === mtime) {
      session = cached.session;
    } else {
      session = parseSessionFile(path, mtime, sizeBytes);
      cache.set(path, { mtime, session });
    }
    if (session && (session.cwd === projectRoot || session.cwd.startsWith(projectRoot + '/'))) {
      out.push(session);
    }
  }
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// Raggruppa per gitBranch (D2: group-by-branch nel progetto corrente). Ordine
// dei gruppi = sessione più recente nel gruppo (desc); dentro il gruppo resta
// l'ordine ts desc ereditato dall'input.
export function groupByBranch(sessions: Session[]): SessionGroup[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const branch = s.gitBranch || '(no branch)';
    const arr = map.get(branch);
    if (arr) arr.push(s);
    else map.set(branch, [s]);
  }
  return [...map.entries()]
    .map(([branch, arr]) => ({ branch, sessions: arr }))
    .sort((a, b) => b.sessions[0].ts - a.sessions[0].ts);
}
