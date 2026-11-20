// T229 — la CODA degli spawn chiesti da una conversazione quando la finestra in
// focus non è del progetto.
//
// Prima di T229 il `no` di `ProjectFocused` era un rifiuto (T198): chi aveva
// chiesto lo spawn — spesso una regia — restava fermo finché l'utente non
// portava davanti la finestra e non chiedeva di nuovo. Ora la richiesta resta
// qui, compass mostra una notifica col bottone «Vai», e la tab nasce quando una
// finestra del progetto torna in focus. Il focus lo porta l'utente, mai il
// deck: uno spostamento deciso da un agente, in un momento che l'utente non
// sceglie, porta la tastiera di chi scrive altrove dentro la tab nuova.
//
// Il ciclo di una richiesta:
//   1. messa in coda — il `sessionId` si sceglie qui, e la risposta al client
//      lo porta subito, con l'ora di scadenza (`QueuedSpawn`);
//   2. attesa — un `gdbus call` ad `AwaitProjectFocus` di compass per
//      richiesta, che risponde al ritorno del focus (P2 preflight);
//   3. apertura — al primo `si` tutte le richieste in coda diventano pronte e
//      si aprono una dopo l'altra in ordine d'arrivo, ciascuna dopo l'annuncio
//      della precedente; prima di ognuna `ProjectFocused` di nuovo, e se
//      l'utente è già andato via le restanti tornano in attesa (P4);
//   4. fine — scadenza a 30 minuti (D1) o attesa caduta: la richiesta muore
//      con una nota e una notifica del deck, e nessuna tab nasce. Una tab non
//      si apre MAI alla cieca dopo un `no`.
//
// Nessuna traccia su disco (P5, P6): la coda vive nella memoria del deck e
// muore con lui, e il binding nel sidecar lo scrive lo spawn vero, insieme alla
// tab. Una richiesta che muore in coda non lascia una conversazione della task
// senza transcript.
//
// Le dipendenze arrivano come funzioni (`SpawnQueueDeps`): il test esegue la
// coda intera con compass, orologio e spawn finti.
import { randomUUID } from 'node:crypto';
import type { OkPlan, SpawnPlan } from './endpoint-spawn.js';
import type { CompassReply } from './focus-session.js';
import type { SpawnReply, SpawnRequest } from './spawn-endpoint.js';
import { refuseReason, WINDOW_CHECK_TIMEOUT_S, type WindowCheck } from './window-check.js';

/** D1 preflight — quanto vive una richiesta in coda. Una tab che nasce ore
 *  dopo prende la tastiera in un momento che l'utente non ha scelto: trenta
 *  minuti coprono un cambio di finestra o una pausa breve. */
export const QUEUE_TTL_MS = 30 * 60 * 1000;

/**
 * Quanto la messa in coda aspetta una risposta immediata di
 * `AwaitProjectFocus` prima di rispondere «in coda» al client.
 *
 * Un compass più vecchio di T229 risponde subito `UnknownMethod`, e la
 * richiesta va rifiutata come in T198 (P2 preflight): senza il metodo nessuno
 * la sveglierebbe. La soglia è quella di `ProjectFocused`, appena chiamato
 * sullo stesso compass: un compass che non risponde a un metodo ignoto entro
 * lì non avrebbe risposto nemmeno al controllo. Il client aspetta la risposta
 * fino a `REPLY_TIMEOUT_MS`, molto oltre.
 */
export const AWAIT_PROBE_MS = WINDOW_CHECK_TIMEOUT_S * 1000;

/** Il titolo delle notifiche del deck sulla coda. */
export const QUEUE_NOTIFY_TITLE = 'loom-deck · spawn in coda';

