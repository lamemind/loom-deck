// T204 — dalla RICHIESTA di chiusura alla fine del processo: una conversazione
// chiede al deck del progetto di chiudere una conversazione viva, e il deck
// risponde dopo averne verificato la fine.
//
// Chiudere vuol dire terminare il processo `claude`, non agire sulla tab: la tab
// si chiude da sé quando il suo programma esce — su Linux Ptyxis applica
// l'`exit-action` del profilo, su Windows Windows Terminal il `closeOnExit` del
// profilo `loom-deck`. Il transcript resta su disco, e la conversazione si
// riprende dal deck come ogni altra chiusa.
//
// Le guardie, nell'ordine in cui scattano:
//
//  1. la piattaforma ha la liveness — senza, la mappa delle vive è vuota per
//     costruzione, e «nessuna viva» sarebbe una risposta falsa;
//  2. il bersaglio è UNA viva del progetto — `sessionId` intero o prefisso
//     (P1 preflight). T206 — una conversazione col turno headless in corso non
//     è una viva: non c'è una tab da chiudere, e la risposta dice il motivo
//     vero invece di «nessuna viva»;
//  3. non è la conversazione che chiede (P2);
//  4. è nata da una richiesta `spawn` sull'endpoint (D2): le conversazioni
//     aperte a mano le chiude solo l'umano;
//  5. è ferma: `idle`, o `waiting` su un permesso che nessuno darà (D3).
//     `busy` e `shell` si rifiutano, e nessuna forzatura.
//
// Nessuno stato React e nessun processo vero: la terminazione per piattaforma
// arriva come dipendenza (`Terminator`), come il resto.
import type { LiveSession } from './live-sessions.js';
import type { CloseReply, CloseRequest } from './spawn-endpoint.js';

/** Quanto il deck aspetta la fine del processo dopo averlo terminato. Su Linux
 *  `claude` ha impiegato fino a 6,6 s a uscire dopo il SIGHUP con la macchina
 *  carica: un'attesa stretta risponderebbe «non terminato» su un processo che
 *  sta uscendo. Il client aspetta di più (`REPLY_TIMEOUT_MS`): il motivo di
 *  un'attesa scaduta lo dice il deck, non il timeout del client. */
export const CLOSE_WAIT_MS = 30_000;

/** Ogni quanto si rimisura la liveness durante l'attesa. */
export const CLOSE_POLL_MS = 200;

/**
 * Gli stati del registro in cui una conversazione si chiude (D3 preflight): una
 * lista di valori AMMESSI, non di esclusi. Un valore che una versione futura del
 * CLI introducesse resta fuori finché qualcuno non lo aggiunge qui.
 *
 * `waiting` è la conversazione ferma su una domanda o su un permesso: chiusa da
 * una regia che l'ha abbandonata, nessuno risponderebbe mai.
 */
export const CLOSABLE_STATES: readonly string[] = ['idle', 'waiting'];

/** La terminazione di una conversazione su una piattaforma. */
export interface Terminator {
  /** Come la risposta nomina la terminazione (`SIGHUP`). */
  how: string;
  /** Avvia la terminazione del processo della conversazione. `null` = partita;
   *  una stringa = il motivo per cui non è partita. */
  terminate(target: LiveSession): string | null;
  /** Il processo della conversazione esiste ancora, ed è ancora lei. */
  alive(target: LiveSession): boolean;
}

