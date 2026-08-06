import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveSig, parseLiveEntry, procStartOf } from '../src/live-sessions.js';
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

test('parseLiveEntry: JSON rotto → null, mai un throw', () => {
  // Il file può essere letto mentre il CLI lo riscrive.
  assert.equal(parseLiveEntry('{"pid":1,', 1), null);
});

const live = (sessionId: string, pid: number, status: 'idle' | 'busy'): LiveSession => ({
  sessionId,
  pid,
  status,
  name: '',
  cwd: '/p',
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
