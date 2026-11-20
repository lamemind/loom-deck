// T205 — `loom-deck-headless`, la riga di comando del turno headless: tre
// sottocomandi, `open`, `reply`, `status`.
//
// Un comando a sé del pacchetto, accanto a `loom-deck-spawn` e
// `loom-deck-close` (D1 preflight), e non un verbo dell'endpoint: un canale
// headless non deve dipendere dalla TUI accesa, né da un socket che un deck
// riavviato può lasciare orfano. Qui i sottocomandi sono ammessi: il comando è
// nuovo, e su un pacchetto che non lo ha risponde «command not found».
//
// Gli argomenti di `open` sono quelli di `loom-deck-spawn` (`parseClientArgs`):
// la regia sceglie fra tab e headless cambiando il comando, non la grammatica.
//
// La logica sta in `headless.ts`; qui argv, attesa e stampa. L'ingresso vero è
// `loom-deck-headless.ts`, così il test esegue il client intero con un I/O
// finto.
import {
  openHeadless,
  replyHeadless,
  resolveSession,
  turnOutcome,
  type HeadlessIo,
  type TurnReply,
} from './headless.js';
import { headlessIds, readState, type HeadlessState, type Outcome } from './headless-state.js';
import { isModelKind, MODELS, type ModelKind } from './spawn-catalog.js';
import { parseClientArgs } from './spawn-client.js';
import { normalizeSession, requestKinds } from './spawn-endpoint.js';
import { findProjectRoot } from './tab-launch.js';

export const HEADLESS_USAGE = `uso: loom-deck-headless open <TaskID> <kind> [perimetro] [--model <alias>] [--note <testo>] [--regia <perimetro>] [--root <dir>]
     loom-deck-headless reply <sessionId> <messaggio… | -> [--model <alias>] [--regia <perimetro>] [--root <dir>]
     loom-deck-headless status <sessionId> [--wait <secondi>] [--json] [--root <dir>]

Un turno di conversazione su una task SENZA tab: un processo claude -p staccato,
che finisce da solo a turno chiuso. open e reply tornano subito; l'esito lo dice
status. Nessuna tab, nessun cambio di finestra o di focus.

  open     apre la conversazione con un'azione del catalogo del deck, con titolo,
           modello e binding del tasto del deck (override di progetto compresi)
             <kind>       ${requestKinds('headless').filter((k) => k !== 'none').join(' | ')}
             [perimetro]  solo con run: DLV come in run-task, 1,3-5
           su un progetto permissionMode manual rifiuta run e checkpoint
  reply    manda il messaggio a una conversazione ferma del progetto e ne avvia
           il turno dopo (--resume); - legge il messaggio da stdin. Rifiutata se
           la conversazione ha un processo vivo, in una tab o headless
  status   l'esito dell'ultimo turno headless — in corso · turno chiuso ·
           permesso negato · errore — col testo finale del turno
             --wait <s>  aspetta la fine del turno fino a <s> secondi
             --json      lo stato e l'esito come JSON

  sessionId   intero, o prefisso di almeno 8 caratteri
  --model     ${MODELS.join(' | ')} (open: assente = il modello dell'azione;
              reply: assente = quello con cui la conversazione ha risposto)
  --regia     la regia che apre o risponde, col suo perimetro (T<numero>, epica
              o mandato): il turno nasce con LOOM_REGIA. Vale per QUEL turno:
              una regia la dichiara a ogni reply
  --root      root del progetto (assente = risalita fino a .claude/loom-works.json)

Un turno in corso si ferma con kill <pid>: il pid lo stampa status.

Uscite  open, reply  0 turno avviato · 1 rifiuto · 2 errore d'uso
        status       0 turno chiuso · 1 errore · 2 errore d'uso o sessione
                     ignota · 3 in corso · 4 permesso negato`;

/** Tetto di `--wait`: oltre l'ora è un errore di battitura. */
export const WAIT_MAX_S = 3600;

