import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sanitize } from './width.js';

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

/** T52 — natura del corpo di un messaggio, dominio dei filtri di ricerca.
 *  Tre valori e non quattro: il `thinking` NON è persistito (vedi §Blocchi). */
export type BodyKind = 'ai' | 'tool' | 'human';

/** T52 — corpo cercabile di un messaggio, unità dell'indice full-text. */
export interface MessageBody {
  /** Posizione del record nel transcript (0-based, sui soli record JSON validi).
   *  Prefissa la riga-occorrenza: orienta dentro conversazioni da centinaia di
   *  record senza rubare colonne all'estratto. */
  idx: number;
  kind: BodyKind;
  /** Testo RAW, newline incluse. Non passa da `cleanPreview`: il reader deve
   *  poter mostrare il messaggio com'è, e collassare qui gli spazi sposterebbe
   *  gli offset dei match rispetto al testo mostrato. */
  text: string;
}

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
  /** Ultima risposta del modello, già ripulita, last-wins (preview nel detail
   *  pane accanto al primo prompt: "da dove parte, dove è arrivata"). */
  lastReply: string;
  /** T110 — id VERSIONATO del modello (`claude-opus-5`), come sta sul
   *  transcript; '' se la conversazione non ha ancora un record assistant.
   *
   *  Non normalizzato qui: la lista ne mostra la famiglia in 3 caratteri, il
   *  blocco preview l'id per intero, e solo il secondo distingue una
   *  generazione dall'altra — normalizzare al parse la butterebbe via senza
   *  modo di recuperarla a valle. La tabella famiglia → short sta in
   *  `glyphs.ts`, col resto delle costanti di resa.
   *
   *  Last-wins come `customTitle` e `lastReply`: un `/model` a metà
   *  conversazione è documentato, quindi il modello di una sessione è una
   *  storia e non un campo — e la domanda che si fa guardando la lista è «con
   *  cosa sta girando adesso». */
  model: string;
  /** T52 — corpi cercabili, TRATTENUTI dal parse invece di essere buttati.
   *
   *  Vivono dentro la Session, quindi dentro la cache mtime-keyed già esistente:
   *  una sola struttura, una sola invalidazione. Una seconda cache parallela
   *  divergerebbe dalla prima al primo file riscritto.
   *
   *  Il costo è memoria, non I/O: il parse di ogni riga avviene comunque per
   *  turni/primo-prompt/ultima-risposta — finora i corpi venivano estratti e
   *  scartati. Misurato su questo progetto: 57 MB di JSONL su disco → 10,4 MB
   *  di testo effettivo (il resto è overhead JSON: uuid, timestamp, wrapper). */
  bodies: MessageBody[];
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

// Estrae il primo blocco di testo dal `message` di un record. Funziona sia sui
// record `type:user` sia sugli `type:assistant`: entrambi portano `content` come
// stringa o array di blocchi, e un blocco di testo è `{type:'text', text}`. Il
// nome è generico apposta — l'ultima risposta del modello (T49 first+last) esce
// dallo stesso estrattore del primo prompt utente.
function extractText(message: unknown): string {
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

// Un record `type:user` che porta SOLO questo testo è un evento di UI (l'utente
// ha premuto esc), non un messaggio scritto. Stesso `type` di un prompt vero:
// senza escluderlo comparirebbe come «primo prompt» della conversazione e
// gonfierebbe la ricerca sui messaggi umani. Prefisso e non uguaglianza —
// esistono varianti («…by user for tool use»).
const INTERRUPT_MARKER = '[Request interrupted by user';

function isInterrupt(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT_MARKER);
}

// T110 — valore che il CLI scrive nel campo modello dei record che fabbrica da
// sé (osservato su `{"type":"text","text":"No response requested."}`). Restano
// `type:assistant` a tutti gli effetti: chi si fida del campo etichetta la
// conversazione con un modello che non esiste. Terza istanza dello stesso
// pattern dei `tool_result` fra i turni e dell'interruzione fra i prompt — un
// record col tipo giusto che non è la cosa che quel tipo promette.
const SYNTHETIC_MODEL = '<synthetic>';

// Id del modello di UN record assistant, '' se assente o sintetico.
function extractModel(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const model = (message as { model?: unknown }).model;
  if (typeof model !== 'string' || !model || model === SYNTHETIC_MODEL) return '';
  return model;
}

