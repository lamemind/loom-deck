import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarTitle, SIDECAR_TITLE_MAX } from '../src/session-meta.js';
import { NO_TITLE, type Session } from '../src/sessions.js';

const sess = (over: Partial<Session> = {}): Session => ({
  sessionId: 'sid',
  cwd: '/p',
  gitBranch: 'main',
  parentUuid: null,
  title: '',
  ts: 0,
  path: '/p/sid.jsonl',
  sizeBytes: 100,
  turns: 1,
  customTitle: '',
  firstPrompt: '',
  lastReply: '',
  model: '',
  bodies: [],
  ...over,
});

// ── titolo custom: il residuo, non il grezzo ────────────────────────────────

test('titolo custom: togli core e task id, resta la nota di spawn', () => {
  const s = sess({ title: '🧵 loom-works · T32 revisione reader', customTitle: 'x' });
  assert.equal(sidecarTitle(s, 'loom-works', 'T32'), 'revisione reader');
});

test('titolo custom senza nota: residuo vuoto → assenza, non si scrive', () => {
  const s = sess({
    title: '🧵 loom-works · T32',
    customTitle: 'x',
    firstPrompt: '/loom-works:recap-status-task T32',
  });
  assert.equal(
    sidecarTitle(s, 'loom-works', 'T32'),
    '',
    'NON cade sul primo prompt: nel menu sarebbe l’invocazione di una skill',
  );
});

test('titolo custom, core sconosciuto: niente da togliere → titolo intatto', () => {
  const s = sess({ title: '🧵 loom-works · T32 nota', customTitle: 'x' });
  assert.equal(sidecarTitle(s, null, null), '🧵 loom-works · T32 nota');
});

test('titolo custom: il task id si toglie per token intero, T5 non morde T59', () => {
  const s = sess({ title: '🧵 loom-works · T59 prova', customTitle: 'x' });
  assert.equal(sidecarTitle(s, 'loom-works', 'T5'), 'T59 prova');
});

// ── senza titolo custom: il primo prompt, intatto ───────────────────────────

test('senza titolo custom: il titolo è il primo prompt e vale intatto', () => {
  const s = sess({ title: 'come si chiude un worktree lane?' });
  assert.equal(
    sidecarTitle(s, 'loom-works', 'T32'),
    'come si chiude un worktree lane?',
    'nessuno strip: qui il titolo non è la label di una tab',
  );
});

test('segnaposto: (senza titolo) è assenza, non un titolo da copiare', () => {
  assert.equal(sidecarTitle(sess({ title: NO_TITLE }), 'loom-works', null), '');
});

// ── cap ─────────────────────────────────────────────────────────────────────

test('cap: taglia a SIDECAR_TITLE_MAX code point', () => {
  const s = sess({ title: 'a'.repeat(SIDECAR_TITLE_MAX + 40) });
  assert.equal(sidecarTitle(s, null, null).length, SIDECAR_TITLE_MAX);
});

test('cap: non spezza una coppia surrogata', () => {
  // Emoji astrali: due code unit ciascuna, un code point ciascuna. Il taglio a
  // code point ne conta 120 esatte e non lascia mai un surrogato spaiato.
  const s = sess({ title: '🧵'.repeat(SIDECAR_TITLE_MAX + 5) });
  const out = sidecarTitle(s, null, null);
  assert.equal([...out].length, SIDECAR_TITLE_MAX);
  assert.equal(out, '🧵'.repeat(SIDECAR_TITLE_MAX));
});

test('cap: un titolo sotto soglia passa identico', () => {
  const s = sess({ title: 'corto' });
  assert.equal(sidecarTitle(s, null, null), 'corto');
});
