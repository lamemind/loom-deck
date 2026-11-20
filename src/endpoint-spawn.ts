// T196 — dalla RICHIESTA allo spawn: una richiesta arrivata sull'endpoint
// diventa la stessa chiamata che parte dal tasto del deck.
//
// Il percorso è quello di `spawnForTask` (`actions.ts`), non una sua copia: la
// conversazione aperta così deve essere indistinguibile da una aperta a mano —
// binding nel sidecar scritto prima della tab, `--session-id` pinnato, titolo,
// modello con l'override di progetto. Qui sta solo ciò che il tasto non ha
// bisogno di fare, perché il deck lo sa già per costruzione quando c'è un umano
// davanti: che la task esista, che i DLV del perimetro siano aperti, quale
// azione di catalogo corrisponde al kind.
//
// Nessuno stato React e nessuna rete: le dipendenze arrivano come funzioni
// (`SpawnRequestDeps`), così il test esegue il percorso intero con un
// `deck-run` vero e un terminale finto.
import type { ChildProcess } from 'node:child_process';
import { dlvPrompt, parseDeliverables } from './deliverables.js';
import { INTAB_MARKER, TITLE_MARKER, type Spawned } from './spawn.js';
import { specializeRecap, type ModelKind, type PromptKind } from './spawn-catalog.js';
import type { ResolvedSpawn } from './spawn-config.js';
import {
  CHANNEL_REFUSALS,
  kindRefusal,
  type ChannelRefusals,
  type RequestChannel,
  type SpawnReply,
  type SpawnRequest,
} from './spawn-endpoint.js';
import { memberRegia } from './tab-args.js';
import { taskIsMandate, taskIsPerimeter } from './tasks.js';
import type { WindowCheck } from './window-check.js';

/** Quanto il deck aspetta l'annuncio di `deck-run` prima di rispondere con un
 *  errore. `deck-run` compone in millisecondi; il margine copre l'avvio di node
 *  su una macchina carica, non uno spawn che può legittimamente durare. */
export const ANNOUNCE_TIMEOUT_MS = 15_000;

/** Ciò che serve a risolvere una richiesta in un'azione di catalogo: la task, il
 *  suo file, la terna dell'azione. Lo usano l'endpoint e `loom-deck-headless`
 *  (T205), che apre lo stesso turno senza una tab. */
export interface SpawnPlanDeps {
  /** La task ha una riga in `tasks.md`. */
  taskExists: (id: string) => boolean;
  /** Il testo del task file, o `null` se non si trova. */
  taskText: (id: string) => string | null;
  /** La terna dell'azione di catalogo sulla task (default ← override). */
  defaults: (kind: PromptKind, taskId: string) => ResolvedSpawn;
}

export interface SpawnRequestDeps extends SpawnPlanDeps {
  /** Il motivo per cui lo spawn è spento su questa piattaforma, o `null`. */
  spawnOff: () => string | null;
  /** Lo spawn del tasto: sidecar, poi `deck-run`. `null` se rifiutato.
   *  T220 — `regia` è la regia che chiede, già verificata, o `null`. */
  spawn: (
    id: string,
    model: ModelKind,
    note: string,
    prompt: string,
    regia: RegiaOrigin | null,
  ) => { sessionId: string; spawned: Spawned } | null;
  /** T198 — la finestra in focus è del progetto? Assente = nessun controllo,
   *  dove la piattaforma non ce l'ha (`windowCheck` in `platform.ts`). Gira
   *  dopo le verifiche della richiesta e prima dello spawn: un rifiuto non
   *  apre la tab e non scrive il binding nel sidecar, che scrive `spawn`. */
  windowCheck?: () => Promise<WindowCheck>;
  announceTimeoutMs?: number;
}

/** T220 — la regia che chiede uno spawn: il perimetro, che diventa
 *  `LOOM_REGIA`, e il `sessionId` della regia quando il client lo conosce. I
 *  due finiscono nel sidecar (`appendRegia`) come provenienza. */
export interface RegiaOrigin {
  regia: string;
  session?: string;
}

/** Una richiesta risolta: il kind effettivo, la terna e il prompt col
 *  perimetro, la regia da impostare, o il rifiuto col suo motivo. */
export type SpawnPlan =
  | { ok: true; kind: PromptKind; model: ModelKind; note: string; prompt: string; regia: RegiaOrigin | null }
  | { ok: false; reason: string };

