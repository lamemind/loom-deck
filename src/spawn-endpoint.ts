// T196 — l'ENDPOINT del deck: l'indirizzo locale su cui un deck acceso ascolta
// le richieste di spawn, e il protocollo che ci viaggia sopra.
//
// Lo usano i due lati della connessione, il server dentro il deck
// (`endpoint-server.ts`) e il client `loom-deck-spawn` (`spawn-client.ts`), ed è
// il motivo per cui sta in un modulo a sé: l'indirizzo è una funzione sola,
// calcolata uguale dai due lati. Due copie della regola darebbero due nomi
// diversi al primo ritocco, e il client chiamerebbe un indirizzo dove nessuno
// ascolta — senza un errore che dica perché.
//
// Modulo senza I/O di rete. Legge il disco solo per l'`id` del progetto e per il
// path reale della root.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { configFilePath } from './config.js';
import { comparablePath, projectBaseName } from './project-path.js';
import { isModelKind, type ModelKind, type PromptKind } from './spawn-catalog.js';
import { PROMPT_KINDS } from './tab-args.js';

/** La versione minima del deck che ascolta: la nomina il client quando non
 *  trova nessuno, perché un deck più vecchio è acceso ma non ha l'endpoint. */
export const ENDPOINT_SINCE = '0.87.0';

/** Lunghezza massima della parte `id` del nome. Su Linux il path di un socket
 *  sta in circa 107 byte: `/run/user/<uid>/loom-deck/` più un id libero li
 *  supererebbe, e `listen` fallirebbe con un errore che non nomina la causa. */
const ID_MAX = 40;

/** Il nome dell'endpoint senza la parte di piattaforma:
 *  `loom-deck-<id>-<8 caratteri di hash del path reale della root>`.
 *
 *  L'`id` da solo non basta (P1 preflight): `.claude/loom-works.json` è
 *  committato, quindi il worktree di una lane porta lo stesso `id` del progetto
 *  principale. Con l'indirizzo dal solo `id` il deck del worktree troverebbe il
 *  nome occupato, e una conversazione del worktree farebbe aprire la tab al deck
 *  principale, nella sua cartella. L'`id` resta nel nome per chi lo legge in un
 *  `ls` o in un messaggio d'errore; a distinguere è l'hash.
 *
 *  Il path è quello REALE (symlink risolti) e nella forma di confronto della
 *  piattaforma (`comparablePath`): su Windows `c:\…` e `C:\…` sono la stessa
 *  cartella, e un deck avviato da Windows Terminal e un client lanciato da VS
 *  Code devono arrivare allo stesso nome. */
export function endpointName(root: string, platform: NodeJS.Platform = process.platform): string {
  const path = comparablePath(realRoot(root), platform);
  // Senza `id` nel file, il nome della cartella preso dalla stessa forma di
  // confronto dell'hash: su Windows minuscolo, o due grafie della stessa
  // cartella darebbero due nomi.
  const id = sanitizeId(projectId(root) ?? projectBaseName(path, platform));
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `loom-deck-${id}-${hash}`;
}

/** L'`id` dichiarato dal file di progetto, o `null` senza file o senza campo. */
function projectId(root: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(root), 'utf8')) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id.trim() ? raw.id : null;
  } catch {
    return null;
  }
}

/** Solo caratteri che un nome di pipe e un nome di file accettano su ogni
 *  piattaforma; il resto diventa `_`. */
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, ID_MAX) || 'progetto';
}

function realRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

/**
 * La cartella dei socket su Linux: `$XDG_RUNTIME_DIR/loom-deck`.
 *
 * `$XDG_RUNTIME_DIR` è la cartella runtime dell'utente — 0700, sua, svuotata al
 * logout —, quindi un socket orfano di una sessione precedente non sopravvive al
 * riavvio e nessun altro utente arriva al file. Senza (una sessione senza
 * systemd-logind), una cartella per utente nella temporanea: lì la cartella può
 * esistere già, creata da altri, e chi ascolta ne verifica proprietario e
 * permessi prima di usarla (`endpoint-server.ts`).
 *
 * I path del socket si compongono con `posix.join`, non col `join` della
 * piattaforma che esegue: il socket esiste solo fuori da Windows, e
 * `endpointFor(root, 'linux')` chiamato su Windows deve dare lo stesso path che
 * darebbe su Linux, non uno coi separatori di Windows.
 */
export function socketDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime) return posix.join(runtime, 'loom-deck');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return posix.join(tmpdir(), `loom-deck-${uid}`);
}

export interface Endpoint {
  name: string;
  /** Ciò che `net.createServer().listen()` e `net.connect()` ricevono. */
  address: string;
  /** La cartella del file del socket; `null` su Windows, dove una named pipe
   *  non è un file. */
  dir: string | null;
}

/** L'endpoint del progetto con root `root`: named pipe su Windows, socket Unix
 *  altrove. Un deck per progetto, un indirizzo per progetto. */
