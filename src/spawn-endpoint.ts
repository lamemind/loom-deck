// T196 — l'ENDPOINT del deck: l'indirizzo locale su cui un deck acceso ascolta
// le richieste delle conversazioni (spawn, e da T204 close), e il protocollo che
// ci viaggia sopra.
//
// Lo usano i due lati della connessione, il server dentro il deck
// (`endpoint-server.ts`) e i client `loom-deck-spawn` e `loom-deck-close`, ed è
// il motivo per cui sta in un modulo a sé: l'indirizzo è una funzione sola,
// calcolata uguale dai due lati. Due copie della regola darebbero due nomi
// diversi al primo ritocco, e il client chiamerebbe un indirizzo dove nessuno
// ascolta — senza un errore che dica perché.
//
// Modulo senza I/O di rete. Legge il disco solo per l'`id` del progetto e per il
// path reale della root.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { loadProjectId } from './config.js';
import { comparablePath, projectBaseName } from './project-path.js';
import { isModelKind, type ModelKind, type PromptKind } from './spawn-catalog.js';
import { PROMPT_KINDS } from './tab-args.js';

/** La versione minima del deck che ascolta: la nomina il client quando non
 *  trova nessuno, perché un deck più vecchio è acceso ma non ha l'endpoint. */
export const ENDPOINT_SINCE = '0.87.0';

/** Lunghezza massima della parte `id` del nome: su Linux il path di un socket
 *  sta in `SOCKET_PATH_MAX` byte, e `/run/user/<uid>/loom-deck/` più un id
 *  libero li supererebbe. */
const ID_MAX = 40;

/**
 * T204 — il path più lungo che un socket Unix accetta su Linux: `sun_path` è di
 * 108 byte, NUL compreso.
 *
 * Oltre, libuv non fallisce: TRONCA il path in silenzio, sia in `listen` sia in
 * `connect` (misurato, Node 22 con libuv 1.52). Due progetti i cui indirizzi
 * condividono i primi 107 byte finiscono così sullo stesso file troncato: il
 * primo deck ci ascolta, il secondo lo trova occupato, e un client del secondo
 * progetto parla col deck del primo, che apre la tab nella propria cartella. Il
 * caso nasce da una cartella runtime lunga (`$XDG_RUNTIME_DIR`, o la temporanea
 * di ripiego), mai da `/run/user/<uid>`: `addressProblem` lo trasforma in un
 * errore che nomina la causa, da entrambi i lati.
 */
export const SOCKET_PATH_MAX = 107;

/** Il nome dell'endpoint senza la parte di piattaforma:
 *  `loom-deck-<id>-<8 caratteri di hash del path reale della root>`.
 *
 *  L'`id` da solo non basta (P1 preflight): `.claude/loom-works.json` è
 *  committato, quindi un secondo worktree git dello stesso repo porta lo stesso
 *  `id` del progetto principale. Con l'indirizzo dal solo `id` il deck del worktree troverebbe il
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
  const id = sanitizeId(loadProjectId(root) ?? projectBaseName(path, platform));
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `loom-deck-${id}-${hash}`;
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

/** Il motivo per cui l'indirizzo non è usabile, o `null`. Una named pipe non ha
 *  il limite; un socket oltre `SOCKET_PATH_MAX` byte sì. */
