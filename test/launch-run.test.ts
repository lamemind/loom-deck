// T168 — l'esecuzione con esito di una voce launch: il record su disco, la
// fusione dell'exit scritto dal figlio, la guardia, la scadenza.
//
// Il gate bash è VERO: spawna il wrapper su un comando che esce con un codice
// noto e aspetta il file `.exit`. È l'unico modo di misurare che l'esito
// arriva dal figlio e non dal padre — un mock di `spawn` misurerebbe il mock.
// Sopravvivenza alla chiusura del padre: misurata nel DLV1 (stdio su fd,
// `analisi-voci-launch.md`), non ripetuta qui.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLaunch, type LaunchEntry } from '../src/config.js';
import { saveLaunchAttrs } from '../src/launch-config.js';
import { launchLogHeading, launchOutcome } from '../src/ui/launch-screen.js';
import { termWidth } from '../src/width.js';
import { gitBash } from '../src/git-bash.js';
import {
  isNoOutcome,
  lastTrueRecord,
  launchDue,
  launchIndicatorOf,
  launchNotifies,
  launchExitPath,
  launchLogPath,
  launchOutcomeLogPath,
  launchRecordPath,
  launchRunning,
  launchStateDir,
  outcomeLogStep,
  pickLaunchLog,
  readLaunchLog,
  readLaunchRecord,
  runCaptured,
  settleLaunchRecord,
  writeLaunchRecord,
  type LaunchRecord,
} from '../src/launch-run.js';

// T179 — su Windows il gate gira col bash di Git, lanciato dal tramite `node`
// (`launch-platform.ts`): salta solo dove quel bash non c'è.
const SKIP_BASH = process.platform === 'win32' && gitBash() === null ? 'bash di Git non trovato' : false;

function project(): string {
  return mkdtempSync(join(tmpdir(), 'deck-launch-'));
}

/** Una voce con esito che porta lo stesso comando per Linux e per Windows: i
 *  comandi del gate sono sintassi bash, che il bash di Git esegue uguale. */
function entry(label: string, command: string, extra: Record<string, unknown> = {}) {
  return parseLaunch({ launch: [{ label, command, windows: command, capture: true, ...extra }] })[0]!;
}

const rec = (over: Partial<LaunchRecord>): LaunchRecord => ({
  pid: null,
  procStart: null,
  startedAt: 1_000,
  endedAt: 2_000,
  exit: 0,
  origin: 'tasto',
  lastOutcome: null,
  ...over,
});

/**
 * Aspetta che il wrapper sia uscito. A POLL e non con `once('exit')`: il
 * figlio è `unref()`, quindi una promessa appesa al suo evento non tiene vivo
 * l'event loop, e dentro la suite intera il runner la cancella come «pending»
 * — misurato: due test verdi da soli, rossi nella suite. Il timer del poll è
 * ciò che tiene il processo in piedi fino all'uscita.
 */
async function waitChild(child: { exitCode: number | null; signalCode: string | null }, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > until) throw new Error(`il wrapper non è uscito entro ${ms}ms`);
    await sleep(20);
  }
}

/** Aspetta il file `.exit` del figlio, al più `ms` millisecondi. */
async function waitExit(root: string, slug: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(launchExitPath(root, slug))) return;
    await sleep(50);
  }
  throw new Error(`nessun .exit per ${slug} entro ${ms}ms`);
}

// ── il record ────────────────────────────────────────────────────────────────

test('record: round-trip su disco, assente → null, corrotto → null', () => {
  const root = project();
  assert.equal(readLaunchRecord(root, 'x'), null);
  writeLaunchRecord(root, 'x', rec({ pid: 42, procStart: '123' }));
  assert.deepEqual(readLaunchRecord(root, 'x'), rec({ pid: 42, procStart: '123' }));
  writeFileSync(launchRecordPath(root, 'x'), '{ rotto ][');
  assert.equal(readLaunchRecord(root, 'x'), null);
});

