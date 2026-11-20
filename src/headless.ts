// T205 — il TURNO HEADLESS: una conversazione su una task che si apre e si porta
// avanti senza nessuna tab. Ogni turno è un processo `claude -p` che finisce da
// solo; il turno dopo è un processo nuovo con `--resume` sullo stesso
// transcript. Nessuna tab vuol dire nessun focus spostato e nessuna tastiera
// portata via all'utente che scrive altrove.
//
// Il comando sta nel pacchetto del deck e non nel plugin (D1 preflight):
// catalogo delle azioni, modello, override di progetto, titolo e scrittura del
// sidecar restano una copia sola. Serve il deck installato, non acceso: niente
// endpoint, niente TUI.
//
// La conversazione è la stessa di una tab. Stessa terna di catalogo
// (`planSpawnRequest`, come l'endpoint), stesso titolo, permission mode,
// modello e `LOOM_TASK` (`composeTab`, come `deck-run`), stesso binding nel
// sidecar scritto PRIMA del processo (P7). Quello che cambia è chi la esegue —
// un `claude -p` staccato, in una sessione propria, con l'output su file (P2) —
// e l'ambiente, ripulito di ciò che la tab non avrebbe (`HEADLESS_DROP_ENV`).
//
// L'I/O verso l'esterno (lancio, liveness, registro dei vivi) passa da
// `HeadlessIo`, così il test esegue apertura e risposta su un progetto finto
// con un `claude` finto. Il disco del progetto no: si legge e si scrive davvero,
// su cartelle temporanee.
import { readFileSync } from 'node:fs';
import { configFilePath, docsRootName } from './config.js';
import { planSpawnRequest, regiaRefusal } from './endpoint-spawn.js';
import { claudeEnv } from './git-bash.js';
import { modelAlias } from './glyphs.js';
import {
  classifyTurn,
  dropHeadlessState,
  errPath,
  headlessIds,
  headlessTouchedMs,
  outPath,
  parseTurnOutput,
  readState,
  readText,
  STATE_PROMPT_MAX,
  writeState,
  type HeadlessState,
  type Outcome,
} from './headless-state.js';
import type { SessionProcess } from './live-sessions.js';
import { loadPromptCatalog, PROMPT_CATALOG, type CatalogEntry } from './prompt-catalog.js';
import { transcriptIds, transcriptModel } from './sessions.js';
import { isModelKind, MODEL_DEFAULT, type ModelKind } from './spawn-catalog.js';
import { loadSpawnOverrides, resolveSpawnId, taskHoles } from './spawn-config.js';
import { normalizeSession, type SpawnRequest } from './spawn-endpoint.js';
import { deckArgs, resumeArgs } from './spawn.js';
import { bindSession, dropEnv, INHERITED_SESSION_ENV, type SessionBinding } from './session-env.js';
import { isHelpRequest, isUsageError, parseTabArgs } from './tab-args.js';
import { composeTab, permissionMode, type TabPlan } from './tab-compose.js';
import { appendNote, appendRegia, appendSessionMeta, appendTaskBinding, loadSessionIndex } from './task-index.js';
import { loadTaskFileText, loadTasks, resolveTasksDir, resolveTasksPath } from './tasks.js';

/**
 * Tutto ciò che il turno NON eredita da chi lo lancia.
 *
 *  - le variabili della conversazione che lancia (`INHERITED_SESSION_ENV`, la
 *    lista che il deck toglie a ogni `claude` che lancia): una headless la
 *    lancia di norma una regia, cioè una conversazione;
 *  - `PTYXIS_PROFILE`: con il profilo, gli hook di stato del turno cambiano lo
 *    stato del PROGETTO in compass — `done` accende badge e suono, `end` lo
 *    riporta a `idle` cancellando l'`ask` di una tab vera (misura 10). Una
 *    headless non ha una tab a cui badge e «Vai» possano portare;
 *  - `LOOM_TASK`: il binding di sessione di chi lancia. Il turno porta il
 *    proprio, o nessuno su una conversazione senza task;
 *  - `PROJECT_ROOT`: batte la cartella nella ricerca della root degli script del
 *    plugin, e un turno lanciato su un altro progetto scriverebbe in quello di
 *    chi lancia.
 */
export const HEADLESS_DROP_ENV: readonly string[] = [
  ...INHERITED_SESSION_ENV,
  'PTYXIS_PROFILE',
  'LOOM_TASK',
  'PROJECT_ROOT',
];

