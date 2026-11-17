// T196 — il SERVER dell'endpoint: ascolta sull'indirizzo del progetto, legge una
// riga di richiesta per connessione, la consegna a un gestore e scrive la sua
// risposta sulla stessa connessione.
//
// Non sa cosa sia uno spawn né una chiusura: il gestore di ogni verbo arriva da
// fuori (`endpoint-spawn.ts`, `endpoint-close.ts`, cablati dal deck in
// `overlays/endpoint.ts`), e qui la riga si smista per `verb`. Il resto sono le
// regole del trasporto, che sono diverse per piattaforma:
//
//  - Windows — una named pipe muore col processo che la tiene aperta: niente da
//    pulire dopo un deck ucciso a forza, e un secondo deck sullo stesso nome
//    riceve `EADDRINUSE` (misurato, sonda della task folder di T196).
//  - Linux — un socket Unix è un FILE, e sopravvive a un `kill -9` e al SIGHUP
//    di una tab chiusa: chi chiama riceve `ECONNREFUSED`. Prima di ascoltare,
//    quindi, si chiama l'indirizzo: risponde → c'è un deck vivo, e questo non
//    ascolta; rifiutato → file orfano, e questo ascolta al suo posto (misurato,
//    stessa sonda).
//
// T216 — su Linux il socket non nasce sull'indirizzo: nasce su un path privato
// del processo e ci arriva con un `rename`, che sostituisce l'orfano in un colpo
// solo. Il motivo è la chiusura: libuv, alla `close()` di un server, cancella il
// path su cui il server ha fatto `listen`, chiunque ci sia adesso. Due deck in
// attesa possono prendere l'indirizzo uno dopo l'altro (prova e presa non sono
// un'operazione sola), e il deck che ha perso il file, chiudendo, cancellerebbe
// quello del vincitore (misurato, T216). Col path privato la `close()` cancella
// solo quello, già sparito, e il file dell'indirizzo lo toglie questo modulo, e
// solo se ha ancora l'inode del proprio socket.
import net from 'node:net';
import { existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync, type BigIntStats } from 'node:fs';
import { posix } from 'node:path';
import {
  REQUEST_MAX_BYTES,
  addressProblem,
  parseEndpointRequest,
  type CloseReply,
  type CloseRequest,
  type Endpoint,
  type EndpointReply,
  type SpawnReply,
  type SpawnRequest,
} from './spawn-endpoint.js';

/** Una connessione che non manda la sua riga entro questo tempo si chiude: un
 *  client appeso non deve tenere un descrittore del deck per sempre. */
const IDLE_MS = 10_000;

/** Quanto aspetta la chiamata di prova su un socket esistente. Un deck vivo
 *  accetta in millisecondi; il timeout esiste per un file che non è un socket. */
const PROBE_MS = 1_000;

export type ListenResult =
  /** `close` risolve quando il server ha chiuso anche le connessioni ancora
   *  aperte: su Windows il nome della pipe resta occupato finché ne esiste
   *  un'istanza, quindi un `listen` sullo stesso nome subito dopo un `close`
   *  non atteso riceve `EADDRINUSE`. Chi riapre nello stesso processo (i test,
   *  il guardiano dopo un file perso) lo attende.
   *
   *  `owns` dice se l'indirizzo porta ancora a questo server: su Linux il file
   *  dell'indirizzo ha l'inode del socket di questo server; su Windows è sempre
   *  vero, perché il sistema dà il nome della pipe a un processo solo. */
  | { state: 'listening'; close: () => Promise<void>; owns: () => boolean }
  /** Un altro deck ascolta già sullo stesso indirizzo: lo stesso progetto
   *  aperto due volte. */
  | { state: 'busy' }
  | { state: 'failed'; reason: string };

/** Un gestore per verbo. Il server sceglie quello del `verb` della riga, già
 *  validata nella forma del suo verbo (`parseEndpointRequest`). */
export interface RequestHandlers {
  spawn: (req: SpawnRequest) => Promise<SpawnReply>;
  close: (req: CloseRequest) => Promise<CloseReply>;
}

/** Il gestore della sola richiesta di spawn: la forma di T196, che un chiamante
 *  con un verbo solo può ancora passare. Un `close` gli arriva come rifiuto. */
export type RequestHandler = RequestHandlers['spawn'];

function handlersOf(h: RequestHandler | RequestHandlers): RequestHandlers {
  if (typeof h !== 'function') return h;
  return { spawn: h, close: async () => ({ ok: false, reason: 'verbo close non servito da questo deck' }) };
}

/** Avvia l'endpoint. Non lancia mai: ogni esito torna come valore, perché un
 *  endpoint che non parte non deve far cadere il deck — il deck resta usabile
 *  dai tasti anche senza. */
