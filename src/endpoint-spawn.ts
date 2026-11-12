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
import { parseDeliverables } from './deliverables.js';
import { dlvPrompt } from './overlays/dlv-mode.js';
import { INTAB_MARKER, TITLE_MARKER, type Spawned } from './spawn.js';
import { specializeRecap, type ModelKind, type PromptKind } from './spawn-catalog.js';
import type { ResolvedSpawn } from './spawn-config.js';
import type { SpawnReply, SpawnRequest } from './spawn-endpoint.js';
import { taskIsEpic } from './tasks.js';

/** Quanto il deck aspetta l'annuncio di `deck-run` prima di rispondere con un
 *  errore. `deck-run` compone in millisecondi; il margine copre l'avvio di node
 *  su una macchina carica, non uno spawn che può legittimamente durare. */
export const ANNOUNCE_TIMEOUT_MS = 15_000;

export interface SpawnRequestDeps {
  /** Il motivo per cui lo spawn è spento su questa piattaforma, o `null`. */
  spawnOff: () => string | null;
  /** La task ha una riga in `tasks.md`. */
  taskExists: (id: string) => boolean;
  /** Il testo del task file, o `null` se non si trova. */
  taskText: (id: string) => string | null;
  /** La terna dell'azione di catalogo sulla task (default ← override). */
  defaults: (kind: PromptKind, taskId: string) => ResolvedSpawn;
  /** Lo spawn del tasto: sidecar, poi `deck-run`. `null` se rifiutato. */
  spawn: (
    id: string,
    model: ModelKind,
    note: string,
    prompt: string,
  ) => { sessionId: string; spawned: Spawned } | null;
  announceTimeoutMs?: number;
}

export async function handleSpawnRequest(req: SpawnRequest, deps: SpawnRequestDeps): Promise<SpawnReply> {
  const off = deps.spawnOff();
  if (off) return { ok: false, reason: off };
  if (!deps.taskExists(req.task)) return { ok: false, reason: `${req.task} non è nella lista task del progetto` };
  const text = deps.taskText(req.task);

  if (req.scope) {
    const bad = scopeProblem(req.task, text, req.scope);
    if (bad) return { ok: false, reason: bad };
  }

  // `recap` → la sotto-skill giusta, come fa il detail: il task file è già
  // letto, quindi il dispatcher non serve. Senza task file resta il dispatcher.
  const kind = text === null ? req.kind : specializeRecap(req.kind, taskIsEpic(req.task, text));
  const d = deps.defaults(kind, req.task);
  // Il perimetro in coda al prompt dell'azione `run` GIÀ RISOLTO, nella forma
  // del modo DLV del detail: un override di progetto sul prompt di `run` vale
  // anche qui.
  const prompt = req.scope ? dlvPrompt(d.prompt, req.scope) : (d.prompt ?? '');
  const model = req.model ?? d.model;
  const note = req.note ?? d.title ?? '';

  const out = deps.spawn(req.task, model, note, prompt);
  if (!out) return { ok: false, reason: 'spawn rifiutato dal deck' };
  const announced = await awaitAnnounce(out.spawned.child, deps.announceTimeoutMs ?? ANNOUNCE_TIMEOUT_MS);
  if ('error' in announced) return { ok: false, reason: announced.error };
  const base = { ok: true as const, sessionId: out.sessionId, task: req.task, kind, model, prompt };
  if ('inert' in announced) return { ...base, title: null, inTab: null, inert: true };
  return { ...base, title: announced.title, inTab: announced.inTab };
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