export interface CloseRequestDeps {
  /** Il motivo per cui la chiusura è spenta su questa piattaforma, o `null`. */
  closeOff: () => string | null;
  /** La terminazione della piattaforma, o il motivo per cui non c'è. */
  terminator: () => Terminator | { off: string };
  /** Le vive del progetto ADESSO, lette dal registro al momento della
   *  richiesta: la mappa del poll può avere un giro di ritardo. */
  live: () => ReadonlyMap<string, LiveSession>;
  /** T206 — i turni headless in corso del progetto, letti allo stesso modo.
   *  Servono solo al rifiuto: un turno headless non si chiude da qui. */
  headless?: () => ReadonlyMap<string, LiveSession>;
  /** Dal sidecar: le conversazioni nate dall'endpoint e i binding alle task. */
  sidecar: () => { endpointBorn: ReadonlySet<string>; bindings: ReadonlyMap<string, string> };
  /** Ritira la marca `live` della conversazione chiusa (P3 preflight). */
  retire: (sessionId: string) => void;
  /** Le chiusure in corso, per `sessionId`: condiviso fra le richieste. */
  inFlight?: Set<string>;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const short = (id: string) => id.slice(0, 8);

export async function handleCloseRequest(req: CloseRequest, deps: CloseRequestDeps): Promise<CloseReply> {
  const off = deps.closeOff();
  if (off) return { ok: false, reason: off };
  const term = deps.terminator();
  if ('off' in term) return { ok: false, reason: term.off };

  const side = deps.sidecar();
  const found = resolveTarget(req.session, deps.live());
  if ('none' in found) {
    // T206 — prima di «nessuna viva»: un turno headless in corso. Il processo
    // c'è, ma non ha una tab, e lo chiude la fine del turno; chi lo vuole
    // fermare prima ha il pid.
    const turn = deps.headless ? resolveTarget(req.session, deps.headless()) : null;
    if (turn && 'target' in turn) {
      const pid = turn.target.pid;
      return {
        ok: false,
        reason: `${short(turn.target.sessionId)}: turno headless in corso (pid ${pid}): finisce da solo, si ferma con kill ${pid}`,
      };
    }
    // Il sidecar distingue «chiusa» da «di nessuno qui»: una conversazione nata
    // dall'endpoint di questo progetto e non più viva è già stata chiusa.
    const born = [...side.endpointBorn].some((id) => id.startsWith(req.session));
    return {
      ok: false,
      reason: born
        ? `${short(req.session)}: la conversazione non è viva (già chiusa)`
        : `${short(req.session)}: nessuna conversazione viva di questo progetto con questo id`,
    };
  }
  if ('ambiguous' in found) {
    return {
      ok: false,
      reason: `prefisso ambiguo ${req.session}: ${found.ambiguous.length} vive (${found.ambiguous.map(short).join(', ')}), serve il sessionId intero`,
    };
  }

  const t = found.target;
  const id = short(t.sessionId);
  if (req.from === t.sessionId) return { ok: false, reason: `${id}: è la conversazione che chiede la chiusura` };
  if (!side.endpointBorn.has(t.sessionId)) {
    return { ok: false, reason: `${id}: non è nata da una richiesta spawn sull'endpoint del deck, la chiude solo l'utente` };
  }
  const blocked = stateProblem(t.state);
  if (blocked) return { ok: false, reason: `${id}: ${blocked}` };

  const inFlight = deps.inFlight ?? new Set<string>();
  if (inFlight.has(t.sessionId)) return { ok: false, reason: `${id}: chiusura già in corso` };
  inFlight.add(t.sessionId);
  try {
    return await terminateAndWait(t, term, side.bindings.get(t.sessionId) ?? null, deps);
  } finally {
    inFlight.delete(t.sessionId);
  }
}

async function terminateAndWait(
  t: LiveSession,
  term: Terminator,
  task: string | null,
  deps: CloseRequestDeps,
): Promise<CloseReply> {
  const id = short(t.sessionId);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? CLOSE_WAIT_MS;
  const pollMs = deps.pollMs ?? CLOSE_POLL_MS;

  const t0 = now();
  const failed = term.terminate(t);
  // Una terminazione che non parte su un processo già finito (morto fra la
  // lettura del registro e il segnale) non è un rifiuto: la conversazione è
  // chiusa, e la marca va ritirata come per ogni altra.
  if (failed && term.alive(t)) return { ok: false, reason: `${id}: terminazione non partita (${failed})` };

  while (term.alive(t)) {
    if (now() - t0 >= waitMs) {
      return {
        ok: false,
        reason: `${id}: processo ${t.pid} non terminato entro ${Math.round(waitMs / 1000)} s dopo ${term.how}, la conversazione resta aperta`,
        sessionId: t.sessionId,
        pid: t.pid,
      };
    }
    await sleep(pollMs);
  }

  const ms = now() - t0;
  const base = { ok: true as const, sessionId: t.sessionId, pid: t.pid, task, how: term.how, ms };
  try {
    deps.retire(t.sessionId);
  } catch (e) {
    // Il processo è finito comunque: la risposta lo dice, e dice anche che il
    // restore delle vive potrebbe riaprirla.
    return { ...base, warning: `marca live non ritirata (${e instanceof Error ? e.message : String(e)}): il restore potrebbe riaprirla` };
  }
  return base;
}

type Resolved = { target: LiveSession } | { none: true } | { ambiguous: string[] };

/** Il bersaglio fra le vive del progetto: il `sessionId` intero, o l'unica viva
 *  il cui `sessionId` comincia col prefisso. */
export function resolveTarget(session: string, live: ReadonlyMap<string, LiveSession>): Resolved {
  const exact = live.get(session);
  if (exact) return { target: exact };
  const matches = [...live.values()].filter((l) => l.sessionId.startsWith(session));
  if (matches.length === 0) return { none: true };
  if (matches.length > 1) return { ambiguous: matches.map((m) => m.sessionId).sort() };
  return { target: matches[0]! };
}

/** Il motivo per cui una conversazione in questo stato del registro non si
 *  chiude, o `null` se si chiude. */
export function stateProblem(state: string): string | null {
  if (CLOSABLE_STATES.includes(state)) return null;
  if (state === 'busy') return 'sta lavorando (busy): si chiude solo ferma';
  if (state === 'shell') return 'sta eseguendo un comando (shell): si chiude solo ferma';
  if (!state) return 'il registro non scrive lo stato della conversazione, chiusura rifiutata';
  return `stato del registro «${state}» non previsto, chiusura rifiutata`;
}