export async function listenEndpoint(ep: Endpoint, handle: RequestHandler | RequestHandlers): Promise<ListenResult> {
  const handlers = handlersOf(handle);
  // T204 — un path troppo lungo verrebbe troncato in silenzio, e il deck
  // ascolterebbe su un indirizzo che può essere quello di un altro progetto.
  const tooLong = addressProblem(ep);
  if (tooLong) return { state: 'failed', reason: tooLong };
  // Windows: la pipe nasce sul suo nome. Linux: il socket nasce sul path privato.
  const bindAt = ep.dir === null ? ep.address : privateAddress(ep.dir);
  if (ep.dir !== null) {
    const privateTooLong = addressProblem({ ...ep, address: bindAt });
    if (privateTooLong) return { state: 'failed', reason: privateTooLong };
    const unsafe = prepareSocketDir(ep.dir);
    if (unsafe) return { state: 'failed', reason: unsafe };
    if (existsSync(ep.address) && (await isAlive(ep.address))) return { state: 'busy' };
    // Un resto lasciato da un deck morto con lo stesso pid fra `listen` e
    // `rename`: il nome privato è solo di questo processo, toglierlo non tocca
    // nessun altro.
    try {
      unlinkSync(bindAt);
    } catch {
      // non c'era
    }
  }
  const server = net.createServer((socket) => serveConnection(socket, handlers));
  return new Promise((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      resolve(e.code === 'EADDRINUSE' ? { state: 'busy' } : { state: 'failed', reason: e.code ?? String(e) });
    });
    server.listen(bindAt, () => {
      let mine: BigIntStats | null = null;
      if (ep.dir !== null) {
        try {
          mine = statSync(bindAt, { bigint: true });
          // Atomico: un orfano sull'indirizzo sparisce nello stesso colpo.
          renameSync(bindAt, ep.address);
        } catch (e) {
          server.close();
          resolve({ state: 'failed', reason: `socket non portato sull'indirizzo (${(e as NodeJS.ErrnoException).code})` });
          return;
        }
      }
      const owns = () => mine === null || sameFile(ep.address, mine);
      // Il file dell'indirizzo si toglie solo se è ancora il nostro: dopo una
      // gara persa è il socket di un altro deck.
      const release = () => {
        if (ep.dir === null || !owns()) return;
        try {
          unlinkSync(ep.address);
        } catch {
          // già sparito
        }
      };
      // L'uscita del processo non chiude il server: un `process.exit` (il
      // doppio `^C` del deck) lascerebbe un orfano che il prossimo avvio
      // dovrebbe riconoscere. Il listener lo toglie prima, sincrono come
      // l'evento `exit` richiede. Il SIGHUP di una tab chiusa termina il
      // processo senza `exit`: quell'orfano lo toglie il deck che subentra.
      process.once('exit', release);
      resolve({
        state: 'listening',
        owns,
        close: () =>
          new Promise<void>((done) => {
            process.off('exit', release);
            release();
            server.close(() => done());
          }),
      });
    });
  });
}

let privateSeq = 0;

/** Il path su cui nasce il socket prima di arrivare sull'indirizzo: nella stessa
 *  cartella, perché `rename` non attraversa i filesystem; col pid, perché un
 *  altro deck non lo usi mai. Corto, perché sta sotto lo stesso limite di byte. */
function privateAddress(dir: string): string {
  return posix.join(dir, `.${process.pid}-${++privateSeq}.bind`);
}

function sameFile(path: string, st: BigIntStats): boolean {
  try {
    const now = statSync(path, { bigint: true });
    return now.ino === st.ino && now.dev === st.dev;
  } catch {
    return false;
  }
}

// ── Il guardiano ───────────────────────────────────────────────────────────
//
// T216 — un deck che trova l'endpoint occupato non si ferma lì: ritenta a ogni
// giro, e subentra quando l'altro deck si chiude. Il ritentativo è la stessa
// `listenEndpoint`, quindi la stessa prova e lo stesso orfano sostituito.
//
// Sta qui e non nell'hook del deck perché i suoi casi — timer fermato, `listen`
// in volo allo smontaggio, file perso nella gara — si provano su `node:test`
// senza React.

/** Ciò che il guardiano racconta a chi lo ha avviato. Ogni evento è un cambio
 *  di stato: un deck in attesa non ne riceve uno a ogni giro. */
export type KeeperEvent =
  /** In ascolto: al primo colpo (`waited: false`) o dopo un'attesa. */
  | { kind: 'listening'; waited: boolean }
  /** Un altro deck ascolta: si ritenta a ogni giro, in silenzio. */
  | { kind: 'busy' }
  /** Linux: il file dell'indirizzo non è più il nostro, un altro deck l'ha
   *  preso nella gara. Il nostro server si chiude e si torna in attesa. */
  | { kind: 'lost' }
  /** Un motivo che non cambia da un giro all'altro: nessun ritentativo. */
  | { kind: 'failed'; reason: string };

export interface EndpointKeeper {
  /** Ferma il timer e chiude il server, anche quello di un `listen` ancora in
   *  volo. Risolve quando non resta niente aperto; dopo, nessun evento. */
  stop: () => Promise<void>;
}

type Listening = Extract<ListenResult, { state: 'listening' }>;

