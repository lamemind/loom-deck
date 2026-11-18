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
//   1  il deck ha risposto con un rifiuto, o non ha risposto in tempo. T198 —
//      su Linux anche la finestra in focus che non è del progetto: il motivo
//      porta l'istruzione per l'utente, e il client lo stampa com'è
//   2  errore d'uso, nessuna richiesta partita
//   3  nessun deck in ascolto sull'indirizzo del progetto
//
// La logica sta qui e l'ingresso in `loom-deck-spawn.ts`, così il test esegue il
// client intero contro un server vero senza lanciare un processo. Lo scambio sul
// socket sta in `endpoint-client.ts`, condiviso con `loom-deck-close` (T204).
import { exchange, REPLY_TIMEOUT_MS, type ClientIo } from './endpoint-client.js';
import { isModelKind, MODELS } from './spawn-catalog.js';
import {
  ENDPOINT_SINCE,
  endpointFor,
  parseScope,
  type SpawnReply,
  type SpawnRequest,
} from './spawn-endpoint.js';
import { PROMPT_KINDS } from './tab-args.js';
import { findProjectRoot } from './tab-launch.js';

export const CLIENT_USAGE = `uso: loom-deck-spawn <TaskID> <kind> [perimetro] [--model <alias>] [--note <testo>] [--root <dir>]

Chiede al deck acceso sul progetto di aprire una conversazione sulla task, come
il tasto del deck: stesso binding, titolo e modello (override di progetto
compreso).

  <kind>       ${PROMPT_KINDS.join(' | ')}
  [perimetro]  solo con run: DLV come in run-task, 1,3-5 (assente = tutti gli aperti)
  --model      ${MODELS.join(' | ')} (assente = il modello dell'azione nel deck)
  --note       nota del titolo della tab (assente = il titolo dell'azione)
  --root       root del progetto (assente = risalita dalla cartella corrente
               fino a .claude/loom-works.json)

Uscite: 0 tab aperta · 1 rifiuto o nessuna risposta dal deck · 2 errore d'uso ·
3 nessun deck in ascolto sul progetto`;

export { REPLY_TIMEOUT_MS, type ClientIo };

export type ClientArgs = { request: SpawnRequest; root: string | null } | { usage: string[] } | { help: true };

/** L'argv del client, validato. Puro: nessun disco, nessuna rete. */
export function parseClientArgs(argv: readonly string[]): ClientArgs {
  const positional: string[] = [];
  let model: string | undefined;
  let note: string | undefined;
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--model' || a === '--note' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) return { usage: [`${a} senza valore`] };
      i++;
      if (a === '--model') model = v;
      else if (a === '--note') note = v;
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
  return { request, root };
}

export async function runClient(argv: readonly string[], io: ClientIo): Promise<number> {
  const args = parseClientArgs(argv);
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
    `sessionId: ${r.sessionId}`,
    `task:      ${r.task} · ${r.kind} · ${r.model}`,
    `prompt:    ${r.prompt || '(nessuno)'}`,
  ];
  if (r.title !== null) lines.push(`titolo:    ${r.title}`);
  if (r.inTab !== null) lines.push(`in-tab:    ${r.inTab}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