export async function handleSpawnRequest(req: SpawnRequest, deps: SpawnRequestDeps): Promise<SpawnReply> {
  const off = deps.spawnOff();
  if (off) return { ok: false, reason: off };
  const plan = planSpawnRequest(req, deps, 'endpoint');
  if (!plan.ok) return plan;
  const { kind, model, note, prompt, regia } = plan;

  // Dopo il piano: una richiesta sbagliata si rifiuta col suo motivo, che vale
  // in qualunque finestra, e il processo verso compass parte solo per uno
  // spawn che avverrebbe davvero.
  const check = deps.windowCheck ? await deps.windowCheck() : { ok: true as const };
  if ('refuse' in check) return { ok: false, reason: check.refuse };
  const warning = 'warning' in check ? { warning: check.warning } : {};

  const out = deps.spawn(req.task, model, note, prompt, regia);
  if (!out) return { ok: false, reason: 'spawn rifiutato dal deck' };
  const announced = await awaitAnnounce(out.spawned.child, deps.announceTimeoutMs ?? ANNOUNCE_TIMEOUT_MS);
  if ('error' in announced) return { ok: false, reason: announced.error };
  // T220/P4 — `regia` sempre nella risposta, anche `null`: è ciò che separa un
  // deck che la conosce da uno più vecchio, che la ignorerebbe in silenzio.
  const base = {
    ok: true as const,
    sessionId: out.sessionId,
    task: req.task,
    kind,
    model,
    prompt,
    regia: regia?.regia ?? null,
    ...warning,
  };
  if ('inert' in announced) return { ...base, title: null, inTab: null, inert: true };
  return { ...base, title: announced.title, inTab: announced.inTab };
}

/**
 * La richiesta contro il progetto: il kind non è la regia, la task esiste, un
 * run non cade su un mandato, il perimetro è fatto di DLV aperti; poi l'azione di catalogo, la sua
 * terna e il prompt col perimetro in coda.
 *
 * T205 — separata dallo spawn perché la stessa richiesta apre anche un turno
 * headless (`loom-deck-headless open`): due copie di questi rifiuti
 * divergerebbero al primo ritocco, e il turno headless partirebbe dove la tab
 * è rifiutata.
 *
 * `refusals` è la tabella dei kind rifiutati per canale, `CHANNEL_REFUSALS` per
 * ogni chiamante del deck. Un parametro e non solo la costante perché un test
 * deve poter arrivare alle regole che oggi stanno dietro un rifiuto — la regia
 * scartata sul kind `regia` (T220/P3), che T221 renderà raggiungibile togliendo
 * la riga `endpoint` — senza aspettare che il rifiuto cada.
 */
export function planSpawnRequest(
  req: SpawnRequest,
  deps: SpawnPlanDeps,
  channel: RequestChannel,
  refusals: ChannelRefusals = CHANNEL_REFUSALS,
): SpawnPlan {
  // T203/P3 — un kind che il canale non accetta (la regia, oggi su entrambi):
  // `PROMPT_KINDS` è la lista di `deck-run`, e la richiesta valida sulla stessa
  // lista. La regola sta in `kindRefusal`, che fa anche l'elenco dell'help dei
  // client. Prima della task: il motivo non dipende dalla task chiesta.
  const refused = kindRefusal(req.kind, channel, refusals);
  if (refused) return { ok: false, reason: refused };
  if (!deps.taskExists(req.task)) return { ok: false, reason: `${req.task} non è nella lista task del progetto` };
  const text = deps.taskText(req.task);
  // T220/P1 — prima del resto della task chiesta: una regia che non è un
  // perimetro è un errore di chi chiama, qualunque sia il membro.
  if (req.regia) {
    const bad = regiaRefusal(req.regia, deps);
    if (bad) return { ok: false, reason: bad };
  }

  // T212/P4 — un mandato non ha lavoro proprio: il run si rifiuta qui, senza
  // aprire una tab che `run-task` chiuderebbe con lo stesso rifiuto un turno di
  // modello dopo. Prima del perimetro, perché il motivo vero è questo e non i
  // DLV che il file potrebbe portare.
  if (req.kind === 'run' && taskIsMandate(req.task, text)) {
    return { ok: false, reason: `${req.task} è un mandato: il lavoro sta nei membri, niente run` };
  }

  if (req.scope) {
    const bad = scopeProblem(req.task, text, req.scope);
    if (bad) return { ok: false, reason: bad };
  }

  // `recap` → la sotto-skill giusta, come fa il detail: il task file è già
  // letto, quindi il dispatcher non serve. Senza task file resta il dispatcher.
  // T212 — un mandato va a `recap-epic` come un'epica: è il recap del perimetro.
  const kind = text === null ? req.kind : specializeRecap(req.kind, taskIsPerimeter(req.task, text));
  const d = deps.defaults(kind, req.task);
  // Il perimetro in coda al prompt dell'azione `run` GIÀ RISOLTO, nella forma
  // del modo DLV del detail: un override di progetto sul prompt di `run` vale
  // anche qui.
  const prompt = req.scope ? dlvPrompt(d.prompt, req.scope) : (d.prompt ?? '');
  const model = req.model ?? d.model;
  const note = req.note ?? d.title ?? '';
  // T220/P3 — una conversazione che è a sua volta una regia non riceve la
  // regia che la chiede. Qui e non solo in `composeTab`: dal deck il prompt
  // arriva a `deck-run` come testo letterale, e la composizione non vede il
  // kind. Oggi il kind `regia` lo rifiuta `kindRefusal` più su; la regola
  // serve al canale che lo aprirà (T221).
  const regiaId = req.regia ? memberRegia(kind, req.regia) : '';
  const regia: RegiaOrigin | null = regiaId
    ? { regia: regiaId, ...(req.regiaSession ? { session: req.regiaSession } : {}) }
    : null;
  return { ok: true, kind, model, note, prompt, regia };
}

