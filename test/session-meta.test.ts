import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarGaps, sidecarTitle, SIDECAR_TITLE_MAX } from '../src/session-meta.js';
import { loadSessionIndex, taskIndexPath } from '../src/task-index.js';
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

// ── i buchi da riempire ─────────────────────────────────────────────────────

const gapsOf = (input: {
  pinned?: [string, number][];
  sessions?: Session[];
  bindings?: [string, string][];
  titles?: [string, string][];
  models?: [string, string][];
  core?: string | null;
}) =>
  sidecarGaps({
    pinned: new Map(input.pinned ?? []),
    sessions: input.sessions ?? [],
    bindings: new Map(input.bindings ?? []),
    titles: new Map(input.titles ?? []),
    models: new Map(input.models ?? []),
    core: input.core ?? 'loom-works',
  });

test('buchi: nessuna pinnata → nessun lavoro', () => {
  assert.deepEqual(gapsOf({ sessions: [sess({ title: 'x' })] }), []);
});

test('buchi: pinnata senza titolo nel sidecar → append di title e model', () => {
  const s = sess({ sessionId: 'a', title: 'come chiudo una lane?', model: 'claude-opus-5' });
  assert.deepEqual(gapsOf({ pinned: [['a', 0]], sessions: [s] }), [
    { sessionId: 'a', title: 'come chiudo una lane?', model: 'opus' },
  ]);
});

test('CONVERGENZA: un sidecar già allineato non produce nessun append', () => {
  const s = sess({ sessionId: 'a', title: 'titolo', model: 'claude-sonnet-5' });
  const primo = gapsOf({ pinned: [['a', 0]], sessions: [s] });
  assert.equal(primo.length, 1);
  // Il giro dopo legge quello che il giro prima ha scritto: se il confronto
  // non combaciasse, il deck appenderebbe a ogni tick del poll per sempre.
  const dopo = gapsOf({
    pinned: [['a', 0]],
    sessions: [s],
    titles: [['a', primo[0]!.title!]],
    models: [['a', primo[0]!.model!]],
  });
  assert.deepEqual(dopo, []);
});

test('CONVERGENZA: regge anche su un titolo oltre il cap', () => {
  const s = sess({ sessionId: 'a', title: 'x'.repeat(SIDECAR_TITLE_MAX + 50) });
  const primo = gapsOf({ pinned: [['a', 0]], sessions: [s] });
  const dopo = gapsOf({ pinned: [['a', 0]], sessions: [s], titles: [['a', primo[0]!.title!]] });
  assert.deepEqual(dopo, [], 'il cap è applicato da un lato solo, quindi il confronto torna');
});

test('buchi: titolo cambiato sotto → riallineamento del solo title', () => {
  const s = sess({ sessionId: 'a', title: 'titolo nuovo', model: 'claude-opus-5' });
  assert.deepEqual(
    gapsOf({
      pinned: [['a', 0]],
      sessions: [s],
      titles: [['a', 'titolo vecchio']],
      models: [['a', 'opus']],
    }),
    [{ sessionId: 'a', title: 'titolo nuovo' }],
  );
});

test('buchi: pinnata STALE → nessun append (niente da cui derivare)', () => {
  assert.deepEqual(gapsOf({ pinned: [['fantasma', 0]], sessions: [] }), []);
});

test('buchi: residuo vuoto → nessun append, non la cancellazione del campo', () => {
  const s = sess({
    sessionId: 'a',
    title: '🧵 loom-works · T32',
    customTitle: 'x',
    firstPrompt: '/loom-works:recap-status-task T32',
  });
  assert.deepEqual(gapsOf({ pinned: [['a', 0]], sessions: [s], bindings: [['a', 'T32']] }), []);
});

test('buchi: modello non riconducibile a un alias → si scrive il solo titolo', () => {
  const s = sess({ sessionId: 'a', title: 'titolo', model: 'qualcosa-di-ignoto' });
  assert.deepEqual(gapsOf({ pinned: [['a', 0]], sessions: [s] }), [
    { sessionId: 'a', title: 'titolo' },
  ]);
});

test('buchi: conversazione senza record assistant → nessun modello da scrivere', () => {
  const s = sess({ sessionId: 'a', title: 'titolo', model: '' });
  assert.deepEqual(gapsOf({ pinned: [['a', 0]], sessions: [s] }), [
    { sessionId: 'a', title: 'titolo' },
  ]);
});