test('settle: un .exit lasciato dal figlio si fonde nel record e sparisce', () => {
  const root = project();
  writeLaunchRecord(root, 'x', rec({ pid: 1, endedAt: null, exit: null }));
  writeFileSync(launchExitPath(root, 'x'), '7\n');
  const settled = settleLaunchRecord(root, 'x')!;
  assert.equal(settled.exit, 7);
  assert.ok(settled.endedAt !== null && settled.endedAt >= settled.startedAt);
  assert.equal(existsSync(launchExitPath(root, 'x')), false, 'il file di transito deve sparire');
  // Il record scritto porta già l'esito: una seconda lettura non dipende dal .exit.
  assert.equal(readLaunchRecord(root, 'x')!.exit, 7);
});

test('settle: un record già chiuso non si tocca, e senza .exit resta aperto', () => {
  const root = project();
  writeLaunchRecord(root, 'a', rec({ exit: 0 }));
  assert.deepEqual(settleLaunchRecord(root, 'a'), rec({ exit: 0 }));
  writeLaunchRecord(root, 'b', rec({ pid: 1, endedAt: null, exit: null }));
  assert.equal(settleLaunchRecord(root, 'b')!.exit, null);
});

// ── la guardia e la scadenza ────────────────────────────────────────────────

test('launchRunning: senza pid o con exit non è in corso; un pid morto nemmeno', () => {
  assert.equal(launchRunning(null), false);
  assert.equal(launchRunning(rec({ pid: null, exit: null })), false);
  assert.equal(launchRunning(rec({ pid: 1, exit: 0 })), false);
  // Un pid che non esiste quasi certamente: il massimo di Linux è 4194304.
  assert.equal(launchRunning(rec({ pid: 4_000_000, procStart: '1', exit: null, endedAt: null })), false);
});

test('launchDue: mai girata → dovuta; finita da meno della soglia → no; da più → sì', () => {
  const h = 3_600_000;
  assert.equal(launchDue(null, h, 10 * h), true);
  assert.equal(launchDue(rec({ endedAt: 9 * h + 1 }), h, 10 * h), false);
  assert.equal(launchDue(rec({ endedAt: 9 * h }), h, 10 * h), true);
  // Record aperto con pid morto: conta dall'ora d'inizio, l'unica nota.
  assert.equal(launchDue(rec({ pid: 4_000_000, procStart: '1', startedAt: 8 * h, endedAt: null, exit: null }), h, 10 * h), true);
});

// ── il gate bash: l'esito lo scrive il figlio ───────────────────────────────

test('runCaptured: exit code dal figlio, output nel log, record chiuso dopo settle', { skip: SKIP_BASH }, async () => {
  const root = project();
  const e = entry('prova', 'echo ciao; echo errore >&2; exit 7');
  const { child, record } = runCaptured(e, root, 'tasto')!;
  assert.ok(record.pid !== null, 'il record porta il pid del wrapper');
  assert.equal(record.exit, null);
  await waitExit(root, e.slug!);
  await waitChild(child);
  const settled = settleLaunchRecord(root, e.slug!)!;
  assert.equal(settled.exit, 7);
  assert.ok(settled.endedAt !== null);
  const log = readLaunchLog(root, e.slug!)!;
  assert.match(log, /ciao/);
  assert.match(log, /errore/, 'anche stderr finisce nel log');
  assert.equal(launchRunning(settled), false);
});

test('runCaptured: un giro in corso risulta tale, e un rilancio riscrive il log', { skip: SKIP_BASH }, async () => {
  const root = project();
  const e = entry('lenta', 'echo primo; sleep 1');
  const { child, record } = runCaptured(e, root, 'every')!;
  assert.equal(launchRunning(record), true, 'il wrapper è vivo e il record lo dice');
  assert.equal(launchDue(record, 1, Date.now() + 10_000), false, 'una corsa in piedi non è mai dovuta');
  await waitExit(root, e.slug!);
  await waitChild(child);
  assert.equal(settleLaunchRecord(root, e.slug!)!.exit, 0);
  const second = runCaptured(entry('lenta', 'echo secondo'), root, 'tasto')!;
  await waitExit(root, e.slug!);
  await waitChild(second.child);
  assert.doesNotMatch(readLaunchLog(root, e.slug!)!, /primo/, 'il log è del solo ultimo giro');
  assert.match(readLaunchLog(root, e.slug!)!, /secondo/);
  assert.ok(statSync(launchLogPath(root, e.slug!)).size > 0);
});