/** Le uscite di `status`, per classe d'esito. */
export const STATUS_EXIT: Readonly<Record<Outcome['cls'], number>> = {
  'turno chiuso': 0,
  errore: 1,
  'in corso': 3,
  'permesso negato': 4,
};

export interface HeadlessClientIo {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  headless: HeadlessIo;
  /** Ogni quanto `status --wait` rilegge l'esito. */
  pollMs?: number;
}

type Common = { root: string | null; model?: ModelKind; regia?: string };
type Parsed =
  | { help: true }
  | { usage: string[] }
  | { cmd: 'open'; args: string[] }
  | ({ cmd: 'reply'; session: string; words: string[] } & Common)
  | { cmd: 'status'; session: string; wait: number; json: boolean; root: string | null };

/** L'argv di `reply` e `status`. Quello di `open` lo legge `parseClientArgs`. */
export function parseHeadlessArgs(argv: readonly string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '-h' || cmd === '--help') return { help: true };
  if (cmd === 'open') return { cmd, args: rest };
  if (cmd !== 'reply' && cmd !== 'status') return { usage: [`sottocomando ignoto: '${cmd}' (usa open | reply | status)`] };

  const positional: string[] = [];
  let root: string | null = null;
  let model: ModelKind | undefined;
  let regia: string | undefined;
  let wait = 0;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '-h' || a === '--help') return { help: true };
    // Dopo `--` tutto è messaggio, anche una parola che comincia con `--`.
    if (a === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (a === '--root' || a === '--model' || a === '--regia' || (cmd === 'status' && a === '--wait')) {
      const v = rest[i + 1];
      if (v === undefined) return { usage: [`${a} senza valore`] };
      i++;
      if (a === '--root') root = v;
      else if (a === '--regia') {
        if (cmd !== 'reply') return { usage: ['--regia vale con open e reply'] };
        if (!/^T\d+$/.test(v)) return { usage: [`--regia: perimetro non valido: '${v}' (forma T<numero>)`] };
        regia = v;
      } else if (a === '--model') {
        if (cmd !== 'reply') return { usage: ['--model vale con open e reply'] };
        if (!isModelKind(v)) return { usage: [`modello ignoto: '${v}' (usa ${MODELS.join('|')})`] };
        model = v;
      } else {
        if (!/^\d+$/.test(v) || Number(v) > WAIT_MAX_S) return { usage: [`--wait: secondi interi fra 0 e ${WAIT_MAX_S}`] };
        wait = Number(v);
      }
      continue;
    }
    if (cmd === 'status' && a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--')) return { usage: [`opzione ignota: ${a}`] };
    positional.push(a);
  }
  const [session, ...words] = positional;
  if (!session) return { usage: [`${cmd}: serve il sessionId`] };
  if (normalizeSession(session) === null) {
    return { usage: [`sessionId non valido: '${session}' (intero, o prefisso di almeno 8 caratteri esadecimali)`] };
  }
  if (cmd === 'status') {
    if (words.length) return { usage: [`argomenti in più: ${words.join(' ')}`] };
    return { cmd, session, wait, json, root };
  }
  if (!words.length) return { usage: ['reply: serve il messaggio (- per leggerlo da stdin)'] };
  return { cmd, session, words, root, model, ...(regia ? { regia } : {}) };
}