/** L'ambiente del turno: quello di chi lancia, meno `HEADLESS_DROP_ENV`, più
 *  `LOOM_TASK` sul ramo bound e `LOOM_REGIA` quando il comando dichiara la
 *  regia (T220). Su Windows anche il bash di Git (`claudeEnv`), come ogni
 *  `claude` che il deck lancia. */
export function headlessEnv(
  env: Readonly<Record<string, string | undefined>>,
  binding: SessionBinding,
  platform: NodeJS.Platform,
  bash?: () => string | null,
): NodeJS.ProcessEnv {
  const out = bindSession(dropEnv(env, HEADLESS_DROP_ENV), binding) as NodeJS.ProcessEnv;
  return claudeEnv(platform, out, bash) ?? out;
}

/**
 * L'argv di un turno, dopo il nome del comando.
 *
 *  - `-p` e `--output-format json`: un turno, poi il processo finisce e scrive
 *    l'evento `result` su stdout, che il lanciatore ha rediretto su file;
 *  - `--permission-prompts none` (P1 preflight): nessuno risponde a un prompt
 *    di permesso, e ciò che chiederebbe è negato e finisce nell'esito
 *    (`permission_denials`) invece di lasciare il processo appeso;
 *  - i flag della tab (`composeTab`), senza il prompt;
 *  - `--` e il testo: un testo che comincia con `-` sarebbe letto come
 *    un'opzione ignota, e il turno non partirebbe.
 */
export function headlessArgs(tabArgs: readonly string[], text: string): string[] {
  return ['-p', '--output-format', 'json', '--permission-prompts', 'none', ...tabArgs, '--', text];
}

export interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  outFile: string;
  errFile: string;
}

export interface HeadlessIo {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** Il lanciatore di `claude` (`claudeLauncher`). */
  claude: { cmd: string; prefix: string[] };
  now: () => Date;
  newId: () => string;
  /** Lancia il processo staccato, stdout e stderr sui due file; il pid, o il
   *  motivo per cui non è partito. */
  launch: (cmd: string, args: string[], opts: LaunchOptions) => Promise<{ pid: number } | { error: string }>;
  /** L'ora di avvio del processo (`/proc/<pid>/stat`), `''` dove non si legge. */
  procStartOf: (pid: number) => string;
  /** Il processo è ancora quello partito a `procStart`, e non è finito. */
  running: (pid: number, procStart: string) => boolean;
  /** I processi vivi della conversazione, di qualunque forma (registro). */
  processes: (sessionId: string) => SessionProcess[];
}

export type TurnReply = { ok: true; state: HeadlessState; warnings: string[] } | { ok: false; reason: string };

/** Quanto può restare uno stato senza pid prima di dirlo un lanciatore
 *  interrotto: il pid si scrive nei millisecondi dopo lo spawn. */
export const PENDING_MAX_MS = 60_000;

/** T206/P1 — quanto restano su disco i tre file di un turno finito. */
export const HEADLESS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * T206 — il margine prima di togliere i file di un turno finito il cui
 * transcript non c'è. Un turno che fallisce prima del primo record (un CLI che
 * rifiuta gli argomenti) non lascia nessun transcript, e il suo esito è proprio
 * lo stderr da leggere con `status`: senza margine, l'`open` di un altro turno
 * lanciato subito dopo lo cancellerebbe prima che la regia lo legga.
 */
export const HEADLESS_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * T206/P1 — le conversazioni headless del progetto i cui file di stato vanno
 * tolti: turno finito da più di `HEADLESS_KEEP_MS`, oppure finito e senza più
 * transcript (cancellato dal deck, o a mano).
 *
 * Un turno in corso non si tocca mai, nemmeno senza transcript: nei primi
 * istanti il transcript non esiste ancora. «In corso» è l'esito di `status`
 * (`turnOutcome`), compreso il turno in avvio senza pid. Uno stato illeggibile
 * resta: non si sa di che turno sia, e toglierlo non è la decisione di chi pulisce.
 */
export function staleHeadless(
  root: string,
  io: Pick<HeadlessIo, 'running' | 'now'>,
  transcripts: ReadonlySet<string>,
): string[] {
  const now = io.now().getTime();
  const stale: string[] = [];
  for (const id of headlessIds(root)) {
    const st = readState(root, id);
    if (!st) continue;
    if (turnOutcome(root, st, io).cls === 'in corso') continue;
    const age = now - headlessTouchedMs(root, id);
    if (age >= HEADLESS_KEEP_MS || (!transcripts.has(id) && age >= HEADLESS_ORPHAN_GRACE_MS)) stale.push(id);
  }
  return stale;
}