export function endpointFor(
  root: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Endpoint {
  const name = endpointName(root, platform);
  if (platform === 'win32') return { name, address: `\\\\.\\pipe\\${name}`, dir: null };
  const dir = socketDir(env);
  return { name, address: posix.join(dir, `${name}.sock`), dir };
}

// ── Protocollo ─────────────────────────────────────────────────────────────
//
// Una connessione per richiesta (P2 preflight): una riga JSON di richiesta, una
// riga JSON di risposta sulla stessa connessione, poi il server chiude. `verb`
// c'è anche se oggi il verbo è uno solo, perché un verbo futuro non cambi la
// forma della riga.

export interface SpawnRequest {
  verb: 'spawn';
  task: string;
  kind: PromptKind;
  /** I DLV del perimetro, solo con `kind: 'run'`. Assente = tutti gli aperti. */
  scope?: number[];
  /** Assente = il modello che il deck userebbe col tasto (catalogo ← override
   *  di progetto). */
  model?: ModelKind;
  /** La nota del titolo. Assente = il template di titolo dell'azione. */
  note?: string;
}

export type SpawnReply =
  | {
      ok: true;
      sessionId: string;
      task: string;
      kind: PromptKind;
      model: ModelKind;
      /** Il prompt iniziale come parte, vuoto se l'azione non ne ha. */
      prompt: string;
      /** Titolo della tab e comando che gira nella tab, come li annuncia
       *  `deck-run`; `null` in uno spawn inerte (`LOOM_DECK_NO_SPAWN`). */
      title: string | null;
      inTab: string | null;
      /** Lo spawn non è avvenuto davvero: freno dei test acceso sul deck. */
      inert?: true;
    }
  | { ok: false; reason: string };

/** Le righe più lunghe di così non sono una richiesta: il server chiude invece
 *  di accumulare. */
export const REQUEST_MAX_BYTES = 16 * 1024;

const TASK_RE = /^T\d+$/;
const NOTE_MAX = 200;

/** Una richiesta letta dalla riga, validata nella FORMA. Che la task esista e
 *  che i DLV siano aperti lo verifica il deck, che ha il disco del progetto. */
export function parseSpawnRequest(line: string): SpawnRequest | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'richiesta non è JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'richiesta non è un oggetto JSON' };
  const r = raw as Record<string, unknown>;
  if (r.verb !== 'spawn') return { error: `verbo ignoto: ${JSON.stringify(r.verb)} (solo spawn)` };
  if (typeof r.task !== 'string' || !TASK_RE.test(r.task)) {
    return { error: `task non valida: ${JSON.stringify(r.task)} (forma T<numero>)` };
  }
  if (typeof r.kind !== 'string' || !(PROMPT_KINDS as readonly string[]).includes(r.kind)) {
    return { error: `kind ignoto: ${JSON.stringify(r.kind)} (usa ${PROMPT_KINDS.join('|')})` };
  }
  const req: SpawnRequest = { verb: 'spawn', task: r.task, kind: r.kind as PromptKind };
  if (r.scope !== undefined) {
    if (req.kind !== 'run') return { error: 'perimetro ammesso solo con kind run' };
    if (
      !Array.isArray(r.scope) ||
      r.scope.length === 0 ||
      !r.scope.every((n) => Number.isInteger(n) && (n as number) >= 1)
    ) {
      return { error: 'perimetro non valido: lista non vuota di numeri di DLV ≥ 1' };
    }
    req.scope = [...new Set(r.scope as number[])].sort((a, b) => a - b);
  }
  if (r.model !== undefined) {
    if (!isModelKind(r.model)) return { error: `modello ignoto: ${JSON.stringify(r.model)}` };
    req.model = r.model;
  }
  if (r.note !== undefined) {
    if (typeof r.note !== 'string' || r.note.length > NOTE_MAX || /[\r\n]/.test(r.note)) {
      return { error: `nota non valida: una riga di al più ${NOTE_MAX} caratteri` };
    }
    req.note = r.note;
  }
  return req;
}

/** Tetto dei numeri di DLV in un perimetro: oltre è un errore di battitura, e
 *  un range `1-100000` non deve diventare una lista di centomila numeri. */
const SCOPE_MAX = 999;

/**
 * Il perimetro scritto da chi chiama, nella grammatica di `run-task`: lista
 * `1,2,6`, range `3-8`, combinabili `1,3-5,9`. Un `DLV` in testa si accetta,
 * perché è la forma con cui il deck stesso lo scrive nel prompt.
 */
export function parseScope(spec: string): number[] | { error: string } {
  const body = spec.trim().replace(/^DLV\s*/i, '');
  if (!body) return { error: 'perimetro vuoto' };
  const out = new Set<number>();
  for (const part of body.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) return { error: `perimetro malformato: '${part.trim()}' (usa 1,3-5)` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b > SCOPE_MAX) return { error: `range non valido: '${part.trim()}'` };
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}