/**
 * T220/P1 — il motivo per cui `regia` non può dichiararsi regia di una
 * conversazione del progetto, o `null`. Una regia è un perimetro: un'epica o un
 * mandato con la sua riga in `tasks.md`. Una dichiarazione sbagliata darebbe
 * alla conversazione una riga dell'organigramma che nomina una regia che non
 * c'è, e le negherebbe `AskUserQuestion` per niente.
 *
 * La usano l'apertura di una conversazione (`planSpawnRequest`, tab e
 * headless) e la risposta a una headless (`replyHeadless`), che dichiara la
 * regia a ogni turno.
 */
export function regiaRefusal(regia: string, deps: Pick<SpawnPlanDeps, 'taskExists' | 'taskText'>): string | null {
  if (!deps.taskExists(regia)) return `regia ${regia}: non è nella lista task del progetto`;
  if (!taskIsPerimeter(regia, deps.taskText(regia))) return `regia ${regia}: non è un'epica né un mandato`;
  return null;
}

/** Il perimetro chiesto contro i DLV del task file: un numero fuori lista o un
 *  DLV già chiuso li rifiuterebbe `run-task` nella tab, dopo averla aperta. Il
 *  deck li rifiuta prima, con lo stesso criterio (`task-deliverables.sh`). */
function scopeProblem(task: string, text: string | null, scope: readonly number[]): string | null {
  if (text === null) return `task file di ${task} non trovato: perimetro non verificabile`;
  const dlvs = parseDeliverables(text);
  if (dlvs.length === 0) return `${task} non ha DLV`;
  const missing = scope.filter((n) => n > dlvs.length);
  if (missing.length) return `DLV fuori range in ${task}: ${missing.join(',')} (ne ha ${dlvs.length})`;
  const done = scope.filter((n) => dlvs[n - 1]!.done);
  if (done.length) return `DLV già chiusi in ${task}: ${done.join(',')}`;
  return null;
}

type Announced = { title: string | null; inTab: string } | { inert: true } | { error: string };

/**
 * L'annuncio di `deck-run`: la riga del titolo e quella del comando in-tab.
 *
 * La risposta parte all'annuncio (P2 preflight): `deck-run` lo scrive quando ha
 * composto la tab e sta per aprirla. Un `deck-run` che esce PRIMA di annunciare
 * ha rifiutato gli argomenti o non è partito, e la tab non c'è.
 *
 * Un figlio senza stdout è lo spawn inerte dei test (`LOOM_DECK_NO_SPAWN`): non
 * annuncerà mai niente, e aspettarlo vorrebbe dire rispondere col timeout.
 */
export function awaitAnnounce(child: ChildProcess, timeoutMs: number): Promise<Announced> {
  if (!child.stdout) return Promise.resolve({ inert: true });
  const stdout = child.stdout;
  return new Promise((resolve) => {
    let buf = '';
    let title: string | null = null;
    let settled = false;
    const settle = (a: Announced) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      resolve(a);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith(TITLE_MARKER)) title = line.slice(TITLE_MARKER.length);
        else if (line.startsWith(INTAB_MARKER)) return settle({ title, inTab: line.slice(INTAB_MARKER.length) });
      }
    };
    const onError = (e: NodeJS.ErrnoException) => settle({ error: `deck-run non lanciabile (${e.code ?? String(e)})` });
    // `close` e non `exit`: `close` arriva dopo l'ultimo `data` dello stdout,
    // mentre `exit` può precederlo — un annuncio scritto e poi un'uscita veloce
    // si leggerebbero come un'uscita senza annuncio.
    const onClose = (code: number | null) =>
      settle({ error: `deck-run uscito con ${code ?? 'segnale'} prima di aprire la tab` });
    const timer = setTimeout(() => settle({ error: `nessun annuncio da deck-run entro ${timeoutMs} ms` }), timeoutMs);
    stdout.on('data', onData);
    child.on('error', onError);
    child.on('close', onClose);
  });
}