// T52 — estrae i corpi cercabili di UN record, uno per `kind` presente.
//
// Blocchi dello stesso kind nello stesso record vengono CONCATENATI, non emessi
// separatamente: il reader promette «il messaggio intero», e la coppia
// (idx, kind) resta così una chiave univoca per la riga-occorrenza.
//
// Mappatura dei blocchi, verificata sullo store:
//  - assistant `text`            → ai
//  - assistant `tool_use`        → tool  (nome + input serializzato: il comando
//                                  eseguito è ciò che si cerca, non il wrapper)
//  - assistant `thinking`        → SCARTATO: il campo `thinking` è SEMPRE ''
//                                  (persistita solo la `signature`, la firma
//                                  crittografica). Indicizzarlo produrrebbe una
//                                  categoria che non può mai dare un risultato.
//  - user stringa nuda / `text`  → human
//  - user `tool_result`          → tool  (viaggia come type:user, ma non è
//                                  scritto da un umano)
//
// `isAssistant` arriva dal `type` del RECORD, non da `message.role`: è il campo
// su cui il resto del parser già dispatcha (i due combaciano sullo store attuale
// — verificato — ma dipendere da uno solo evita che divergano in silenzio).
function collectBodies(
  message: unknown,
  idx: number,
  isAssistant: boolean,
  out: MessageBody[],
): void {
  if (!message || typeof message !== 'object') return;
  const content = (message as { content?: unknown }).content;

  const parts: Record<BodyKind, string[]> = { ai: [], tool: [], human: [] };

  if (typeof content === 'string') {
    if (content) parts[isAssistant ? 'ai' : 'human'].push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        parts[isAssistant ? 'ai' : 'human'].push(b.text);
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        let input = '';
        try {
          input = JSON.stringify(b.input ?? {});
        } catch {
          input = ''; // input ciclico/non serializzabile → resta il solo nome
        }
        parts.tool.push(`${name} ${input}`);
      } else if (b.type === 'tool_result') {
        const r = b.content;
        if (typeof r === 'string') {
          if (r) parts.tool.push(r);
        } else if (Array.isArray(r)) {
          for (const rb of r) {
            if (rb && typeof rb === 'object' && (rb as { type?: unknown }).type === 'text') {
              const t = (rb as { text?: unknown }).text;
              if (typeof t === 'string' && t) parts.tool.push(t);
            }
          }
        }
      }
    }
  }

  for (const kind of ['ai', 'tool', 'human'] as const) {
    // Sanificato QUI, prima che la ricerca ci giri sopra: gli offset del match
    // (`matchStart`/`matchEnd`) indicizzano questo testo, e sanificare a valle —
    // al render — li sposterebbe, evidenziando la parte sbagliata della riga.
    // Un corpo di transcript è la sorgente più ostile che il deck legge: emoji
    // qualsiasi, output di tool con byte di controllo, CJK.
    const text = sanitize(parts[kind].join('\n'));
    if (!text) continue;
    if (kind === 'human' && isInterrupt(text)) continue;
    out.push({ idx, kind, text });
  }
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
  return parseTranscript(content, path, mtime, sizeBytes);
}

/**
 * Semantica del transcript, separata dalla lettura del file.
 *
 * L'I/O resta in `parseSessionFile` (l'invariante «unico modulo che tocca lo
 * store» vale per QUESTO file, non per la funzione): qui c'è solo la parte non
 * ovvia — cosa conta come turno, cosa è un corpo cercabile, quali record sono
 * eventi di UI travestiti da messaggi. È anche l'unica parte che vale la pena
 * testare, e su una stringa si testa senza inventare un finto `~/.claude`.
 */
export function parseTranscript(
  content: string,
  path: string,
  mtime: number,
  sizeBytes: number,
): Session | null {
  let sessionId = basename(path).replace(/\.jsonl$/, '');
  let cwd = '';
  let gitBranch = '';
  let parentUuid: string | null = null;
  let customTitle = '';
  let firstUserText = '';
  let lastAssistantText = '';
  let model = '';
  let turns = 0;
  const bodies: MessageBody[] = [];
  let recordIdx = -1;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // Indice progressivo sui soli record VALIDI: è ciò che prefissa la
    // riga-occorrenza, quindi deve contare come li conta chi legge il file.
    recordIdx++;
    if (d.type === 'user' || d.type === 'assistant') {
      collectBodies(d.message, recordIdx, d.type === 'assistant', bodies);
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
      // type:user ma senza blocchi text → extractText '' li esclude.
      // T52: e nemmeno l'interruzione da esc è un prompt — stesso `type`, ma è
      // un evento di UI. Senza il filtro gonfia i turni e può diventare il
      // «primo prompt» mostrato nel detail pane.
      const t = extractText(d.message);
      if (t && !isInterrupt(t)) {
        turns++;
        if (!firstUserText) firstUserText = t;
      }
    } else if (d.type === 'assistant') {
      // Ultima risposta del modello: last-wins (come customTitle), niente
      // early-stop — l'ultima riga assistant con testo è quella buona. I
      // record assistant di solo tool_use danno '' e non sovrascrivono.
      const t = extractText(d.message);
      if (t) lastAssistantText = t;
      // T110 — stesso regime last-wins, ma su un asse suo: un record di solo
      // tool_use porta comunque il modello, e va contato. Nessun costo di I/O:
      // la riga è già parsata per turni, primo prompt e ultima risposta.
      const m = extractModel(d.message);
      if (m) model = m;
    }
  }

  if (!cwd) return null; // nessuna riga con cwd → non è una sessione di progetto valida

  return {
    sessionId,
    cwd,
    gitBranch,
    parentUuid,
    title: sanitize(customTitle || firstUserText || '(senza titolo)'),
    ts: mtime,
    path,
    sizeBytes,
    turns,
    customTitle,
    // Sanificati come il titolo, e per lo stesso motivo: le due preview del
    // detail pane sono testo di transcript messo NEL FRAME. Erano l'ultimo
    // varco rimasto — un `✅` (BMP largo 2) nell'estratto prende una cella
    // sola nella griglia di Ink e due colonne sul terminale, quindi la riga
    // scivola a destra e si mangia il bordo del pane. Qui il confine è lo
    // stesso di `title`, non il render: `wrapLines` conta le colonne su questo
    // testo, sanificare a valle sposterebbe l'a-capo già calcolato.
    firstPrompt: sanitize(firstUserText),
    lastReply: sanitize(lastAssistantText),
    model,
    bodies,
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
