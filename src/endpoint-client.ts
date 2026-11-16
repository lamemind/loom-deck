// T204 — lo SCAMBIO col deck, lato client: una connessione, una riga di
// richiesta, una riga di risposta. Lo usano i due comandi del pacchetto che
// parlano con l'endpoint, `loom-deck-spawn` (T196) e `loom-deck-close` (T204)
// (P6 preflight): due copie del trasporto darebbero due classificazioni diverse
// degli stessi errori, e la skill che legge le uscite non saprebbe più cosa vuol
// dire un 3.
import net from 'node:net';
import { addressProblem, type Endpoint, type EndpointRequest } from './spawn-endpoint.js';

/** Quanto il client aspetta la risposta. Più largo di ogni attesa del deck —
 *  l'annuncio di `deck-run` (15 s), la fine del processo chiuso (10 s) —, così
 *  il motivo di un ritardo lo dice il deck. */
export const REPLY_TIMEOUT_MS = 30_000;

/** Ciò che un client riceve dal mondo: cartella, env, piattaforma e i due
 *  flussi. Un valore e non `process`, così il test esegue il client intero. */
export interface ClientIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  timeoutMs?: number;
}

/** L'esito di uno scambio: la risposta del deck, nessuno in ascolto, o un
 *  guasto della connessione. */
export type Outcome<R> = { reply: R } | { unreachable: string } | { failed: string };

/** Errori di connessione che vogliono dire «nessuno ascolta qui»: niente file
 *  o pipe (`ENOENT`), socket orfano di un deck morto (`ECONNREFUSED`). */
const UNREACHABLE = new Set(['ENOENT', 'ECONNREFUSED']);

export function exchange<R extends { ok: boolean }>(
  ep: Endpoint,
  request: EndpointRequest,
  timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<Outcome<R>> {
  // Un path troppo lungo si troncherebbe in silenzio, e la richiesta potrebbe
  // arrivare al deck di un altro progetto (`SOCKET_PATH_MAX`).
  const tooLong = addressProblem(ep);
  if (tooLong) return Promise.resolve({ failed: tooLong });
  return new Promise((resolve) => {
    const socket = net.connect(ep.address);
    let buf = '';
    let settled = false;
    const settle = (o: Outcome<R>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(o);
    };
    const timer = setTimeout(
      () => settle({ failed: `nessuna risposta dal deck entro ${Math.round(timeoutMs / 1000)} s` }),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) settle(parseReply<R>(buf.slice(0, nl)));
    });
    socket.on('end', () =>
      settle(buf ? parseReply<R>(buf) : { failed: 'il deck ha chiuso la connessione senza rispondere' }),
    );
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code ?? String(e);
      settle(UNREACHABLE.has(code) ? { unreachable: code } : { failed: `connessione al deck fallita (${code})` });
    });
  });
}

function parseReply<R extends { ok: boolean }>(line: string): Outcome<R> {
  try {
    const r = JSON.parse(line) as R;
    if (r && typeof r === 'object' && typeof r.ok === 'boolean') return { reply: r };
  } catch {
    // sotto
  }
  return { failed: `risposta del deck illeggibile: ${line.slice(0, 200)}` };
}
