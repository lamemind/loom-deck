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
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLaunch } from '../src/config.js';
import {
  launchDue,
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

function entry(label: string, command: string) {
  return parseLaunch({ launch: [{ label, command, capture: true }] })[0]!;
}

const rec = (over: Partial<LaunchRecord>): LaunchRecord => ({
  pid: null,
  procStart: null,
  startedAt: 1_000,
  endedAt: 2_000,
  exit: 0,
  origin: 'tasto',
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
