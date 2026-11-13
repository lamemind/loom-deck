// T196 — il SERVER dell'endpoint: ascolta sull'indirizzo del progetto, legge una
// riga di richiesta per connessione, la consegna a un gestore e scrive la sua
// risposta sulla stessa connessione.
//
// Non sa cosa sia uno spawn: il gestore arriva da fuori (`endpoint-spawn.ts`,
// cablato dal deck in `overlays/endpoint.ts`). Qui stanno solo le regole del
// trasporto, che sono diverse per piattaforma:
//
//  - Windows — una named pipe muore col processo che la tiene aperta: niente da
//    pulire dopo un deck ucciso a forza, e un secondo deck sullo stesso nome
//    riceve `EADDRINUSE` (misurato, sonda della task folder di T196).
//  - Linux — un socket Unix è un FILE, e sopravvive a un `kill -9`: chi chiama
//    riceve `ECONNREFUSED`, e un `listen` sul file esistente fallirebbe con
//    `EADDRINUSE` anche senza nessuno dietro. Prima di ascoltare, quindi, si
//    chiama l'indirizzo: risponde → c'è un deck vivo, e questo non ascolta;
//    rifiutato → file orfano, si cancella e si ascolta (misurato, stessa sonda).
import net from 'node:net';
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { REQUEST_MAX_BYTES, parseSpawnRequest, type Endpoint, type SpawnReply, type SpawnRequest } from './spawn-endpoint.js';

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
   *  non atteso riceve `EADDRINUSE`. Il deck ascolta una volta per processo e
   *  non lo attende; chi riapre nello stesso processo (i test) sì. */
  | { state: 'listening'; close: () => Promise<void> }
  /** Un altro deck ascolta già sullo stesso indirizzo: lo stesso progetto
   *  aperto due volte. */
  | { state: 'busy' }
  | { state: 'failed'; reason: string };

export type RequestHandler = (req: SpawnRequest) => Promise<SpawnReply>;

/** Avvia l'endpoint. Non lancia mai: ogni esito torna come valore, perché un
 *  endpoint che non parte non deve far cadere il deck — il deck resta usabile
 *  dai tasti anche senza. */
export async function listenEndpoint(ep: Endpoint, handle: RequestHandler): Promise<ListenResult> {
  if (ep.dir !== null) {
    const unsafe = prepareSocketDir(ep.dir);
    if (unsafe) return { state: 'failed', reason: unsafe };
    if (existsSync(ep.address)) {
      if (await isAlive(ep.address)) return { state: 'busy' };
      try {
        unlinkSync(ep.address);
      } catch (e) {
        return { state: 'failed', reason: `socket orfano non rimovibile (${(e as NodeJS.ErrnoException).code})` };
      }
    }
  }
  const server = net.createServer((socket) => serveConnection(socket, handle));
  return new Promise((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      resolve(e.code === 'EADDRINUSE' ? { state: 'busy' } : { state: 'failed', reason: e.code ?? String(e) });
    });
    server.listen(ep.address, () => {
      // Su Linux `server.close()` cancella il file del socket, l'uscita del
      // processo no: un `process.exit` (il doppio `^C` del deck) lascerebbe un
      // orfano che il prossimo avvio dovrebbe riconoscere. Il listener lo toglie
      // prima, sincrono come l'evento `exit` richiede.
      const onExit = () => {
        if (ep.dir === null) return;
        try {
          unlinkSync(ep.address);
        } catch {
          // già sparito
        }
      };
      process.once('exit', onExit);
      resolve({
        state: 'listening',
        close: () =>
          new Promise<void>((done) => {
            process.off('exit', onExit);
            server.close(() => done());
          }),
      });
    });
  });
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

function serveConnection(socket: net.Socket, handle: RequestHandler) {
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
    // La risposta arriva quando lo spawn è partito, cioè secondi dopo: il
    // timeout d'inattività vale per l'attesa della richiesta, non per lo spawn.
    socket.setTimeout(0);
    const parsed = parseSpawnRequest(buffer.slice(0, nl));
    if ('error' in parsed) {
      reply(socket, { ok: false, reason: parsed.error });
      return;
    }
    handle(parsed).then(
      (r) => reply(socket, r),
      (e) => reply(socket, { ok: false, reason: `errore del deck: ${String(e)}` }),
    );
  });
}

function reply(socket: net.Socket, r: SpawnReply) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(r)}\n`);
}