test('runCaptured: il comando con apici e $ arriva intatto al wrapper', { skip: SKIP_BASH }, async () => {
  const root = project();
  const e = entry('quote', `printf '%s' "a'b" && echo " \${HOME:+ok}"`);
  const { child } = runCaptured(e, root, 'tasto')!;
  await waitExit(root, e.slug!);
  await waitChild(child);
  assert.equal(settleLaunchRecord(root, e.slug!)!.exit, 0);
  assert.match(readFileSync(launchLogPath(root, e.slug!), 'utf8'), /a'b ok/);
});

// ── T190 · i giri senza esito ───────────────────────────────────────────────

const H = 3_600_000;
const DAY = 24 * H;

test('isNoOutcome: solo un exit elencato, mai un esito aperto o una voce senza lista', () => {
  assert.equal(isNoOutcome(3, [3]), true);
  assert.equal(isNoOutcome(1, [3]), false);
  assert.equal(isNoOutcome(null, [3]), false);
  assert.equal(isNoOutcome(3, null), false);
  assert.equal(isNoOutcome(3, undefined), false);
});

test('lastTrueRecord: senza noOutcome il record è quello di sempre', () => {
  const r = rec({ exit: 3, lastOutcome: { startedAt: 1, endedAt: 2, exit: 0 } });
  assert.equal(lastTrueRecord(r, null), r);
  assert.equal(lastTrueRecord(r, [4]), r);
  assert.equal(lastTrueRecord(null, [3]), null);
});

test('lastTrueRecord: un giro senza esito cede il posto all\'ultimo giro vero, o a nessuno', () => {
  const truth = lastTrueRecord(rec({ startedAt: 50, endedAt: 60, exit: 3, lastOutcome: { startedAt: 10, endedAt: 20, exit: 1 } }), [3])!;
  assert.equal(truth.exit, 1);
  assert.equal(truth.endedAt, 20);
  assert.equal(truth.pid, null, 'l\'ultimo giro vero non è mai una corsa in piedi');
  assert.equal(lastTrueRecord(rec({ exit: 3, lastOutcome: null }), [3]), null);
  // Una corsa in piedi e un esito perso non si scartano: non hanno un codice.
  const open = rec({ pid: 4_000_000, procStart: '1', endedAt: null, exit: null });
  assert.equal(lastTrueRecord(open, [3]), open);
});

test('scadenza: un giro senza esito non la sposta — la voce dovuta resta dovuta', () => {
  const now = 10 * DAY;
  // L'ultimo giro vero è di due giorni fa, il tentativo senza esito di un minuto fa.
  const r = rec({ startedAt: now - 70_000, endedAt: now - 60_000, exit: 3, lastOutcome: { startedAt: now - 2 * DAY, endedAt: now - 2 * DAY + 10_000, exit: 0 } });
  assert.equal(launchDue(r, DAY, now), false, 'senza noOutcome il tentativo conterebbe come giro');
  assert.equal(launchDue(lastTrueRecord(r, [3]), DAY, now), true, 'con noOutcome la voce resta dovuta');
  // Un tentativo a tasto PRIMA della scadenza non la rende dovuta.
  const early = rec({ ...r, lastOutcome: { startedAt: now - H, endedAt: now - H + 10_000, exit: 0 } });
  assert.equal(launchDue(lastTrueRecord(early, [3]), DAY, now), false);
  // Nessun giro vero, mai: dovuta, al tick dopo, senza attesa crescente.
  assert.equal(launchDue(lastTrueRecord(rec({ ...r, lastOutcome: null }), [3]), DAY, now), true);
});

function voce(label: string, extra: Record<string, unknown> = {}): LaunchEntry {
  return entry(label, `echo ${label}`, extra);
}

test('testata: un giro senza esito dopo un rosso lascia 🚨, dopo un verde la lascia vuota', () => {
  const v = voce('custodia', { noOutcome: [3] });
  const after = (exit: number) => new Map([[v.slug!, rec({ exit: 3, lastOutcome: { startedAt: 1, endedAt: 2, exit } })]]);
  assert.deepEqual(launchIndicatorOf([v], after(1)), { kind: 'red', label: 'custodia', count: 1 });
  assert.equal(launchIndicatorOf([v], after(0)), null);
  // Nessun giro vero prima: nessun glifo.
  assert.equal(launchIndicatorOf([v], new Map([[v.slug!, rec({ exit: 3 })]])), null);
});

test('testata: una voce senza noOutcome gira come prima — ogni exit diverso da 0 è 🚨', () => {
  const pull = voce('pull all');
  const red = new Map([[pull.slug!, rec({ exit: 3, lastOutcome: { startedAt: 1, endedAt: 2, exit: 0 } })]]);
  assert.deepEqual(launchIndicatorOf([pull], red), { kind: 'red', label: 'pull all', count: 1 });
  assert.equal(launchIndicatorOf([pull], new Map([[pull.slug!, rec({ exit: 0 })]])), null);
  const running = new Map([[pull.slug!, rec({ pid: process.pid, procStart: null, endedAt: null, exit: null })]]);
  assert.deepEqual(launchIndicatorOf([pull], running), { kind: 'running', label: 'pull all', count: 1 });
  // Spenta o senza capture: fuori dalla testata.
  assert.equal(launchIndicatorOf([voce('x', { enabled: false })], new Map([['x', rec({ exit: 1 })]])), null);
  assert.equal(launchIndicatorOf([{ ...pull, capture: false }], red), null);
});

test('pagina ^L: l\'esito resta quello dell\'ultimo giro vero, il tentativo gli sta accanto', () => {
  const v = voce('custodia', { noOutcome: [3] });
  const last = { startedAt: 1, endedAt: 2, exit: 1 };
  const out = launchOutcome(v, rec({ exit: 3, lastOutcome: last }));
  assert.match(out.text, /^exit 1 · /);
  assert.equal(out.color, 'red');
  assert.match(out.aside!, /^senza esito: exit 3 · /);
  const never = launchOutcome(v, rec({ exit: 3 }));
  assert.equal(never.text, 'mai');
  assert.match(never.aside!, /exit 3/);
  // Un giro vero non porta nessun tentativo accanto, e senza noOutcome il 3 è un rosso.
  assert.equal(launchOutcome(v, rec({ exit: 0 })).aside, undefined);
  assert.equal(launchOutcome(voce('pull'), rec({ exit: 3, lastOutcome: last })).text.startsWith('exit 3'), true);
});

test('w nella pagina ^L lascia noOutcome nel file di progetto', () => {
  const root = project();
  mkdirSync(join(root, '.claude'), { recursive: true });
  const file = join(root, '.claude', 'loom-works.json');
  writeFileSync(
    file,
    JSON.stringify({ id: 'p', launch: [{ emoji: '🔬', label: 'custodia', command: 'giro.sh', capture: true, every: '1d', noOutcome: [3] }] }),
  );
  const [v] = parseLaunch(JSON.parse(readFileSync(file, 'utf8')));
  saveLaunchAttrs(root, [{ ...v!, startup: true }]);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc.launch[0].noOutcome, [3]);
  assert.equal(doc.launch[0].startup, true);
});