export interface SpawnQueueDeps {
  /** L'`id` del progetto in `.claude/loom-works.json`, riletto a ogni uso. */
  projectId: () => string | null;
  /** Il nome del progetto nel corpo delle notifiche. */
  name: () => string;
  /** `AwaitProjectFocus` di compass: consegna la risposta una volta sola, e
   *  ritorna la funzione che interrompe l'attesa (`awaitProjectFocus`). */
  awaitFocus: (
    projectId: string,
    notice: string,
    deadlineS: number,
    onResult: (r: CompassReply) => void,
  ) => () => void;
  /** `ProjectFocused` di nuovo, prima di ogni apertura (P4 preflight). */
  recheck: () => Promise<WindowCheck>;
  /** La richiesta contro il progetto di adesso: in trenta minuti la task può
   *  essere cambiata — un DLV del perimetro chiuso da un'altra sessione. */
  replan: (req: SpawnRequest) => SpawnPlan;
  /** Lo spawn vero, col `sessionId` già annunciato: binding, tab, annuncio. */
  open: (req: SpawnRequest, plan: OkPlan, sessionId: string) => Promise<SpawnReply>;
  /** La riga di stato del deck. */
  note: (s: string) => void;
  /** La notifica desktop del deck: la morte di una richiesta in coda. */
  notify: (title: string, body: string) => void;
  now?: () => number;
  newSessionId?: () => string;
  ttlMs?: number;
  probeMs?: number;
}

interface Item {
  seq: number;
  req: SpawnRequest;
  plan: OkPlan;
  sessionId: string;
  expiresAtMs: number;
  label: string;
  /** `waiting`: un'attesa ad `AwaitProjectFocus` è aperta; `ready`: il focus
   *  è arrivato, la richiesta aspetta il suo turno di apertura. */
  state: 'waiting' | 'ready';
  /** La generazione dell'attesa in corso. Ogni attesa lanciata o interrotta
   *  la incrementa: la risposta di un'attesa superata non tocca la richiesta. */
  gen: number;
  stopAwait: () => void;
}

/** Il nome di una richiesta nelle note e nelle notifiche: task, kind, e i DLV
 *  del perimetro quando ci sono — `T219 preflight`, `T14 run DLV 1,3`. */
export function spawnLabel(req: SpawnRequest, plan: Pick<OkPlan, 'kind'>): string {
  const scope = req.scope && req.scope.length ? ` DLV ${req.scope.join(',')}` : '';
  return `${req.task} ${plan.kind}${scope}`;
}

/** Il testo che compass mette nella notifica dello spawn in attesa. */
export function spawnNotice(label: string): string {
  return `spawn in attesa: ${label}`;
}

