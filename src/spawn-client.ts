// T196 — `loom-deck-spawn`, il CLIENT dell'endpoint del deck: una conversazione
// Claude Code chiede al deck del proprio progetto di aprire una conversazione
// su una task, e il deck la apre come col tasto.
//
// Un comando a sé del pacchetto e non un sottocomando di `loom-deck` (P4
// preflight): `loom-deck` ignora gli argomenti e avvia la TUI, quindi un deck
// vecchio chiamato con un sottocomando partirebbe come TUI dentro la Bash della
// conversazione, mentre un comando che manca risponde «command not found».
//
// Una richiesta per invocazione, nessuna domanda e nessuna conferma: la conferma
// è già avvenuta nella conversazione che chiama.
//
// Uscite:
//   0  tab aperta (o spawn inerte, se il deck gira col freno dei test)
//   1  il deck ha risposto con un rifiuto, o non ha risposto in tempo
//   2  errore d'uso, nessuna richiesta partita
//   3  nessun deck in ascolto sull'indirizzo del progetto
//   4  T229 — in coda: su Linux la finestra in focus non è del progetto, e la
//      tab nasce quando una finestra del progetto torna in focus. Lo stdout
//      porta già il `sessionId` della conversazione e l'ora di scadenza, non
//      il titolo, che `deck-run` compone allo spawn. Non `0` (P8 preflight):
//      `spawn-task` e la regia leggono `0` come «tab aperta, riga `titolo:`
//      presente». `4` è il primo codice libero: `0`–`3` li condivide
//      `loom-deck-close`
//
// La logica sta qui e l'ingresso in `loom-deck-spawn.ts`, così il test esegue il
// client intero contro un server vero senza lanciare un processo. Lo scambio sul
// socket sta in `endpoint-client.ts`, condiviso con `loom-deck-close` (T204).
import { exchange, REPLY_TIMEOUT_MS, type ClientIo } from './endpoint-client.js';
import { isModelKind, MODELS } from './spawn-catalog.js';
import {
  ENDPOINT_SINCE,
  endpointFor,
  normalizeSession,
  parseScope,
  requestKinds,
  type QueuedSpawn,
  type SpawnReply,
  type SpawnRequest,
} from './spawn-endpoint.js';
import { PROMPT_KINDS } from './tab-args.js';
import { findProjectRoot } from './tab-launch.js';

export const CLIENT_USAGE = `uso: loom-deck-spawn <TaskID> <kind> [perimetro] [--model <alias>] [--note <testo>] [--regia <perimetro>] [--root <dir>]

Chiede al deck acceso sul progetto di aprire una conversazione sulla task, come
il tasto del deck: stesso binding, titolo e modello (override di progetto
compreso).

  <kind>       ${requestKinds('endpoint').join(' | ')}
  [perimetro]  solo con run: DLV come in run-task, 1,3-5 (assente = tutti gli aperti)
  --model      ${MODELS.join(' | ')} (assente = il modello dell'azione nel deck)
  --note       nota del titolo della tab (assente = il titolo dell'azione)
  --regia      la regia che chiede, col suo perimetro (T<numero>, epica o
               mandato): la conversazione nasce con LOOM_REGIA, e il sidecar
               registra perimetro e sessione della regia
  --root       root del progetto (assente = risalita dalla cartella corrente
               fino a .claude/loom-works.json)

Uscite: 0 tab aperta · 1 rifiuto o nessuna risposta dal deck · 2 errore d'uso ·
3 nessun deck in ascolto sul progetto · 4 in coda: la tab nasce quando una
finestra del progetto torna in focus (sessionId e scadenza in stdout)`;

export { REPLY_TIMEOUT_MS, type ClientIo };

export type ClientArgs = { request: SpawnRequest; root: string | null } | { usage: string[] } | { help: true };