/**
 * T206/P1 — toglie i file di stato dei turni finiti (`staleHeadless`); gli id
 * puliti. La chiama `openHeadless`: pulisce chi scrive, quindi funziona anche a
 * deck spento, e la regia che lancia turni la tiene in moto da sola. Un errore
 * qui non ferma mai l'apertura del turno: i file restano al giro dopo.
 */
export function pruneHeadless(root: string, io: Pick<HeadlessIo, 'running' | 'now'>): string[] {
  try {
    const stale = staleHeadless(root, io, new Set(transcriptIds(root)));
    for (const id of stale) dropHeadlessState(root, id);
    return stale;
  } catch {
    return [];
  }
}

interface ProjectContext {
  tasksPath: string;
  tasksDir: string;
  config: unknown;
  catalog: Map<string, CatalogEntry>;
  catalogPath: string;
}

function projectContext(root: string, io: HeadlessIo): ProjectContext {
  const docsRoot = docsRootName(root);
  const catalogPath = io.env.LOOM_DECK_PROMPT_CATALOG || PROMPT_CATALOG;
  let config: unknown = null;
  try {
    config = JSON.parse(readFileSync(configFilePath(root), 'utf8'));
  } catch {
    // senza file di progetto: titolo `cc`, permission mode `manual`
  }
  return {
    tasksPath: resolveTasksPath(root, docsRoot),
    tasksDir: resolveTasksDir(root, docsRoot),
    config,
    catalog: loadPromptCatalog(catalogPath),
    catalogPath,
  };
}

/** La composizione della tab sugli argomenti di `deck-run`, senza tab: titolo,
 *  flag di `claude` e avvisi. Nessun gemello nel titolo (`twinTitle`): il
 *  carattere serve a ritrovare una TAB per titolo, e qui non ce n'è una. */
function compose(args: string[], ctx: ProjectContext, io: HeadlessIo): TabPlan {
  const req = parseTabArgs(args);
  if (isUsageError(req)) throw new Error(`argomenti di composizione rifiutati: ${req.lines.join(' ')}`);
  // Gli argomenti li compone il deck (`deckArgs`, `resumeArgs`), e un testo
  // dell'utente ci entra solo come valore di `--prompt` o `--title-note`:
  // un `--help` nudo è un guasto della composizione, non una domanda.
  if (isHelpRequest(req)) throw new Error(`argomenti di composizione rifiutati: --help fra ${args.join(' ')}`);
  return composeTab(req, {
    env: io.env,
    config: ctx.config,
    catalog: ctx.catalog,
    catalogPath: ctx.catalogPath,
    platform: io.platform,
    liveRequestedNames: [],
  });
}

/**
 * Lo stato del turno PRIMA del processo, poi con il suo pid.
 *
 * Il primo scritto c'è perché fra il lancio e la scrittura del pid il file
 * d'esito è già stato troncato: chi legge in quel mezzo troverebbe lo stato del
 * turno precedente (processo finito) e nessun esito, cioè un falso «errore».
 * Uno stato senza pid si legge «in corso» (`turnOutcome`).
 */
