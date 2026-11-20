import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget } from '../src/endpoint-close.js';
import {
  discoverLiveSessions,
  discoverProjectProcesses,
  liveSig,
  parseLiveEntry,
  parseRegistryEntry,
  processClass,
  procStartOf,
} from '../src/live-sessions.js';
import type { LiveSession } from '../src/live-sessions.js';

// Riga reale di /proc/<pid>/stat, troncata dopo il campo 22 (starttime = 48757):
// pid comm state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt
// cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime
const STAT =
  '10358 (node) S 10340 10358 10340 34816 10358 4194304 ' +
  '120000 5000 30 0 900 200 10 5 20 0 12 0 48757 1234567 8901 18446744073709551615';

test('procStartOf legge il campo 22', () => {
  assert.equal(procStartOf(STAT), '48757');
});

test('procStartOf regge un comm con spazi e parentesi', () => {
  // Il campo comm è arbitrario: uno split da inizio riga sfaserebbe tutto ciò
  // che segue, ed è il motivo per cui il taglio è sull'ULTIMA parentesi.
  const weird = STAT.replace('(node)', '(my weird (proc) name)');
  assert.equal(procStartOf(weird), '48757');
});

test('procStartOf su riga senza parentesi → null', () => {
  assert.equal(procStartOf('spazzatura senza parentesi'), null);
});

const ENTRY = JSON.stringify({
  pid: 10358,
  sessionId: '8028d09b-213e-4747-9c2d-bfb951a10116',
  cwd: '/home/u/proj',
  procStart: '48757',
  status: 'busy',
  name: '🧵 proj · T62',
  version: '2.1.223',
});

test('parseLiveEntry estrae i campi utili', () => {
  const p = parseLiveEntry(ENTRY, 10358);
  assert.ok(p);
  assert.equal(p.procStart, '48757');
  assert.equal(p.entry.sessionId, '8028d09b-213e-4747-9c2d-bfb951a10116');
  assert.equal(p.entry.status, 'busy');
  assert.equal(p.entry.cwd, '/home/u/proj');
});

test('parseLiveEntry: il pid viene dal NOME FILE, non dal campo omonimo', () => {
  // Far divergere le due cose renderebbe il guard procStart verificabile su un
  // processo diverso da quello di cui si sta decidendo la liveness.
  const p = parseLiveEntry(ENTRY, 999);
  assert.equal(p?.entry.pid, 999);
});

test('parseLiveEntry porta lo stato grezzo del registro e procStart (T204)', () => {
  const shell = parseLiveEntry(ENTRY.replace('"busy"', '"shell"'), 1);
  assert.equal(shell?.entry.status, 'idle', 'lo stato a due valori appiattisce shell');
  assert.equal(shell?.entry.state, 'shell', 'quello grezzo no');
  assert.equal(parseLiveEntry(ENTRY.replace('"busy"', '"waiting"'), 1)?.entry.state, 'waiting');
  assert.equal(parseLiveEntry(ENTRY.replace('"status":"busy",', ''), 1)?.entry.state, '');
  assert.equal(parseLiveEntry(ENTRY, 1)?.entry.procStart, '48757');
});

test('parseLiveEntry normalizza lo status a due valori', () => {
  const idle = parseLiveEntry(ENTRY.replace('"busy"', '"idle"'), 1);
  assert.equal(idle?.entry.status, 'idle');
  // Un valore introdotto da una versione futura non può significare «viva» da sé.
  const future = parseLiveEntry(ENTRY.replace('"busy"', '"compacting"'), 1);
  assert.equal(future?.entry.status, 'idle');
});

test('parseLiveEntry: senza procStart l assenza del guard scarta l entry', () => {
  const noGuard = JSON.stringify({ pid: 1, sessionId: 'a', cwd: '/p' });
  assert.equal(parseLiveEntry(noGuard, 1), null);
});

test('parseLiveEntry: senza sessionId o cwd → null', () => {
  assert.equal(parseLiveEntry(JSON.stringify({ procStart: '1', cwd: '/p' }), 1), null);
  assert.equal(parseLiveEntry(JSON.stringify({ procStart: '1', sessionId: 'a' }), 1), null);
});

test('parseLiveEntry: un job in background non è una conversazione', () => {
  // Fork parkeggiato / spare pty host: pid vivo, stesso cwd del progetto,
  // `entrypoint:"cli"` come una sessione vera — l'unico campo che discrimina è
  // `kind`. Elencarlo conta una tab che non esiste.
  const bg = JSON.stringify({ ...JSON.parse(ENTRY), kind: 'bg', entrypoint: 'cli' });
  assert.equal(parseLiveEntry(bg, 10358), null);
  // Il gemello vecchio: uno spawn dell'SDK, che si dichiara sull'entrypoint.
  const sdk = JSON.stringify({ ...JSON.parse(ENTRY), entrypoint: 'sdk' });
  assert.equal(parseLiveEntry(sdk, 10358), null);
});

test('parseLiveEntry: un turno claude -p non è una tab (T206)', () => {
  const sdkCli = JSON.stringify({ ...JSON.parse(ENTRY), entrypoint: 'sdk-cli', kind: 'interactive' });
  assert.equal(parseLiveEntry(sdkCli, 10358), null);
});