/**
 * L'argv del client, validato. Puro: nessun disco, nessuna rete.
 *
 * T220 — `env` serve solo con `--regia`: il `sessionId` della regia il client lo
 * legge da sé (`CLAUDE_CODE_SESSION_ID`, l'ambiente del tool Bash della
 * conversazione che chiama), invece di chiederlo come argomento che il modello
 * dovrebbe ricopiare a ogni comando (P1 preflight). Assente o malformato = il
 * campo non parte.
 */
export function parseClientArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ClientArgs {
  const positional: string[] = [];
  let model: string | undefined;
  let note: string | undefined;
  let regia: string | undefined;
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--model' || a === '--note' || a === '--regia' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) return { usage: [`${a} senza valore`] };
      i++;
      if (a === '--model') model = v;
      else if (a === '--note') note = v;
      else if (a === '--regia') regia = v;
      else root = v;
      continue;
    }
    if (a.startsWith('--')) return { usage: [`opzione ignota: ${a}`] };
    positional.push(a);
  }
  const [task, kind, scopeSpec, ...extra] = positional;
  if (!task || !kind) return { usage: ['servono <TaskID> e <kind>'] };
  if (extra.length) return { usage: [`argomenti in più: ${extra.join(' ')}`] };
  if (!/^T\d+$/.test(task)) return { usage: [`TaskID non valido: '${task}' (forma T<numero>)`] };
  if (!(PROMPT_KINDS as readonly string[]).includes(kind)) {
    return { usage: [`kind ignoto: '${kind}' (usa ${PROMPT_KINDS.join('|')})`] };
  }
  const request: SpawnRequest = { verb: 'spawn', task, kind: kind as SpawnRequest['kind'] };
  if (scopeSpec !== undefined) {
    if (kind !== 'run') return { usage: ['il perimetro vale solo con kind run'] };
    const scope = parseScope(scopeSpec);
    if ('error' in scope) return { usage: [scope.error] };
    request.scope = scope;
  }
  if (model !== undefined) {
    if (!isModelKind(model)) return { usage: [`modello ignoto: '${model}' (usa ${MODELS.join('|')})`] };
    request.model = model;
  }
  if (note !== undefined) {
    if (/[\r\n]/.test(note)) return { usage: ['--note: una riga sola'] };
    request.note = note;
  }
  if (regia !== undefined) {
    if (!/^T\d+$/.test(regia)) return { usage: [`--regia: perimetro non valido: '${regia}' (forma T<numero>)`] };
    request.regia = regia;
    const session = regiaSessionOf(env);
    if (session) request.regiaSession = session;
  }
  return { request, root };
}

/** T220 — il `sessionId` della conversazione che chiama, se l'ambiente ne
 *  porta uno intero e ben formato; altrimenti `null`. */
export function regiaSessionOf(env: Readonly<Record<string, string | undefined>>): string | null {
  const sid = normalizeSession(env.CLAUDE_CODE_SESSION_ID);
  return sid !== null && sid.length === 36 ? sid : null;
}

/** T220/P4 — l'avviso quando la richiesta dichiarava la regia e la risposta non
 *  la riporta: il deck acceso è più vecchio e l'ha ignorata, la tab è aperta
 *  senza `LOOM_REGIA`. `null` se non c'è niente da dire. Una risposta con
 *  `regia: null` viene da un deck che la conosce e l'ha scartata di proposito
 *  (kind `regia`, P3): nessun avviso. */
export function regiaWarning(request: SpawnRequest, reply: Record<string, unknown>): string | null {
  if (!request.regia || 'regia' in reply) return null;
  return '⚠ LOOM_REGIA non impostata: il deck acceso è più vecchio, riavvialo';
}