async function launchTurn(
  root: string,
  io: HeadlessIo,
  base: Omit<HeadlessState, 'startedAt' | 'pid' | 'procStart' | 'launchError'>,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<HeadlessState> {
  const pending: HeadlessState = { ...base, startedAt: io.now().toISOString(), pid: null, procStart: '' };
  writeState(root, pending);
  const r = await io.launch(io.claude.cmd, [...io.claude.prefix, ...args], {
    cwd: root,
    env,
    outFile: outPath(root, base.sessionId),
    errFile: errPath(root, base.sessionId),
  });
  const st: HeadlessState =
    'pid' in r
      ? { ...pending, pid: r.pid, procStart: io.procStartOf(r.pid) }
      : { ...pending, launchError: r.error };
  writeState(root, st);
  return st;
}

function clip(text: string): string {
  const cps = [...text];
  return cps.length <= STATE_PROMPT_MAX ? text : `${cps.slice(0, STATE_PROMPT_MAX).join('')}…`;
}

/**
 * Apre una conversazione headless su una task: la stessa richiesta di
 * `loom-deck-spawn`, eseguita senza tab.
 *
 * I rifiuti, in ordine: un'azione senza prompt (`none`, o un override che lo
 * svuota) non ha un turno da eseguire; i rifiuti di `planSpawnRequest` (la
 * regia, task assente, run su un mandato, perimetro); `run` e `checkpoint` su un progetto
 * `manual` (D2 preflight) — un canale senza nessuno che guarda non allarga il
 * permesso che il progetto ha dichiarato, e in `manual` ogni comando di un run
 * sarebbe negato.
 */
export async function openHeadless(req: SpawnRequest, root: string, io: HeadlessIo): Promise<TurnReply> {
  if (req.kind === 'none') {
    return { ok: false, reason: 'kind none: un turno headless senza prompt non ha niente da eseguire' };
  }
  pruneHeadless(root, io);
  const ctx = projectContext(root, io);
  const overrides = loadSpawnOverrides(root).entries;
  const plan = planSpawnRequest(req, {
    ...taskLookup(ctx),
    defaults: (kind, id) => resolveSpawnId(kind, overrides, ctx.catalog, taskHoles(ctx.tasksDir, id)),
  }, 'headless');
  if (!plan.ok) return plan;
  if (!plan.prompt) return { ok: false, reason: `l'azione ${plan.kind} non ha prompt (override di progetto?)` };

  const warnings: string[] = [];
  const mode = permissionMode({ env: io.env, config: ctx.config }, warnings);
  if (mode === 'manual' && (plan.kind === 'run' || plan.kind === 'checkpoint')) {
    return {
      ok: false,
      reason: `permissionMode manual: ${plan.kind} rifiutato in headless, nessuno approverebbe i permessi (apri la task in una tab)`,
    };
  }

  const sessionId = io.newId();
  const tab = compose(deckArgs(req.task, sessionId, plan.model, plan.note, '', plan.regia?.regia), ctx, io);
  warnings.push(...tab.warnings);

  // P7 — il binding prima del processo, con gli stessi campi del tasto del deck
  // (`spawnForTask`), più l'alias del modello: una risposta lo ritrova anche
  // prima che il transcript ne nomini uno. T220 — e la regia che apre il turno,
  // come uno spawn dall'endpoint.
  appendTaskBinding(root, sessionId, req.task);
  if (plan.regia) appendRegia(root, sessionId, plan.regia.regia, plan.regia.session);
  if (plan.note) appendNote(root, sessionId, plan.note);
  appendSessionMeta(root, sessionId, { model: plan.model });

  const state = await launchTurn(
    root,
    io,
    {
      sessionId,
      task: req.task,
      kind: plan.kind,
      model: plan.model,
      title: tab.title,
      permissionMode: mode,
      turn: 1,
      prompt: clip(plan.prompt),
      ...regiaField(tab),
    },
    headlessArgs(tab.claudeArgs, plan.prompt),
    headlessEnv(io.env, { task: req.task, regia: tab.sessionEnv.LOOM_REGIA ?? null }, io.platform),
  );
  if (state.launchError) return { ok: false, reason: state.launchError };
  return { ok: true, state, warnings };
}

/** Le due letture della lista task che servono a un piano e a una regia
 *  dichiarata: la riga in `tasks.md` e il task file. */
function taskLookup(ctx: ProjectContext) {
  return {
    taskExists: (id: string) => {
      try {
        return loadTasks(ctx.tasksPath).some((t) => t.id === id);
      } catch {
        return false;
      }
    },
    taskText: (id: string) => loadTaskFileText(ctx.tasksDir, id),
  };
}

/** T220 — la regia del turno nello stato su disco, come `LOOM_REGIA` l'ha
 *  ricevuta dalla composizione: assente se il turno non ne ha. */
function regiaField(tab: TabPlan): { regia?: string } {
  return tab.sessionEnv.LOOM_REGIA ? { regia: tab.sessionEnv.LOOM_REGIA } : {};
}

/** Un `sessionId` intero o un suo prefisso fra i candidati; il motivo del
 *  rifiuto se non ne indica esattamente uno. */
export function resolveSession(ref: string, candidates: readonly string[]): { sessionId: string } | { error: string } {
  const s = normalizeSession(ref);
  if (s === null) return { error: `sessione non valida: '${ref}' (sessionId, o prefisso di almeno 8 caratteri esadecimali)` };
  const hits = [...new Set(candidates.filter((c) => c.startsWith(s)))];
  if (hits.length === 1) return { sessionId: hits[0]! };
  if (hits.length === 0) return { error: `nessuna conversazione ${s} nel progetto` };
  return { error: `${s} indica ${hits.length} conversazioni: ${hits.map((h) => h.slice(0, 13)).join(', ')}` };
}

function describeProcess(p: SessionProcess): string {
  if (p.kind !== 'interactive') return `job ${p.kind}`;
  return p.entrypoint === 'sdk-cli' ? 'turno headless' : 'tab';
}

/**
 * Manda un messaggio a una conversazione ferma e ne avvia il turno successivo,
 * con `--resume`.
 *
 * La conversazione può essere nata headless o in una tab: basta che il progetto
 * ne abbia il transcript. Rifiutata se ha un processo vivo, di qualunque forma
 * (P4 preflight): due processi sullo stesso transcript non devono esistere, e
 * una coda di messaggi non c'è.
 *
 * Task, nota e modello vengono da dove li prende il deck quando la riprende in
 * una tab: il binding e la nota dal sidecar, il modello dal transcript (T148),
 * poi dal sidecar, poi il default.
 *
 * T220 — `regia` è la regia che risponde, dichiarata a ogni turno
 * (`reply --regia`): ogni turno è un processo nuovo, `SessionStart` scatta a
 * ogni `--resume`, e senza la regia il turno nascerebbe senza `LOOM_REGIA` —
 * senza la riga dell'organigramma (P2 preflight). Non si rilegge dal sidecar,
 * e non si scrive nel sidecar: la provenienza è dello spawn.
 */
export async function replyHeadless(
  ref: string,
  message: string,
  root: string,
  io: HeadlessIo,
  modelOverride?: ModelKind,
  regia?: string,
): Promise<TurnReply> {
  if (!message.trim()) return { ok: false, reason: 'messaggio vuoto' };
  const prefix = normalizeSession(ref) ?? '';
  const found = resolveSession(ref, [...transcriptIds(root, prefix), ...headlessIds(root, prefix)]);
  if ('error' in found) return { ok: false, reason: found.error };
  const { sessionId } = found;
  const short = sessionId.slice(0, 8);

  const live = io.processes(sessionId);
  if (live.length) {
    const p = live[0]!;
    return {
      ok: false,
      reason: `${short} ha un processo vivo (pid ${p.pid}, ${describeProcess(p)}): una risposta parte solo a conversazione ferma`,
    };
  }
  const prev = readState(root, sessionId);
  if (prev && turnOutcome(root, prev, io).cls === 'in corso') {
    return { ok: false, reason: `${short} ha un turno headless in corso (pid ${prev.pid ?? 'in avvio'})` };
  }

  const ctx = projectContext(root, io);
  if (regia) {
    const bad = regiaRefusal(regia, taskLookup(ctx));
    if (bad) return { ok: false, reason: bad };
  }
  const index = loadSessionIndex(root);
  const task = index.bindings.get(sessionId) || null;
  // `--regia` vuole una task (`parseTabArgs`): una conversazione spot non è un
  // membro di nessun perimetro, e il rifiuto qui dice perché invece del guasto
  // della composizione.
  if (regia && !task) return { ok: false, reason: `${short} non è legata a una task: --regia vale solo su un membro` };
  const note = index.notes.get(sessionId);
  const sidecarModel = index.models.get(sessionId);
  const model: ModelKind =
    modelOverride ??
    modelAlias(transcriptModel(root, sessionId)) ??
    (isModelKind(sidecarModel) ? sidecarModel : null) ??
    prev?.model ??
    MODEL_DEFAULT;

  const tab = compose(resumeArgs(task, sessionId, model, note, regia), ctx, io);
  const state = await launchTurn(
    root,
    io,
    {
      sessionId,
      task,
      kind: prev?.kind ?? 'reply',
      model,
      title: tab.title,
      permissionMode: permissionMode({ env: io.env, config: ctx.config }, []),
      turn: (prev?.turn ?? 0) + 1,
      prompt: clip(message),
      ...regiaField(tab),
    },
    headlessArgs(tab.claudeArgs, message),
    headlessEnv(io.env, { task, regia: tab.sessionEnv.LOOM_REGIA ?? null }, io.platform),
  );
  if (state.launchError) return { ok: false, reason: state.launchError };
  return { ok: true, state, warnings: tab.warnings };
}

/**
 * L'esito dell'ultimo turno, dai file su disco e dalla liveness del processo.
 *
 * Uno stato senza pid è un turno in avvio (`launchTurn`): «in corso» finché è
 * giovane, un lanciatore interrotto quando non lo è più.
 */
export function turnOutcome(root: string, st: HeadlessState, io: Pick<HeadlessIo, 'running' | 'now'>): Outcome {
  if (st.pid === null && !st.launchError) {
    const age = io.now().getTime() - Date.parse(st.startedAt);
    if (age < PENDING_MAX_MS) return { cls: 'in corso', result: null, reason: 'in avvio' };
    return { cls: 'errore', result: null, reason: 'lanciatore interrotto prima di scrivere il pid del turno' };
  }
  const result = parseTurnOutput(readText(outPath(root, st.sessionId)));
  const running = st.pid !== null && io.running(st.pid, st.procStart);
  return classifyTurn(st, result, running, readText(errPath(root, st.sessionId)));
}
