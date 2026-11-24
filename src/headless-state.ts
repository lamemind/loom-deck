// T205 — lo STATO di un turno headless su disco, e il suo ESITO.
//
// Un turno headless è un processo `claude -p` staccato: chi lo lancia torna
// subito (P2 preflight) e non resta nessun padre ad aspettarne la fine. L'esito
// lo scrive quindi il processo stesso, nel file su cui il lanciatore gli ha
// rediretto lo stdout (`--output-format json`: un solo oggetto, l'evento
// `result`, scritto a turno finito). Accanto, il file di stato che il
// lanciatore scrive appena il processo è partito: chi, quando, con che pid.
//
// Sede: `<root>/.claude/loom/headless/`, accanto al sidecar
// `session-tasks.jsonl` e come lui fuori da git. Tre file per conversazione,
// riscritti a ogni turno — la storia dei turni sta nel transcript. T206 — li
// toglie l'`open` successivo quando il turno è finito da più di sette giorni o
// il transcript non c'è più (`pruneHeadless`), e `CANC` nel deck insieme al
// transcript:
//   <sessionId>.json      lo stato del turno (`HeadlessState`)
//   <sessionId>.out.json  lo stdout di claude: l'evento `result`
//   <sessionId>.err       lo stderr di claude
//
// L'esito ha tre classi meccaniche più «in corso» (P3 preflight): se un turno
// chiuso sia una domanda o una fine lo giudica chi legge il testo finale, non
// un pattern su `D{N}` o 🚦 che sbaglierebbe in silenzio alla prima skill che
// cambia forma.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelKind } from './spawn-catalog.js';

export function headlessDir(root: string): string {
  return join(root, '.claude', 'loom', 'headless');
}

export function statePath(root: string, sessionId: string): string {
  return join(headlessDir(root), `${sessionId}.json`);
}

export function outPath(root: string, sessionId: string): string {
  return join(headlessDir(root), `${sessionId}.out.json`);
}

export function errPath(root: string, sessionId: string): string {
  return join(headlessDir(root), `${sessionId}.err`);
}

/** T206 — i tre file di una conversazione headless, nell'ordine di nascita. */
export function headlessFiles(root: string, sessionId: string): string[] {
  return [statePath(root, sessionId), outPath(root, sessionId), errPath(root, sessionId)];
}

/**
 * T206 — l'ultimo momento in cui uno dei tre file è stato scritto, in ms; `0`
 * se non ce n'è nessuno. Lo stato nasce al lancio, l'esito e lo stderr li
 * scrive il processo fino all'uscita: su un turno finito è l'ora della fine.
 */
export function headlessTouchedMs(root: string, sessionId: string): number {
  let last = 0;
  for (const path of headlessFiles(root, sessionId)) {
    try {
      last = Math.max(last, statSync(path).mtimeMs);
    } catch {
      // file assente: il turno non l'ha (ancora) scritto
    }
  }
  return last;
}

/** T206 — toglie i tre file di una conversazione headless; quanti c'erano. */
export function dropHeadlessState(root: string, sessionId: string): number {
  let removed = 0;
  for (const path of headlessFiles(root, sessionId)) {
    try {
      statSync(path);
    } catch {
      continue;
    }
    rmSync(path, { force: true });
    removed++;
  }
  return removed;
}

/** Lo stato dell'ultimo turno di una conversazione headless. */
export interface HeadlessState {
  sessionId: string;
  /** La task del binding, `null` per una conversazione senza task. */
  task: string | null;
  /** L'azione di catalogo che ha aperto la conversazione (`preflight`, `run`,
   *  …); `reply` per una conversazione nata altrove e ripresa qui. */
  kind: string;
  model: ModelKind;
  /** Il nome della conversazione (`--name`), lo stesso di una tab. */
  title: string;
  permissionMode: string;
  /** 1 all'apertura, +1 a ogni risposta. */
  turn: number;
  /** ISO 8601. */
  startedAt: string;
  /** `null` se il processo non è partito (`launchError`). */
  pid: number | null;
  /** L'ora di avvio del processo da `/proc/<pid>/stat` (campo 22), la guardia
   *  contro il pid riciclato; `''` dove `/proc` non c'è. */
  procStart: string;
  /** Il testo del turno: il prompt dell'azione, o la risposta. Tagliato. */
  prompt: string;
  /** Il processo non è partito: il motivo. */
  launchError?: string;
  /** T220 — l'orchestrator di QUESTO turno, come `LOOM_ORCHESTRATOR`: dichiarato
   *  dall'`open` o dal `reply` che lo ha avviato. Assente se nessuno. */
  orchestrator?: string;
}

/** Quanto testo del turno entra nello stato: lo legge un umano, non una
 *  macchina, e una risposta lunga sta già intera nel transcript. */
export const STATE_PROMPT_MAX = 500;

/** Scrittura atomica (file temporaneo e `rename`): chi legge lo stato mentre il
 *  lanciatore lo scrive non vede mai un JSON a metà. */
