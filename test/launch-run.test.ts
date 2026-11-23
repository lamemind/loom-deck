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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLaunch, type LaunchEntry } from '../src/config.js';
import { saveLaunchAttrs } from '../src/launch-config.js';
import { launchOutcome } from '../src/ui/launch-screen.js';
import {
  isNoOutcome,
  lastTrueRecord,
  launchDue,
  launchIndicatorOf,
  launchExitPath,
  launchLogPath,
  launchRecordPath,
  launchRunning,
  readLaunchLog,
  readLaunchRecord,
  runCaptured,
  settleLaunchRecord,
  writeLaunchRecord,
  type LaunchRecord,
} from '../src/launch-run.js';

const SKIP_BASH = process.platform === 'win32' ? 'bash non disponibile su Windows' : false;

function project(): string {
  return mkdtempSync(join(tmpdir(), 'deck-launch-'));
}

function entry(label: string, command: string, extra: Record<string, unknown> = {}) {
  return parseLaunch({ launch: [{ label, command, capture: true, ...extra }] })[0]!;
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
  const { child, record } = runCaptured(e, root, 'tasto');
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
  const { child, record } = runCaptured(e, root, 'every');
  assert.equal(launchRunning(record), true, 'il wrapper è vivo e il record lo dice');
  assert.equal(launchDue(record, 1, Date.now() + 10_000), false, 'una corsa in piedi non è mai dovuta');
  await waitExit(root, e.slug!);
  await waitChild(child);
  assert.equal(settleLaunchRecord(root, e.slug!)!.exit, 0);
  const second = runCaptured(entry('lenta', 'echo secondo'), root, 'tasto');
  await waitExit(root, e.slug!);
  await waitChild(second.child);
  assert.doesNotMatch(readLaunchLog(root, e.slug!)!, /primo/, 'il log è del solo ultimo giro');
  assert.match(readLaunchLog(root, e.slug!)!, /secondo/);
  assert.ok(statSync(launchLogPath(root, e.slug!)).size > 0);
});

test('runCaptured: il comando con apici e $ arriva intatto al wrapper', { skip: SKIP_BASH }, async () => {
  const root = project();
  const e = entry('quote', `printf '%s' "a'b" && echo " \${HOME:+ok}"`);
  const { child } = runCaptured(e, root, 'tasto');
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

test('runCaptured: l\'ultimo giro vero sopravvive ai rilanci senza esito', { skip: SKIP_BASH }, async () => {
  const root = project();
  const run = async (command: string) => {
    const e = entry('lock', command, { noOutcome: [3] });
    const { child, record } = runCaptured(e, root, 'every');
    await waitExit(root, e.slug!);
    await waitChild(child);
    return { record, settled: settleLaunchRecord(root, e.slug!)!, e };
  };
  const first = await run('exit 1');
  assert.equal(first.record.lastOutcome, null, 'il primo giro di sempre non ha un giro prima');
  assert.equal(first.settled.exit, 1);
  const second = await run('exit 3');
  assert.equal(second.settled.exit, 3, 'il record dice com\'è finito il tentativo');
  assert.equal(second.settled.lastOutcome!.exit, 1, 'e porta il giro vero di prima');
  assert.equal(second.settled.lastOutcome!.endedAt, first.settled.endedAt);
  const third = await run('exit 3');
  assert.equal(third.settled.lastOutcome!.exit, 1, 'due tentativi di fila non perdono il giro vero');
  assert.equal(lastTrueRecord(third.settled, third.e.noOutcome)!.exit, 1);
  const fourth = await run('exit 0');
  assert.equal(fourth.settled.exit, 0);
  assert.equal(lastTrueRecord(fourth.settled, fourth.e.noOutcome), fourth.settled, 'un giro vero torna a essere il record');
});