// ── T179 · comando per piattaforma ──────────────────────────────────────────

test('w nella pagina ^L riconosce una voce senza command dal suo windows, e rifiuta un windows cambiato', () => {
  const root = project();
  mkdirSync(join(root, '.claude'), { recursive: true });
  const file = join(root, '.claude', 'loom-works.json');
  const voci = [
    { emoji: '🪟', label: 'explorer', windows: 'explorer .' },
    { emoji: '📝', label: 'editor', command: 'codium .', windows: 'code .' },
  ];
  writeFileSync(file, JSON.stringify({ id: 'p', launch: voci }));
  const [win, both] = parseLaunch(JSON.parse(readFileSync(file, 'utf8')));
  saveLaunchAttrs(root, [{ ...win!, startup: true }, { ...both!, header: false }]);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.launch[0].startup, true);
  assert.equal('command' in doc.launch[0], false, 'il saver non inventa un command');
  assert.equal(doc.launch[1].header, false);
  assert.equal(doc.launch[1].windows, 'code .');
  // Il windows riscritto a mano mentre la pagina era aperta: la voce è un'altra.
  writeFileSync(file, JSON.stringify({ id: 'p', launch: [voci[0], { ...voci[1], windows: 'code-insiders .' }] }));
  assert.throws(() => saveLaunchAttrs(root, [{ ...both!, header: true }]), /cambiata sotto la pagina/);
});