export async function runHeadlessClient(argv: readonly string[], io: HeadlessClientIo): Promise<number> {
  const p = parseHeadlessArgs(argv);
  if ('help' in p) {
    io.stdout(`${HEADLESS_USAGE}\n`);
    return 0;
  }
  if ('usage' in p) return usage(io, p.usage);

  if (p.cmd === 'open') {
    const a = parseClientArgs(p.args, io.headless.env);
    if ('help' in a) {
      io.stdout(`${HEADLESS_USAGE}\n`);
      return 0;
    }
    if ('usage' in a) return usage(io, a.usage);
    return reportStart(io, await openHeadless(a.request, rootOf(a.root, io), io.headless), 'open');
  }

  const root = rootOf(p.root, io);
  if (p.cmd === 'reply') {
    const message = p.words.length === 1 && p.words[0] === '-' ? await io.readStdin() : p.words.join(' ');
    return reportStart(io, await replyHeadless(p.session, message, root, io.headless, p.model, p.regia), 'reply');
  }

  const prefix = normalizeSession(p.session)!;
  const found = resolveSession(p.session, headlessIds(root, prefix));
  if ('error' in found) {
    io.stderr(`loom-deck-headless: ${found.error.replace('nessuna conversazione', 'nessun turno headless di')}\n`);
    return 2;
  }
  const deadline = io.headless.now().getTime() + p.wait * 1000;
  for (;;) {
    const st = readState(root, found.sessionId);
    if (!st) {
      io.stderr(`loom-deck-headless: stato di ${found.sessionId.slice(0, 8)} illeggibile\n`);
      return 2;
    }
    const outcome = turnOutcome(root, st, io.headless);
    if (outcome.cls !== 'in corso' || io.headless.now().getTime() >= deadline) {
      io.stdout(p.json ? `${JSON.stringify({ state: st, outcome }, null, 2)}\n` : statusText(st, outcome, io.headless.now()));
      return STATUS_EXIT[outcome.cls];
    }
    await io.sleep(Math.min(io.pollMs ?? 1000, Math.max(0, deadline - io.headless.now().getTime())));
  }
}

function usage(io: HeadlessClientIo, lines: string[]): number {
  for (const line of lines) io.stderr(`loom-deck-headless: ${line}\n`);
  io.stderr(`${HEADLESS_USAGE}\n`);
  return 2;
}

function rootOf(root: string | null, io: HeadlessClientIo): string {
  return root ?? findProjectRoot(io.cwd) ?? io.cwd;
}

function reportStart(io: HeadlessClientIo, r: TurnReply, verb: 'open' | 'reply'): number {
  if (!r.ok) {
    io.stderr(`loom-deck-headless: ${verb} rifiutato: ${r.reason}\n`);
    return 1;
  }
  for (const w of r.warnings) io.stderr(`⚠ ${w}\n`);
  const st = r.state;
  io.stdout(
    [
      `✔ turno headless avviato (${verb === 'open' ? 'apertura' : `risposta, turno ${st.turn}`}) — nessuna tab`,
      `sessionId: ${st.sessionId}`,
      `task:      ${st.task ?? '(nessuna)'} · ${st.kind} · ${st.model} · ${st.permissionMode}`,
      `titolo:    ${st.title}`,
      ...(st.regia ? [`regia:     ${st.regia} (LOOM_REGIA)`] : []),
      `pid:       ${st.pid}`,
      `esito:     loom-deck-headless status ${st.sessionId.slice(0, 8)} [--wait <secondi>]`,
    ].join('\n') + '\n',
  );
  return 0;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** L'esito in righe, per chi lo legge: la regia o l'utente. */
export function statusText(st: HeadlessState, o: Outcome, now: Date): string {
  const lines = [
    `sessionId: ${st.sessionId}`,
    `task:      ${st.task ?? '(nessuna)'} · ${st.kind} · ${st.model}`,
    `turno:     ${st.turn} · avviato ${st.startedAt} · pid ${st.pid ?? '-'}`,
  ];
  if (o.cls === 'in corso') {
    lines.push(`esito:     in corso · da ${seconds(now.getTime() - Date.parse(st.startedAt))}${o.reason ? ` (${o.reason})` : ''}`);
    return `${lines.join('\n')}\n`;
  }
  const took = o.result?.durationMs != null ? ` · ${seconds(o.result.durationMs)}` : '';
  lines.push(`esito:     ${o.cls}${took}`);
  if (o.cls === 'errore' && o.reason) lines.push(`motivo:    ${o.reason}`);
  if (o.result?.denials.length) {
    lines.push('permessi negati (riprendere in una tab per approvarli):');
    for (const d of o.result.denials) lines.push(`  - ${d.tool}: ${d.input}`);
  }
  if (o.result) {
    lines.push('testo finale:');
    lines.push(o.result.text || '(vuoto)');
  }
  return `${lines.join('\n')}\n`;
}