export function writeState(root: string, st: HeadlessState): void {
  mkdirSync(headlessDir(root), { recursive: true });
  const path = statePath(root, st.sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readState(root: string, sessionId: string): HeadlessState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(root, sessionId), 'utf8')) as HeadlessState;
    return raw && typeof raw === 'object' && raw.sessionId === sessionId ? raw : null;
  } catch {
    return null;
  }
}

/** Gli id delle conversazioni con uno stato headless, che cominciano con
 *  `prefix`. */
export function headlessIds(root: string, prefix = ''): string[] {
  let files: string[];
  try {
    files = readdirSync(headlessDir(root));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.out.json') && f.startsWith(prefix))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Un file letto per intero, `''` se non c'è. */
export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Una chiamata a uno strumento negata in assenza di chi approvi. */
export interface Denial {
  tool: string;
  /** L'input dello strumento, in una riga: per Bash il comando. */
  input: string;
}

/** L'evento `result` di un turno, nei campi che servono a chi l'ha lanciato. */
export interface TurnResult {
  isError: boolean;
  subtype: string;
  /** Il testo finale del turno. */
  text: string;
  denials: Denial[];
  durationMs: number | null;
  sessionId: string;
}

/**
 * Il risultato del turno dall'output del processo, o `null` se il processo non
 * l'ha (ancora) scritto.
 *
 * Due forme, una sola lettura: l'oggetto unico di `--output-format json` (la
 * forma che il lanciatore chiede) e le righe di `stream-json`, dove vale
 * l'ULTIMO evento `result`. La seconda c'è perché è la forma del deck
 * (`spawnSkill`), e un output scritto a mano per una prova non deve leggersi
 * come «nessun esito».
 */
export function parseTurnOutput(text: string): TurnResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const whole = tryJson(trimmed);
  if (isResult(whole)) return toResult(whole);
  let last: Record<string, unknown> | null = null;
  for (const line of trimmed.split('\n')) {
    const obj = tryJson(line.trim());
    if (isResult(obj)) last = obj;
  }
  return last ? toResult(last) : null;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isResult(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: unknown }).type === 'result';
}

function toResult(r: Record<string, unknown>): TurnResult {
  const denials: Denial[] = [];
  if (Array.isArray(r.permission_denials)) {
    for (const d of r.permission_denials as unknown[]) {
      if (!d || typeof d !== 'object') continue;
      const o = d as { tool_name?: unknown; tool_input?: unknown };
      denials.push({ tool: typeof o.tool_name === 'string' ? o.tool_name : '?', input: describeInput(o.tool_input) });
    }
  }
  return {
    isError: r.is_error === true,
    subtype: typeof r.subtype === 'string' ? r.subtype : '',
    text: typeof r.result === 'string' ? r.result : '',
    denials,
    durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : null,
    sessionId: typeof r.session_id === 'string' ? r.session_id : '',
  };
}

/** L'input di uno strumento in una riga: il comando di Bash, il path di un
 *  file, altrimenti il JSON. */
function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    if (typeof o[key] === 'string') return oneLine(o[key] as string);
  }
  return oneLine(JSON.stringify(o));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Le quattro classi dell'esito. */
export type OutcomeClass = 'in corso' | 'turno chiuso' | 'permesso negato' | 'errore';

export interface Outcome {
  cls: OutcomeClass;
  /** Il risultato del turno, quando il processo l'ha scritto. */
  result: TurnResult | null;
  /** Perché `errore` quando il risultato non lo dice da sé: il processo non è
   *  partito, o è finito senza scrivere un esito. */
  reason: string;
}

/**
 * L'esito del turno, dagli ingressi già letti.
 *
 * L'ordine conta. Un risultato scritto vince sulla liveness: il processo scrive
 * l'esito e poi esce, e nei millisecondi in mezzo è vivo con l'esito già su
 * disco. `is_error` vince sui permessi negati: un turno fallito per un errore
 * dell'API non diventa un turno da riprendere in una tab per approvare. Un
 * processo finito SENZA risultato è un errore — ucciso, crashato, o un CLI che
 * ha rifiutato gli argomenti — e lo stderr ne dice il perché.
 */
export function classifyTurn(
  st: HeadlessState,
  result: TurnResult | null,
  running: boolean,
  stderr: string,
): Outcome {
  if (st.launchError) return { cls: 'errore', result: null, reason: st.launchError };
  if (result) {
    if (result.isError) return { cls: 'errore', result, reason: result.subtype };
    if (result.denials.length) return { cls: 'permesso negato', result, reason: '' };
    return { cls: 'turno chiuso', result, reason: '' };
  }
  if (running) return { cls: 'in corso', result: null, reason: '' };
  const tail = stderr.trim().split('\n').slice(-5).join('\n');
  return {
    cls: 'errore',
    result: null,
    reason: `processo finito senza esito${tail ? `; stderr:\n${tail}` : ' (stderr vuoto: ucciso?)'}`,
  };
}