test('runCaptured: una voce senza il comando della piattaforma non parte e non scrive niente', () => {
  const root = project();
  const prev = process.env.LOOM_DECK_PLATFORM;
  process.env.LOOM_DECK_PLATFORM = process.platform === 'win32' ? 'linux' : 'win32';
  try {
    const field = process.env.LOOM_DECK_PLATFORM === 'win32' ? 'command' : 'windows';
    const [e] = parseLaunch({ launch: [{ label: 'solo', [field]: 'echo mai', capture: true }] });
    assert.equal(runCaptured(e!, root, 'tasto'), null);
    assert.equal(existsSync(launchStateDir(root)), false);
  } finally {
    if (prev === undefined) delete process.env.LOOM_DECK_PLATFORM;
    else process.env.LOOM_DECK_PLATFORM = prev;
  }
});

test('runCaptured: l\'ultimo giro vero sopravvive ai rilanci senza esito', { skip: SKIP_BASH }, async () => {
  const root = project();
  const run = async (command: string) => {
    const e = entry('lock', command, { noOutcome: [3] });
    const { child, record } = runCaptured(e, root, 'every')!;
    await waitExit(root, e.slug!);
    await waitChild(child);
    return { record, settled: settleLaunchRecord(root, e.slug!)!, e };
  };
  // T258 — il log che `l` apre per il record, come lo sceglie la pagina.
  const shown = (r: { settled: LaunchRecord; e: LaunchEntry }) => {
    const pick = pickLaunchLog(r.settled, r.e.noOutcome, existsSync(launchOutcomeLogPath(root, r.e.slug!)));
    return readLaunchLog(root, r.e.slug!, pick.file);
  };
  const outcomeLog = () => readLaunchLog(root, 'lock', 'outcome');
  const first = await run('echo misura-1; exit 1');
  assert.equal(first.record.lastOutcome, null, 'il primo giro di sempre non ha un giro prima');
  assert.equal(first.settled.exit, 1);
  assert.equal(outcomeLog(), null, 'il giro vero corrente sta in <slug>.log, nessun file a parte');
  assert.match(shown(first)!, /misura-1/);
  const second = await run('echo lock-preso-1; exit 3');
  assert.equal(second.settled.exit, 3, 'il record dice com\'è finito il tentativo');
  assert.equal(second.settled.lastOutcome!.exit, 1, 'e porta il giro vero di prima');
  assert.equal(second.settled.lastOutcome!.endedAt, first.settled.endedAt);
  assert.match(outcomeLog()!, /misura-1/, 'l\'output del giro vero è ancora su disco');
  assert.match(readLaunchLog(root, 'lock')!, /lock-preso-1/, 'il tentativo resta leggibile');
  assert.match(shown(second)!, /misura-1/, '`l` apre il log del giro che la riga mostra come esito');
  const third = await run('echo lock-preso-2; exit 3');
  assert.equal(third.settled.lastOutcome!.exit, 1, 'due tentativi di fila non perdono il giro vero');
  assert.equal(lastTrueRecord(third.settled, third.e.noOutcome)!.exit, 1);
  assert.match(outcomeLog()!, /misura-1/, 'né il suo log');
  assert.doesNotMatch(outcomeLog()!, /lock-preso/);
  assert.match(readLaunchLog(root, 'lock')!, /lock-preso-2/);
  assert.match(shown(third)!, /misura-1/);
  const fourth = await run('echo misura-2; exit 0');
  assert.equal(fourth.settled.exit, 0);
  assert.equal(lastTrueRecord(fourth.settled, fourth.e.noOutcome), fourth.settled, 'un giro vero torna a essere il record');
  assert.match(shown(fourth)!, /misura-2/, 'e `l` apre il suo log, l\'ultimo lanciato');
  const fifth = await run('echo lock-preso-3; exit 3');
  assert.equal(fifth.settled.lastOutcome!.exit, 0);
  assert.match(outcomeLog()!, /misura-2/, 'il giro vero nuovo prende il posto di quello vecchio');
  assert.match(shown(fifth)!, /misura-2/);
  const files = readdirSync(launchStateDir(root)).filter((f) => f.endsWith('.log')).sort();
  assert.deepEqual(files, ['lock.log', 'lock.outcome.log'], 'i log restano due, qualunque sia il numero di tentativi');
});

