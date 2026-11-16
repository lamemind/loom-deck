// T204 — `loom-deck-close`, il CLIENT della chiusura: una conversazione Claude
// Code chiede al deck del proprio progetto di chiudere una conversazione viva
// aperta da una richiesta `spawn`, e il deck risponde quando il processo è
// finito.
//
// Un comando a sé e non un sottocomando di `loom-deck-spawn` (P6 preflight): su
// un deck 0.87.0 il sottocomando darebbe un errore d'uso fuorviante, e il nome
// direbbe il contrario di ciò che fa. Un deck più vecchio non ha questo
// comando, e la shell risponde 127.
//
// Una richiesta per invocazione, nessuna domanda e nessuna conferma: la
// decisione è già avvenuta nella conversazione che chiama.
//
// Uscite, allineate a `loom-deck-spawn`:
//   0  conversazione chiusa: processo finito, verificato dal deck
//   1  il deck ha rifiutato, il processo non è finito entro l'attesa, o il deck
//      non ha risposto in tempo
//   2  errore d'uso, nessuna richiesta partita
//   3  nessun deck in ascolto sull'indirizzo del progetto
//
// La logica sta qui e l'ingresso in `loom-deck-close.ts`, così il test esegue il
// client intero contro un server vero senza lanciare un processo.
import { exchange, REPLY_TIMEOUT_MS, type ClientIo } from './endpoint-client.js';
import {
  CLOSE_SINCE,
  ENDPOINT_SINCE,
  SESSION_PREFIX_MIN,
  endpointFor,
  normalizeSession,
  type CloseReply,
  type CloseRequest,
} from './spawn-endpoint.js';
import { findProjectRoot } from './tab-launch.js';

export const CLOSE_USAGE = `uso: loom-deck-close <sessionId> [--root <dir>]

Chiede al deck acceso sul progetto di chiudere una conversazione viva aperta da
una richiesta spawn (loom-deck-spawn): il processo claude termina, la tab si
chiude, il transcript resta e la conversazione si riprende dal deck.

  <sessionId>  intero, o prefisso di almeno ${SESSION_PREFIX_MIN} caratteri che indica una sola viva
  --root       root del progetto (assente = risalita dalla cartella corrente
               fino a .claude/loom-works.json)

Il deck rifiuta la conversazione che chiede, una conversazione aperta a mano e
una che sta lavorando.

Uscite: 0 chiusa · 1 rifiuto, processo non terminato o nessuna risposta dal
deck · 2 errore d'uso · 3 nessun deck in ascolto sul progetto`;

export type CloseArgs = { session: string; root: string | null } | { usage: string[] } | { help: true };

/** L'argv del client, validato. Puro: nessun disco, nessuna rete. */
export function parseCloseArgs(argv: readonly string[]): CloseArgs {
  const positional: string[] = [];
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) return { usage: ['--root senza valore'] };
      root = v;
      i++;
      continue;
    }
    if (a.startsWith('--')) return { usage: [`opzione ignota: ${a}`] };
    positional.push(a);
  }
  const [raw, ...extra] = positional;
  if (raw === undefined) return { usage: ['serve il <sessionId> della conversazione da chiudere'] };
  if (extra.length) return { usage: [`argomenti in più: ${extra.join(' ')}`] };
  const session = normalizeSession(raw);
  if (session === null) {
    return { usage: [`sessionId non valido: '${raw}' (intero, o prefisso di almeno ${SESSION_PREFIX_MIN} caratteri esadecimali)`] };
  }
  return { session, root };
}

/** Il `sessionId` di chi chiama, dall'env che Claude Code dà ai comandi della
 *  sessione: il deck rifiuta di chiudere chi chiede (P2 preflight). Fuori da una
 *  conversazione, o in una forma inattesa, non si manda. */
export function callerSession(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return normalizeSession(env.CLAUDE_CODE_SESSION_ID) ?? undefined;
}

export async function runCloseClient(argv: readonly string[], io: ClientIo): Promise<number> {
  const args = parseCloseArgs(argv);
  if ('help' in args) {
    io.stdout(`${CLOSE_USAGE}\n`);
    return 0;
  }
  if ('usage' in args) {
    for (const line of args.usage) io.stderr(`loom-deck-close: ${line}\n`);
    io.stderr(`${CLOSE_USAGE}\n`);
    return 2;
  }
  const root = args.root ?? findProjectRoot(io.cwd) ?? io.cwd;
  const ep = endpointFor(root, io.platform, io.env);
  const request: CloseRequest = { verb: 'close', session: args.session };
  const from = callerSession(io.env);
  if (from) request.from = from;
  const outcome = await exchange<CloseReply>(ep.address, request, io.timeoutMs ?? REPLY_TIMEOUT_MS);

  if ('unreachable' in outcome) {
    io.stderr(
      `loom-deck-close: nessun deck in ascolto per ${root} (${ep.address}, ${outcome.unreachable}).\n` +
        `Apri il deck del progetto, o aggiornalo: l'endpoint c'è da loom-deck ${ENDPOINT_SINCE}, la chiusura da ${CLOSE_SINCE}.\n`,
    );
    return 3;
  }
  if ('failed' in outcome) {
    io.stderr(`loom-deck-close: ${outcome.failed}\n`);
    return 1;
  }
  const r = outcome.reply;
  if (!r.ok) {
    // Un deck 0.87.0 ha l'endpoint ma non il verbo: lo dice con «verbo
    // ignoto», che da solo non nomina il rimedio.
    const old = /verbo ignoto/.test(r.reason) ? ` — il deck è più vecchio di loom-deck ${CLOSE_SINCE}: aggiornalo` : '';
    io.stderr(`loom-deck-close: il deck ha rifiutato: ${r.reason}${old}\n`);
    return 1;
  }
  const lines = [
    `✔ conversazione chiusa dal deck di ${root}`,
    `sessionId: ${r.sessionId}`,
    `task:      ${r.task ?? '(spot)'}`,
    `processo:  pid ${r.pid} · ${r.how} · finito in ${(r.ms / 1000).toFixed(1)} s`,
  ];
  if (r.warning) lines.push(`⚠ ${r.warning}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