test('buchi: solo le PINNATE, non tutte le conversazioni del progetto', () => {
  const a = sess({ sessionId: 'a', title: 'pinnata' });
  const b = sess({ sessionId: 'b', title: 'libera' });
  const out = gapsOf({ pinned: [['a', 0]], sessions: [a, b] });
  assert.deepEqual(out.map((g) => g.sessionId), ['a']);
});

test('buchi: il task id del binding entra nello strip della pinnata', () => {
  const s = sess({ sessionId: 'a', title: '🧵 loom-works · T59 prova', customTitle: 'x' });
  assert.deepEqual(gapsOf({ pinned: [['a', 0]], sessions: [s], bindings: [['a', 'T59']] }), [
    { sessionId: 'a', title: 'prova' },
  ]);
});

// ── la scrittura, e il freno sulla scrittura ────────────────────────────────

// Entrambi i casi girano in un SOTTOPROCESSO, e non per comodità: `NO_SPAWN` è
// letto all'import del modulo, quindi dentro la suite il valore è già fissato —
// la suite gira col freno tirato, o il gate su pseudo-terminale scriverebbe nel
// sidecar reale di chi la lancia. Il sottoprocesso è l'unico modo di misurare i
// due regimi nella stessa passata.
//
// Gira sul BUILD (`dist/`) e non sul sorgente: un sottoprocesso `node` non ha il
// loader di `tsx`. Il prezzo è che il test pretende un `npm run build` prima —
// che il publish fa da sé, e in locale è il comando che si lancia comunque.
function fillInSubprocess(root: string, brake: boolean): { status: number | null; err: string } {
  const script = `
    const {fillSidecarGaps} = await import(${JSON.stringify(join(process.cwd(), 'dist', 'session-meta.js'))});
    const n = fillSidecarGaps(${JSON.stringify(root)}, {
      pinned: new Map([['a', 0]]),
      sessions: [{sessionId:'a', cwd:'/p', gitBranch:'', parentUuid:null, title:'titolo',
                  ts:0, path:'/p/a.jsonl', sizeBytes:1, turns:1, customTitle:'',
                  firstPrompt:'', lastReply:'', model:'claude-opus-5', bodies:[]}],
      bindings: new Map(), titles: new Map(), models: new Map(), core: null,
    });
    process.stdout.write(String(n));
  `;
  const env = { ...process.env } as Record<string, string | undefined>;
  if (brake) env.LOOM_DECK_NO_SPAWN = '1';
  else delete env.LOOM_DECK_NO_SPAWN;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
  });
  return { status: r.status, err: r.stderr ?? '' };
}

test('scrittura: il buco finisce su disco, e il giro dopo non trova niente', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-fill-'));
  const r = fillInSubprocess(root, false);
  assert.equal(r.status, 0, r.err);
  const idx = loadSessionIndex(root);
  assert.equal(idx.titles.get('a'), 'titolo');
  assert.equal(idx.models.get('a'), 'opus');
  assert.equal(readFileSync(taskIndexPath(root), 'utf8').trim().split('\n').length, 1);
  // CONVERGENZA su disco, non solo in memoria: il giro successivo del poll
  // rilegge l'indice appena scritto e non deve trovare nulla da fare.
  assert.deepEqual(
    sidecarGaps({
      pinned: new Map([['a', 0]]),
      sessions: [sess({ sessionId: 'a', title: 'titolo', model: 'claude-opus-5' })],
      bindings: new Map(),
      titles: idx.titles,
      models: idx.models,
      core: null,
    }),
    [],
    'un secondo giro appenderebbe un record a ogni tick, per sempre',
  );
});

test('FRENO: con LOOM_DECK_NO_SPAWN il sidecar non viene toccato', () => {
  // Il gate su pseudo-terminale avvia il deck VERO con cwd la project root del
  // cappello: senza freno, ogni run della suite appenderebbe record nel sidecar
  // reale di chi la lancia.
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-brake-'));
  const r = fillInSubprocess(root, true);
  assert.equal(r.status, 0, r.err);
  assert.throws(() => readFileSync(taskIndexPath(root), 'utf8'), 'nessun file creato');
});