test('runCaptured: una voce senza noOutcome tiene un log solo, e toglie quello rimasto', { skip: SKIP_BASH }, async () => {
  const root = project();
  const e = entry('pull', 'echo pull-2; exit 3');
  // Lo stato di quando la voce aveva `noOutcome`: un giro vero e un tentativo.
  writeLaunchRecord(root, e.slug!, rec({ exit: 3, lastOutcome: { startedAt: 1, endedAt: 2, exit: 1 } }));
  writeFileSync(launchLogPath(root, e.slug!), 'tentativo vecchio\n');
  writeFileSync(launchOutcomeLogPath(root, e.slug!), 'giro vero vecchio\n');
  const { child } = runCaptured(e, root, 'tasto')!;
  await waitExit(root, e.slug!);
  await waitChild(child);
  const settled = settleLaunchRecord(root, e.slug!)!;
  assert.equal(existsSync(launchOutcomeLogPath(root, e.slug!)), false, 'il file del giro vero non descrive più nessun giro');
  assert.match(readLaunchLog(root, e.slug!)!, /pull-2/, 'il log è riscritto dal giro');
  assert.equal(pickLaunchLog(settled, e.noOutcome, false).file, 'last');
});

test('outcomeLogStep: la regola di lastOutcome, applicata al log', () => {
  const no = [3];
  assert.equal(outcomeLogStep(null, no), 'drop', 'nessun giro prima: niente da descrivere');
  assert.equal(outcomeLogStep(rec({ exit: 1 }), no), 'promote', 'un giro vero: il suo log si mette da parte');
  assert.equal(outcomeLogStep(rec({ exit: 0 }), no), 'promote');
  const last = { startedAt: 1, endedAt: 2, exit: 1 };
  assert.equal(outcomeLogStep(rec({ exit: 3, lastOutcome: last }), no), 'keep', 'un tentativo: il log del giro vero resta');
  assert.equal(outcomeLogStep(rec({ exit: 3, lastOutcome: null }), no), 'drop', 'un tentativo senza un giro vero prima');
  // Un esito perso non dice com'è finito: si porta avanti il giro vero che il record porta.
  assert.equal(outcomeLogStep(rec({ pid: 4_000_000, procStart: '1', endedAt: null, exit: null, lastOutcome: last }), no), 'keep');
  assert.equal(outcomeLogStep(rec({ pid: 4_000_000, procStart: '1', endedAt: null, exit: null }), no), 'drop');
  // Senza noOutcome la voce tiene un log solo.
  assert.equal(outcomeLogStep(rec({ exit: 1 }), null), 'drop');
  assert.equal(outcomeLogStep(rec({ exit: 1 }), undefined), 'drop');
  assert.equal(outcomeLogStep(rec({ exit: 1 }), []), 'drop');
});

test('pickLaunchLog: il log del giro che la riga mostra, il tentativo dietro tab', () => {
  const no = [3];
  const last = { startedAt: 1, endedAt: 2, exit: 1 };
  const attempt = rec({ exit: 3, lastOutcome: last });
  assert.deepEqual(pickLaunchLog(attempt, no, true), { file: 'outcome', alternate: true });
  // Il log del giro vero non è su disco (record di un deck di prima): si apre il tentativo.
  assert.deepEqual(pickLaunchLog(attempt, no, false), { file: 'last', alternate: false });
  // Nessun giro vero, mai: un file rimasto non va sotto un esito che la riga non mostra.
  assert.deepEqual(pickLaunchLog(rec({ exit: 3 }), no, true), { file: 'last', alternate: false });
  // Giro vero, in corso, esito perso, voce senza noOutcome: l'ultimo giro lanciato.
  assert.deepEqual(pickLaunchLog(rec({ exit: 1, lastOutcome: last }), no, true), { file: 'last', alternate: false });
  assert.deepEqual(pickLaunchLog(rec({ pid: 1, endedAt: null, exit: null, lastOutcome: last }), no, true), { file: 'last', alternate: false });
  assert.deepEqual(pickLaunchLog(attempt, null, true), { file: 'last', alternate: false });
  assert.deepEqual(pickLaunchLog(null, no, true), { file: 'last', alternate: false });
});