export async function runClient(argv: readonly string[], io: ClientIo): Promise<number> {
  const args = parseClientArgs(argv, io.env);
  if ('help' in args) {
    io.stdout(`${CLIENT_USAGE}\n`);
    return 0;
  }
  if ('usage' in args) {
    for (const line of args.usage) io.stderr(`loom-deck-spawn: ${line}\n`);
    io.stderr(`${CLIENT_USAGE}\n`);
    return 2;
  }
  const root = args.root ?? findProjectRoot(io.cwd) ?? io.cwd;
  const ep = endpointFor(root, io.platform, io.env);
  const outcome = await exchange<SpawnReply>(ep, args.request, io.timeoutMs ?? REPLY_TIMEOUT_MS);

  if ('unreachable' in outcome) {
    io.stderr(
      `loom-deck-spawn: nessun deck in ascolto per ${root} (${ep.address}, ${outcome.unreachable}).\n` +
        `Apri il deck del progetto, o aggiornalo: l'endpoint c'è da loom-deck ${ENDPOINT_SINCE}.\n`,
    );
    return 3;
  }
  if ('failed' in outcome) {
    io.stderr(`loom-deck-spawn: ${outcome.failed}\n`);
    return 1;
  }
  const r = outcome.reply;
  if (!r.ok) {
    if (r.queued) {
      io.stdout(`${queuedLines(r.queued, root, io.now?.() ?? Date.now()).join('\n')}\n`);
      return 4;
    }
    io.stderr(`loom-deck-spawn: il deck ha rifiutato: ${r.reason}\n`);
    return 1;
  }
  const lines = [
    r.inert
      ? `⚠ spawn inerte: il deck gira con LOOM_DECK_NO_SPAWN, nessuna tab aperta (${root})`
      : `✔ tab aperta dal deck di ${root}`,
    // T198 — la tab è aperta senza sapere se la finestra attiva era del
    // progetto: la conversazione lo deve poter dire all'utente.
    ...(r.warning ? [`⚠ ${r.warning}`] : []),
    // T220/P4 — uscita 0 lo stesso: la tab a questo punto esiste già.
    ...nonNull(regiaWarning(args.request, r)),
    `sessionId: ${r.sessionId}`,
    `task:      ${r.task} · ${r.kind} · ${r.model}`,
    `prompt:    ${r.prompt || '(nessuno)'}`,
  ];
  if (r.regia) lines.push(`regia:     ${r.regia} (LOOM_REGIA)`);
  if (r.title !== null) lines.push(`titolo:    ${r.title}`);
  if (r.inTab !== null) lines.push(`in-tab:    ${r.inTab}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

function nonNull(line: string | null): string[] {
  return line === null ? [] : [line];
}

/**
 * T229 — lo stdout di una richiesta in coda (uscita `4`). Le righe col nome
 * in testa sono quelle di una tab aperta, così chi legge le cerca allo stesso
 * modo; manca `titolo:`, e c'è `scade:`.
 *
 * L'ora di scadenza in ISO 8601 con lo scarto del fuso locale, più i minuti
 * che mancano: chi ha chiesto — una regia — la confronta con l'ora di adesso,
 * e passata quell'ora senza l'evento `🆕 nuova sessione` dà la richiesta per
 * morta. Nessun evento arriva alla scadenza, perché il client è già uscito.
 */
export function queuedLines(q: QueuedSpawn, root: string, nowMs: number): string[] {
  const at = new Date(q.expiresAt);
  const minutes = Math.max(0, Math.round((at.getTime() - nowMs) / 60_000));
  const lines = [
    `⏳ in coda sul deck di ${root}: la finestra in focus non è del progetto, la tab nasce quando una finestra del progetto torna in focus`,
    `sessionId: ${q.sessionId}`,
    `task:      ${q.task} · ${q.kind} · ${q.model}`,
    `prompt:    ${q.prompt || '(nessuno)'}`,
  ];
  if (q.regia) lines.push(`regia:     ${q.regia} (LOOM_REGIA)`);
  lines.push(`scade:     ${localIso(at)} (fra ${minutes} min)`);
  return lines;
}

/** Un istante in ISO 8601 all'ora locale, con lo scarto del fuso e senza i
 *  millisecondi: `2026-11-20T18:22:05+01:00`. */
export function localIso(d: Date): string {
  const two = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${two(Math.trunc(off / 60))}:${two(off % 60)}`
  );
}