/** L'ora locale `HH:MM` di un istante, per le note e i motivi. */
export function clockOf(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/**
 * Il motivo del rifiuto quando l'attesa non parte: la risposta immediata di
 * `AwaitProjectFocus` non è `si`. Comincia col motivo di T198, che porta
 * l'istruzione per l'utente, e dice perché la coda non c'è.
 */
export function queueRefusal(r: CompassReply, projectId: string): string {
  const why =
    'unreachable' in r && /UnknownMethod/.test(r.unreachable)
      ? 'compass senza AwaitProjectFocus, da aggiornare'
      : awaitFailure(r);
  return `${refuseReason(projectId)}. Coda non disponibile: ${why}`;
}

/** Perché un'attesa del focus è finita senza il focus. */
export function awaitFailure(r: CompassReply): string {
  if ('unreachable' in r) return `attesa del focus caduta: ${r.unreachable}`;
  switch (r.word) {
    case 'interrotta':
      return "compass spento o ricaricato durante l'attesa";
    case 'ignoto':
      return 'compass non conosce il progetto';
    case 'scaduta':
      return 'richiesta scaduta';
    default:
      return `compass ha risposto «${r.word}»`;
  }
}

export class SpawnQueue {
  private items: Item[] = [];
  private seq = 0;
  private draining = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly newSessionId: () => string;
  private readonly ttlMs: number;
  private readonly probeMs: number;

  constructor(private readonly deps: SpawnQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newSessionId = deps.newSessionId ?? randomUUID;
    this.ttlMs = deps.ttlMs ?? QUEUE_TTL_MS;
    this.probeMs = deps.probeMs ?? AWAIT_PROBE_MS;
  }

  /** Le richieste in coda, in ordine d'arrivo: per i test e per chi le mostra. */
  pending(): Array<{ sessionId: string; task: string; state: Item['state'] }> {
    return this.items.map((i) => ({ sessionId: i.sessionId, task: i.req.task, state: i.state }));
  }

  /**
   * Mette in coda una richiesta già pianificata, a cui `ProjectFocused` ha
   * appena risposto `no`. → la risposta al client: «in coda» col `sessionId`
   * e la scadenza, oppure il rifiuto se l'attesa non può partire.
   */
  async enqueue(req: SpawnRequest, plan: OkPlan): Promise<SpawnReply> {
    const projectId = this.deps.projectId();
    if (this.stopped || projectId === null) {
      return { ok: false, reason: refuseReason(projectId ?? 'progetto senza id') };
    }
    const item: Item = {
      seq: ++this.seq,
      req,
      plan,
      sessionId: this.newSessionId(),
      expiresAtMs: this.now() + this.ttlMs,
      label: spawnLabel(req, plan),
      state: 'waiting',
      gen: 0,
      stopAwait: () => {},
    };
    const early = await this.probe(item, projectId);
    if (early !== null) {
      if (!('word' in early) || early.word !== 'si') return { ok: false, reason: queueRefusal(early, projectId) };
      // Il focus è tornato fra il `no` e l'attesa: la richiesta è già pronta,
      // e la risposta resta «in coda», vera — la tab nasce subito dopo.
      item.state = 'ready';
    }
    this.items.push(item);
    const at = clockOf(item.expiresAtMs);
    this.deps.note(`⏳ ${item.label} in coda: la tab nasce quando una finestra del progetto torna in focus (scade alle ${at})`);
    if (item.state === 'ready') this.focusArrived();
    return {
      ok: false,
      reason:
        `in coda: finestra del progetto non in focus (${projectId}), ` +
        `la tab nasce quando una finestra del progetto torna in focus (scade alle ${at})`,
      queued: {
        sessionId: item.sessionId,
        task: req.task,
        kind: plan.kind,
        model: plan.model,
        prompt: plan.prompt,
        regia: plan.regia?.regia ?? null,
        expiresAt: new Date(item.expiresAtMs).toISOString(),
      },
    };
  }

  /** Il deck si chiude: ogni attesa si interrompe, e compass ritira le sue
   *  notifiche. Nessuna notifica del deck: la coda muore col deck (P6). */
  stop(): void {
    this.stopped = true;
    for (const item of this.items) this.interrupt(item);
    this.items = [];
  }

  /** Lancia l'attesa e aspetta fino a `probeMs` una risposta immediata.
   *  → la risposta, o `null` se l'attesa è ancora aperta. */
  private probe(item: Item, projectId: string): Promise<CompassReply | null> {
    return new Promise((resolve) => {
      let probing = true;
      const timer = setTimeout(() => {
        probing = false;
        resolve(null);
      }, this.probeMs);
      this.launch(item, projectId, (r) => {
        if (!probing) return false;
        probing = false;
        clearTimeout(timer);
        resolve(r);
        return true;
      });
    });
  }

  /** Apre un'attesa per la richiesta, con la scadenza che le resta.
   *  `intercept` vede la risposta per primo: la sonda della messa in coda. */
  private launch(item: Item, projectId: string, intercept?: (r: CompassReply) => boolean): void {
    const gen = ++item.gen;
    const deadlineS = Math.max(1, Math.ceil((item.expiresAtMs - this.now()) / 1000));
    item.stopAwait = this.deps.awaitFocus(projectId, spawnNotice(item.label), deadlineS, (r) => {
      if (gen !== item.gen) return;
      if (intercept?.(r)) return;
      this.onAwait(item, r);
    });
  }

  /** Interrompe l'attesa in corso: la sua risposta, se arriva, si ignora. */
  private interrupt(item: Item): void {
    item.gen++;
    item.stopAwait();
    item.stopAwait = () => {};
  }

  private onAwait(item: Item, r: CompassReply): void {
    if (this.stopped || !this.items.includes(item)) return;
    if ('word' in r && r.word === 'si') {
      this.focusArrived();
      return;
    }
    // Ogni fine senza focus, a scadenza passata, è la scadenza: anche il
    // timeout del `gdbus call` che la segue di `AWAIT_MARGIN_S`.
    if (this.now() >= item.expiresAtMs || ('word' in r && r.word === 'scaduta')) {
      this.expire(item);
      return;
    }
    this.drop(item, awaitFailure(r));
  }

  /** Il focus è del progetto: TUTTE le richieste in coda diventano pronte, non
   *  solo quella la cui attesa ha risposto (P4) — aspettano la stessa cosa,
   *  e così l'ordine d'apertura resta quello d'arrivo. Le attese ancora
   *  aperte si interrompono: compass le avrebbe chiuse allo stesso focus. */
  private focusArrived(): void {
    for (const item of this.items) {
      if (item.state === 'ready') continue;
      this.interrupt(item);
      item.state = 'ready';
    }
    void this.drain();
  }

  /** Apre le richieste pronte una alla volta, in ordine d'arrivo. */
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.items.find((i) => i.state === 'ready');
        if (!next) break;
        if (this.now() >= next.expiresAtMs) {
          this.expire(next);
          continue;
        }
        const check = await this.deps.recheck();
        if (this.stopped) break;
        if (!this.items.includes(next)) continue;
        if ('refuse' in check) {
          // L'utente è già andato via: le pronte tornano in attesa.
          this.rewait();
          break;
        }
        if ('warning' in check || 'locked' in check) {
          // Dopo un `no` non si apre alla cieca: senza compass la finestra
          // non si sa, e la richiesta muore.
          const why = 'warning' in check ? check.warning : check.locked;
          for (const item of this.items.filter((i) => i.state === 'ready')) {
            this.drop(item, `finestra non verificabile all'apertura: ${why}`);
          }
          continue;
        }
        const plan = this.deps.replan(next.req);
        if (!plan.ok) {
          this.drop(next, plan.reason);
          continue;
        }
        this.remove(next);
        const r = await this.deps.open(next.req, next.plan, next.sessionId);
        if (r.ok) {
          this.deps.note(`✔ ${next.label} aperta dalla coda (${next.sessionId.slice(0, 8)})`);
        } else {
          this.deps.note(`⚠ ${next.label} dalla coda, tab non aperta: ${r.reason}`);
          this.deps.notify(QUEUE_NOTIFY_TITLE, `${this.deps.name()}: ${next.label}, tab non aperta — ${r.reason}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Le richieste pronte tornano ad aspettare il focus, con la scadenza che
   *  resta a ciascuna. */
  private rewait(): void {
    const projectId = this.deps.projectId();
    for (const item of this.items.filter((i) => i.state === 'ready')) {
      if (projectId === null) {
        this.drop(item, 'progetto senza id in .claude/loom-works.json');
        continue;
      }
      item.state = 'waiting';
      this.launch(item, projectId);
    }
  }

  private remove(item: Item): void {
    this.interrupt(item);
    this.items = this.items.filter((i) => i !== item);
  }

  /** La scadenza: nessuna tab, una nota e una notifica (D1). */
  private expire(item: Item): void {
    this.remove(item);
    this.deps.note(`⌛ ${item.label} scaduta in coda: nessuna tab aperta`);
    this.deps.notify(QUEUE_NOTIFY_TITLE, `${this.deps.name()}: ${item.label} scaduto dopo ${this.ttlMinutes()} min in coda — nessuna tab aperta`);
  }

  /** Una fine diversa dalla scadenza: nessuna tab, il motivo in nota e in
   *  notifica (P2 preflight). */
  private drop(item: Item, why: string): void {
    this.remove(item);
    this.deps.note(`⚠ ${item.label} tolto dalla coda: ${why}`);
    this.deps.notify(QUEUE_NOTIFY_TITLE, `${this.deps.name()}: ${item.label} annullato — ${why}`);
  }

  private ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}