export function addressProblem(ep: Endpoint): string | null {
  if (ep.dir === null) return null;
  const bytes = Buffer.byteLength(ep.address);
  if (bytes <= SOCKET_PATH_MAX) return null;
  return `path del socket di ${bytes} byte, oltre i ${SOCKET_PATH_MAX} byte di un socket Unix: cartella runtime troppo lunga (${ep.dir})`;
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
// sceglie il verbo, e un verbo nuovo entra senza cambiare la forma della riga:
// `spawn` (T196) apre una conversazione, `close` (T204) ne chiude una.

export interface SpawnRequest {
  verb: 'spawn';
  task: string;
  kind: PromptKind;
  /** I DLV del perimetro eseguibile, solo con `kind: 'run'`. Assente = tutti gli aperti. */
  scope?: number[];
  /** Assente = il modello che il deck userebbe col tasto (catalogo ← override
   *  di progetto). */
  model?: ModelKind;
  /** La nota del titolo. Assente = il template di titolo dell'azione. */
  note?: string;
  /** T220 — l'id del perimetro orchestrabile dell'orchestrator che chiede lo spawn (`T197`): diventa
   *  `LOOM_ORCHESTRATOR` nella conversazione e il campo `orchestrator` del sidecar. Il deck
   *  lo rifiuta se non è un'epica né una lista custom. */
  orchestrator?: string;
  /** T220 — il `sessionId` dell'orchestrator che chiede, letto dal client nel
   *  proprio ambiente (`CLAUDE_CODE_SESSION_ID`): solo provenienza, nel campo
   *  `orchestratorSession` del sidecar. Assente se il client non lo trova. */
  orchestratorSession?: string;
  /** T221 — il `sessionId` intero della conversazione che chiede, solo col
   *  kind `orchestrator`: è l'orchestrator che passa le consegne all'orchestrator che si apre, e
   *  il deck le scrive la marca `origin: orchestrator` allo spawn vero. Il client lo
   *  legge dal proprio ambiente, come `orchestratorSession`: una conversazione marca
   *  solo sé stessa. */
  from?: string;
}

/**
 * T203 — i due canali che aprono una conversazione da una RICHIESTA invece che
 * da un tasto del deck: l'endpoint (`loom-deck-spawn`, una tab) e il turno
 * headless (`loom-deck-headless open`, un `claude -p`). Condividono
 * `planSpawnRequest`, ma un kind può valere su uno e non sull'altro.
 */
export type RequestChannel = 'endpoint' | 'headless';

/**
 * I kind che un canale rifiuta, col motivo. Fonte UNICA di due cose: il rifiuto
 * di `planSpawnRequest` e l'elenco dei kind nell'uso dei due client
 * (`requestKinds`). Con due copie l'help prometterebbe un kind che il deck
 * rifiuta, o ne tacerebbe uno che accetta.
 *
 * L'orchestrator (P3 preflight T203) vale dal detail e da `deck-run` a mano. Sul
 * turno headless il rifiuto è permanente: un orchestrator vivi ore su un monitor, e
 * un turno `claude -p` finisce al primo turno. Sull'endpoint vale da T221, per
 * il passaggio di consegne: un orchestrator apre il successore, e la richiesta porta
 * il suo `sessionId` (`from`), che il deck marca chiudibile.
 */
export type ChannelRefusals = Readonly<Record<RequestChannel, Partial<Record<PromptKind, string>>>>;

export const CHANNEL_REFUSALS: ChannelRefusals = {
  endpoint: {},
  headless: { orchestrator: 'orchestrator: si apre dal detail del deck o con deck-run, non in un turno headless' },
};

/** Il motivo per cui il canale rifiuta il kind, o `null` se lo accetta. */
export function kindRefusal(
  kind: PromptKind,
  channel: RequestChannel,
  refusals: ChannelRefusals = CHANNEL_REFUSALS,
): string | null {
  return refusals[channel][kind] ?? null;
}

/** I kind che il canale accetta, nell'ordine di `PROMPT_KINDS`: l'elenco
 *  dell'uso dei client. */
export function requestKinds(channel: RequestChannel): readonly PromptKind[] {
  return PROMPT_KINDS.filter((k) => kindRefusal(k, channel) === null);
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
      /** T198 — la tab è aperta senza aver verificato che la finestra in focus
       *  fosse del progetto, e il perché: compass assente, più vecchio, o che
       *  non conosce il progetto. */
      warning?: string;
      /** T220 — l'orchestrator impostato come `LOOM_ORCHESTRATOR`, `null` se nessuno. Un
       *  deck che conosce l'orchestrator porta SEMPRE il campo: la sua assenza dice
       *  al client che il deck acceso è più vecchio, e l'orchestrator dichiarato si
       *  è persa senza errore (P4 preflight). */
      orchestrator?: string | null;
      /** T221 — l'orchestrator marcato `origin: orchestrator` allo spawn del successore
       *  (il `from` della richiesta); presente solo col kind `orchestrator`. */
      handoff?: string;
    }
  /** Rifiuto, o T229 richiesta in coda (`queued`). La coda viaggia sul ramo
   *  `ok: false` di proposito: un client più vecchio di T229 la legge come un
   *  rifiuto col suo motivo ed esce `1`, invece di stampare «tab aperta» per
   *  una tab che non c'è ancora. */
  | { ok: false; reason: string; queued?: QueuedSpawn };

/**
 * T229 — una richiesta di spawn messa in coda dal deck: la finestra in focus
 * non era del progetto, e la tab nasce quando una finestra del progetto torna
 * in focus. Porta già il `sessionId` della conversazione, che il deck sceglie
 * alla messa in coda e passa a `claude` con `--session-id` allo spawn vero.
 * Niente titolo: lo compone `deck-run` allo spawn, col segno della gemella se
 * un'altra conversazione viva ha lo stesso titolo in quel momento.
 */
export interface QueuedSpawn {
  sessionId: string;
  task: string;
  kind: PromptKind;
  model: ModelKind;
  prompt: string;
  /** L'orchestrator impostato come `LOOM_ORCHESTRATOR`, `null` se nessuno. */
  orchestrator: string | null;
  /** Quando la richiesta scade senza tab, ISO 8601 in UTC. */
  expiresAt: string;
}

/**
 * T204 — la chiusura di una conversazione viva del progetto.
 *
 * Il bersaglio è un `sessionId` e non una task (P1 preflight): una task può
 * avere insieme la conversazione abbandonata e quella in ciclo, e chiudere per
 * task le chiuderebbe entrambe.
 */
export interface CloseRequest {
  verb: 'close';
  /** Il `sessionId` intero, o un suo prefisso di almeno `SESSION_PREFIX_MIN`
   *  caratteri: il deck lo risolve fra le vive del progetto, e un prefisso che
   *  ne indica più d'una è un rifiuto. Minuscolo, come lo scrive Claude Code. */
  session: string;
  /** Il `sessionId` della conversazione che chiede (`$CLAUDE_CODE_SESSION_ID`
   *  nel client), quando c'è: il deck rifiuta di chiudere chi chiede (P2
   *  preflight). */
  from?: string;
}

export type CloseReply =
  | {
      ok: true;
      sessionId: string;
      pid: number;
      /** La task a cui il sidecar lega la conversazione, `null` se spot. */
      task: string | null;
      /** Come il deck l'ha terminata (`SIGHUP` su Linux). */
      how: string;
      /** Millisecondi dalla terminazione alla fine verificata del processo. */
      ms: number;
      /** Il processo è finito, ma un passo dopo non è riuscito (la marca
       *  `live` non ritirata): chi legge deve saperlo. */
      warning?: string;
    }
  /** Rifiuto, o processo non terminato entro l'attesa: in quel caso la risposta
   *  porta il bersaglio, perché la conversazione è stata toccata. */
  | { ok: false; reason: string; sessionId?: string; pid?: number };

export type EndpointRequest = SpawnRequest | CloseRequest;
export type EndpointReply = SpawnReply | CloseReply;

/** La versione minima del deck che conosce `close`: la nomina il client quando
 *  un deck più vecchio risponde «verbo ignoto». */
export const CLOSE_SINCE = '0.88.0';

/** Il prefisso più corto che si accetta: gli 8 caratteri con cui il deck,
 *  l'orchestrator e `sessions.py` del plugin mostrano un `sessionId`. */
export const SESSION_PREFIX_MIN = 8;

const SESSION_RE = /^[0-9a-f-]+$/;
const SESSION_MAX = 36;

/** Le righe più lunghe di così non sono una richiesta: il server chiude invece
 *  di accumulare. */
export const REQUEST_MAX_BYTES = 16 * 1024;

const TASK_RE = /^T\d+$/;
const NOTE_MAX = 200;

/** I verbi che il deck conosce, nell'ordine in cui li nomina un rifiuto. */
export const VERBS = ['spawn', 'close'] as const;

/** Una richiesta letta dalla riga, validata nella FORMA e smistata per verbo.
 *  Che la task esista, che la conversazione sia viva e del progetto lo verifica
 *  il deck, che ha il disco del progetto e il registro delle vive. */
export function parseEndpointRequest(line: string): EndpointRequest | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'richiesta non è JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'richiesta non è un oggetto JSON' };
  const r = raw as Record<string, unknown>;
  if (r.verb === 'spawn') return spawnFields(r);
  if (r.verb === 'close') return closeFields(r);
  return { error: `verbo ignoto: ${JSON.stringify(r.verb)} (usa ${VERBS.join('|')})` };
}