test('intestazione del log: nomina il solo giro di cui si legge il testo', () => {
  const v = voce('custodia', { noOutcome: [3] });
  const attempt = rec({ startedAt: 50, endedAt: 60, exit: 3, lastOutcome: { startedAt: 10, endedAt: 20, exit: 1 } });
  const truth = launchLogHeading(v, attempt, 'outcome', true);
  assert.match(truth.text, /^\[ exit 1 · .* \]$/);
  assert.equal(truth.color, 'red');
  assert.doesNotMatch(truth.text, /exit 3|tentativo/, 'sul log del giro vero il tentativo non compare');
  const tried = launchLogHeading(v, attempt, 'last', true);
  assert.match(tried.text, /^tentativo · senza esito: exit 3 · /);
  assert.doesNotMatch(tried.text, /exit 1/, 'sul log del tentativo l\'esito del giro vero non compare');
  assert.equal(tried.trueLogMissing, false);
  // Il log del giro vero non è su disco: la schermata dice perché si legge il tentativo.
  assert.equal(launchLogHeading(v, attempt, 'last', false).trueLogMissing, true);
  assert.equal(launchLogHeading(v, rec({ exit: 3 }), 'last', false).trueLogMissing, false, 'nessun giro vero da cercare');
  // Una voce senza noOutcome, o un giro vero: l'intestazione di sempre.
  assert.match(launchLogHeading(voce('pull'), attempt, 'last', false).text, /^\[ exit 3 · /);
  assert.match(launchLogHeading(v, rec({ exit: 0 }), 'last', false).text, /^\[ exit 0 · /);
});

test('legenda del log con tab: sta nelle 76 colonne utili di un terminale da 80', () => {
  for (const what of ['tentativo', 'giro vero']) {
    const legend = `↑↓ riga · PgUp/PgDn ½ pagina · g/G estremi · tab ${what} · esc torna`;
    assert.ok(termWidth(legend) <= 76, `${termWidth(legend)} colonne: ${legend}`);
  }
});

// ── T190 · exit 1 contro 2 ──────────────────────────────────────────────────

test('notifica: da scadenza e da startup a ogni cambio di codice, non quando si ripete', () => {
  for (const origin of ['every', 'startup'] as const) {
    assert.equal(launchNotifies(0, 1, origin), true, '0→1');
    assert.equal(launchNotifies(1, 2, origin), true, '1→2: due rossi diversi sono una notizia');
    assert.equal(launchNotifies(2, 0, origin), true, '2→0');
    assert.equal(launchNotifies(1, 1, origin), false, '1→1');
    assert.equal(launchNotifies(0, 0, origin), false, '0→0');
    // Al primo giro di sempre vale il solo rosso.
    assert.equal(launchNotifies(null, 0, origin), false);
    assert.equal(launchNotifies(null, 2, origin), true);
  }
});

test('notifica: a tasto sempre, anche quando il codice si ripete', () => {
  assert.equal(launchNotifies(1, 1, 'tasto'), true);
  assert.equal(launchNotifies(0, 0, 'tasto'), true);
  assert.equal(launchNotifies(null, 0, 'tasto'), true);
});

test('exit 1 contro 2: stesso 🚨 in testata, il numero resta nella pagina ^L', () => {
  const v = voce('custodia', { noOutcome: [3] });
  for (const exit of [1, 2]) {
    const records = new Map([[v.slug!, rec({ exit })]]);
    assert.deepEqual(launchIndicatorOf([v], records), { kind: 'red', label: 'custodia', count: 1 });
    assert.match(launchOutcome(v, rec({ exit })).text, new RegExp(`^exit ${exit} · `));
  }
});