/**
 * Ascolta sull'indirizzo e lo tiene. Su `busy` ritenta ogni `intervalMs`; in
 * ascolto, su Linux, controlla ogni `intervalMs` che il file dell'indirizzo sia
 * ancora il suo, e se non lo è torna in attesa (D1 del preflight di T216). Un
 * `failed` ferma tutto.
 *
 * Il giro dopo parte quando il precedente è finito, mai sopra: una prova può
 * durare fino a `PROBE_MS`, più di un giro.
 */
export function keepEndpoint(
  ep: Endpoint,
  handle: RequestHandler | RequestHandlers,
  intervalMs: number,
  onEvent: (e: KeeperEvent) => void,
): EndpointKeeper {
  let stopped = false;
  /** Dopo un `busy` o un file perso: il prossimo `listening` è un subentro, e
   *  un altro `busy` non si racconta. */
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Listening | null = null;
  /** I `listen` in volo e le chiusure non ancora finite: `stop` li attende. */
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>) => {
    pending.add(p);
    const drop = () => void pending.delete(p);
    p.then(drop, drop);
  };
  const later = (step: () => void) => {
    timer = setTimeout(() => {
      timer = null;
      step();
    }, intervalMs);
  };

  const settle = async (r: ListenResult) => {
    if (stopped) {
      // Smontato mentre `listen` era in volo: il server appena aperto si chiude.
      if (r.state === 'listening') await r.close();
      return;
    }
    if (r.state === 'listening') {
      current = r;
      onEvent({ kind: 'listening', waited: waiting });
      waiting = false;
      if (ep.dir !== null) later(watch);
    } else if (r.state === 'busy') {
      if (!waiting) onEvent({ kind: 'busy' });
      waiting = true;
      later(attempt);
    } else {
      onEvent({ kind: 'failed', reason: r.reason });
    }
  };

  function attempt() {
    track(
      listenEndpoint(ep, handle)
        .catch((e): ListenResult => ({ state: 'failed', reason: String(e) }))
        .then(settle),
    );
  }

  function watch() {
    const mine = current;
    if (stopped || mine === null) return;
    if (mine.owns()) {
      later(watch);
      return;
    }
    current = null;
    waiting = true;
    onEvent({ kind: 'lost' });
    // `close` non tocca il file dell'altro deck: non è più il nostro.
    track(mine.close());
    later(attempt);
  }

  attempt();
  return {
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const mine = current;
      current = null;
      if (mine !== null) track(mine.close());
      await Promise.allSettled([...pending]);
    },
  };
}

/**
 * La cartella dei socket esiste, è dell'utente e nessun altro ci entra.
 * Restituisce il motivo per cui NON lo è, o `null`.
 *
 * Il controllo vale anche per `$XDG_RUNTIME_DIR`, dove è sempre vero, perché il
 * ripiego sulla temporanea condivisa no: lì un altro utente può aver creato la
 * cartella prima, e un socket dentro una cartella altrui si può sostituire.
 */
function prepareSocketDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) return `${dir} non è una cartella`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    if (st.uid !== uid) return `${dir} non appartiene all'utente`;
    if ((st.mode & 0o077) !== 0) return `${dir} è accessibile ad altri utenti`;
    return null;
  } catch (e) {
    return `cartella dei socket non creabile (${(e as NodeJS.ErrnoException).code})`;
  }
}

/** Qualcuno accetta connessioni sull'indirizzo. La prova si chiude senza
 *  mandare niente: il deck vivo vede una connessione vuota e la lascia cadere. */
function isAlive(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(address);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function serveConnection(socket: net.Socket, handlers: RequestHandlers) {
  socket.setEncoding('utf8');
  socket.setTimeout(IDLE_MS, () => socket.destroy());
  // Un client che chiude a metà, o la prova di `isAlive`: errore sulla
  // connessione, non sul deck.
  socket.on('error', () => {});
  let buffer = '';
  let taken = false;
  socket.on('data', (chunk: string) => {
    if (taken) return;
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl < 0) {
      if (Buffer.byteLength(buffer) > REQUEST_MAX_BYTES) {
        taken = true;
        reply(socket, { ok: false, reason: 'richiesta oltre la dimensione massima' });
      }
      return;
    }
    taken = true;
    // La risposta arriva quando lo spawn è partito o il processo chiuso è
    // finito, cioè secondi dopo: il timeout d'inattività vale per l'attesa
    // della richiesta, non per il lavoro del deck.
    socket.setTimeout(0);
    const parsed = parseEndpointRequest(buffer.slice(0, nl));
    if ('error' in parsed) {
      reply(socket, { ok: false, reason: parsed.error });
      return;
    }
    const pending: Promise<EndpointReply> =
      parsed.verb === 'close' ? handlers.close(parsed) : handlers.spawn(parsed);
    pending.then(
      (r) => reply(socket, r),
      (e) => reply(socket, { ok: false, reason: `errore del deck: ${String(e)}` }),
    );
  });
}

function reply(socket: net.Socket, r: EndpointReply) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(r)}\n`);
}