test('processClass: tab e headless si riconoscono in positivo, il resto è fuori (T206)', () => {
  assert.equal(processClass({ entrypoint: 'cli', kind: 'interactive' }), 'tab');
  assert.equal(processClass({ entrypoint: 'sdk-cli', kind: 'interactive' }), 'headless');
  // Il job in background scrive `cli` come una tab: allargare il filtro lo
  // farebbe entrare.
  assert.equal(processClass({ entrypoint: 'cli', kind: 'bg' }), null);
  assert.equal(processClass({ entrypoint: 'sdk-cli', kind: 'bg' }), null);
  assert.equal(processClass({ entrypoint: 'sdk', kind: 'interactive' }), null);
  // Campi assenti: il default di `parseRegistryEntry` vale tab.
  const r = parseRegistryEntry(ENTRY, 1);
  assert.ok(r);
  assert.equal(processClass(r), 'tab');
});

test('discoverProjectProcesses: tab e headless in due mappe, una lettura sola (T206)', () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-live-'));
  const base = JSON.parse(ENTRY);
  const write = (pid: number, extra: Record<string, unknown>) =>
    writeFileSync(join(root, `${pid}.json`), JSON.stringify({ ...base, pid, ...extra }));
  write(1, { sessionId: 'tab-1', entrypoint: 'cli', kind: 'interactive' });
  write(2, { sessionId: 'hl-2', entrypoint: 'sdk-cli', kind: 'interactive' });
  write(3, { sessionId: 'bg-3', entrypoint: 'cli', kind: 'bg' });
  write(4, { sessionId: 'hl-4', entrypoint: 'sdk-cli', kind: 'interactive', cwd: '/altro/progetto' });
  // Stessa conversazione in tab e in headless: resta fra le vive.
  write(5, { sessionId: 'both', entrypoint: 'cli', kind: 'interactive' });
  write(6, { sessionId: 'both', entrypoint: 'sdk-cli', kind: 'interactive' });
  write(7, { sessionId: 'hl-dead', entrypoint: 'sdk-cli', kind: 'interactive' });
  const alive = (pairs: readonly { pid: number }[]) => pairs.map((p) => p.pid !== 7);
  const { live, headless } = discoverProjectProcesses('/home/u/proj', root, alive);
  assert.deepEqual([...live.keys()].sort(), ['both', 'tab-1']);
  assert.deepEqual([...headless.keys()].sort(), ['hl-2']);
  assert.equal(headless.get('hl-2')?.pid, 2);
});

test('close dell’endpoint: un turno headless in corso non è un bersaglio (T206)', { skip: process.platform !== 'linux' }, () => {
  // Il processo vero di questo test fa da turno headless: la liveness è quella
  // della piattaforma, la stessa che la chiusura legge (`overlays/endpoint.ts`).
  const root = mkdtempSync(join(tmpdir(), 'deck-live-close-'));
  const procStart = procStartOf(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))!;
  const sid = 'eeeeeeee-0000-4000-8000-000000000206';
  writeFileSync(
    join(root, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: sid, cwd: '/home/u/proj', procStart, status: 'idle', entrypoint: 'sdk-cli', kind: 'interactive' }),
  );
  const before = process.env.LOOM_DECK_LIVE_SESSIONS_ROOT;
  process.env.LOOM_DECK_LIVE_SESSIONS_ROOT = root;
  try {
    assert.equal(discoverProjectProcesses('/home/u/proj').headless.has(sid), true, 'il turno è vivo e riconosciuto');
    const live = discoverLiveSessions('/home/u/proj');
    assert.equal(live.has(sid), false);
    assert.deepEqual(resolveTarget(sid, live), { none: true }, 'la chiusura non lo trova fra le vive');
  } finally {
    if (before === undefined) delete process.env.LOOM_DECK_LIVE_SESSIONS_ROOT;
    else process.env.LOOM_DECK_LIVE_SESSIONS_ROOT = before;
  }
});

test('parseLiveEntry: kind ed entrypoint assenti valgono interattiva', () => {
  // Una versione del CLI che non scrivesse i due campi non deve svuotare la lista.
  const p = parseLiveEntry(JSON.stringify({ ...JSON.parse(ENTRY), kind: 'interactive' }), 1);
  assert.ok(p);
  assert.ok(parseLiveEntry(ENTRY, 1));
});

test('parseLiveEntry: JSON rotto → null, mai un throw', () => {
  // Il file può essere letto mentre il CLI lo riscrive.
  assert.equal(parseLiveEntry('{"pid":1,', 1), null);
});

const live = (sessionId: string, pid: number, status: 'idle' | 'busy'): LiveSession => ({
  sessionId,
  pid,
  status,
  state: status,
  procStart: '',
  name: '',
  cwd: '/p',
  startedAt: 0,
});

test('liveSig cambia quando cambia lo stato', () => {
  const a = new Map([['s1', live('s1', 10, 'idle')]]);
  const b = new Map([['s1', live('s1', 10, 'busy')]]);
  assert.notEqual(liveSig(a), liveSig(b));
});

test('liveSig cambia quando lo stesso sessionId si sposta di processo', () => {
  // Caso `/clear`: insieme e stato identici, processo diverso.
  const a = new Map([['s1', live('s1', 10, 'idle')]]);
  const b = new Map([['s1', live('s1', 11, 'idle')]]);
  assert.notEqual(liveSig(a), liveSig(b));
});

test('liveSig è stabile rispetto all ordine di iterazione', () => {
  const a = new Map([
    ['s1', live('s1', 10, 'idle')],
    ['s2', live('s2', 11, 'busy')],
  ]);
  const b = new Map([
    ['s2', live('s2', 11, 'busy')],
    ['s1', live('s1', 10, 'idle')],
  ]);
  assert.equal(liveSig(a), liveSig(b));
});