/** La sola richiesta di spawn: un altro verbo è un errore. */
export function parseSpawnRequest(line: string): SpawnRequest | { error: string } {
  const req = parseEndpointRequest(line);
  if ('error' in req || req.verb === 'spawn') return req;
  return { error: `verbo non di spawn: ${req.verb}` };
}

/** Un `sessionId` o un suo prefisso, nella forma che il deck accetta; `null`
 *  se non lo è. Minuscolo: il confronto col registro è esatto. */
export function normalizeSession(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s.length < SESSION_PREFIX_MIN || s.length > SESSION_MAX || !SESSION_RE.test(s)) return null;
  return s;
}

function closeFields(r: Record<string, unknown>): CloseRequest | { error: string } {
  const session = normalizeSession(r.session);
  if (session === null) {
    return {
      error: `sessione non valida: ${JSON.stringify(r.session)} (sessionId, o prefisso di almeno ${SESSION_PREFIX_MIN} caratteri esadecimali)`,
    };
  }
  const req: CloseRequest = { verb: 'close', session };
  if (r.from !== undefined) {
    const from = normalizeSession(r.from);
    if (from === null) return { error: `mittente non valido: ${JSON.stringify(r.from)}` };
    req.from = from;
  }
  return req;
}

function spawnFields(r: Record<string, unknown>): SpawnRequest | { error: string } {
  if (typeof r.task !== 'string' || !TASK_RE.test(r.task)) {
    return { error: `task non valida: ${JSON.stringify(r.task)} (forma T<numero>)` };
  }
  if (typeof r.kind !== 'string' || !(PROMPT_KINDS as readonly string[]).includes(r.kind)) {
    return { error: `kind ignoto: ${JSON.stringify(r.kind)} (usa ${PROMPT_KINDS.join('|')})` };
  }
  const req: SpawnRequest = { verb: 'spawn', task: r.task, kind: r.kind as PromptKind };
  if (r.scope !== undefined) {
    if (req.kind !== 'run') return { error: 'perimetro eseguibile ammesso solo con kind run' };
    if (
      !Array.isArray(r.scope) ||
      r.scope.length === 0 ||
      !r.scope.every((n) => Number.isInteger(n) && (n as number) >= 1)
    ) {
      return { error: 'perimetro eseguibile non valido: lista non vuota di numeri di DLV ≥ 1' };
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
  // T220 — l'orchestrator nella forma di un id di task; che sia un perimetro orchestrabile
  // del progetto lo verifica il deck (`orchestratorRefusal`). La sessione dell'orchestrator
  // senza l'orchestrator non vuol dire niente, e si rifiuta.
  if (r.orchestrator !== undefined) {
    if (typeof r.orchestrator !== 'string' || !TASK_RE.test(r.orchestrator)) {
      return { error: `orchestrator non valida: ${JSON.stringify(r.orchestrator)} (forma T<numero>)` };
    }
    req.orchestrator = r.orchestrator;
  }
  if (r.orchestratorSession !== undefined) {
    if (req.orchestrator === undefined) return { error: 'orchestratorSession senza orchestrator' };
    const sid = normalizeSession(r.orchestratorSession);
    if (sid === null || sid.length !== SESSION_MAX) {
      return { error: `sessione dell'orchestrator non valida: ${JSON.stringify(r.orchestratorSession)} (sessionId intero)` };
    }
    req.orchestratorSession = sid;
  }
  // T221 — chi passa le consegne: un sessionId intero, e solo con l'orchestrator.
  if (r.from !== undefined) {
    if (req.kind !== 'orchestrator') return { error: 'from ammesso solo con kind orchestrator' };
    const from = normalizeSession(r.from);
    if (from === null || from.length !== SESSION_MAX) {
      return { error: `mittente non valido: ${JSON.stringify(r.from)} (sessionId intero)` };
    }
    req.from = from;
  }
  return req;
}

/** Tetto dei numeri di DLV in un perimetro eseguibile: oltre è un errore di battitura, e
 *  un range `1-100000` non deve diventare una lista di centomila numeri. */
const SCOPE_MAX = 999;

/**
 * Il perimetro eseguibile scritto da chi chiama, nella grammatica di `run-task`: lista
 * `1,2,6`, range `3-8`, combinabili `1,3-5,9`. Un `DLV` in testa si accetta,
 * perché è la forma con cui il deck stesso lo scrive nel prompt.
 */
export function parseScope(spec: string): number[] | { error: string } {
  const body = spec.trim().replace(/^DLV\s*/i, '');
  if (!body) return { error: 'perimetro eseguibile vuoto' };
  const out = new Set<number>();
  for (const part of body.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) return { error: `perimetro eseguibile malformato: '${part.trim()}' (usa 1,3-5)` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b > SCOPE_MAX) return { error: `range non valido: '${part.trim()}'` };
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}
