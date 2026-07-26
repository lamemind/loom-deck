import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNote,
  appendPin,
  appendSessionRecord,
  appendTaskBinding,
  loadSessionIndex,
  taskIndexPath,
} from '../src/task-index.js';

const root = () => mkdtempSync(join(tmpdir(), 'loom-deck-idx-'));

test('indice vuoto: file assente → mappe vuote, nessun throw', () => {
  const { bindings, forkOf } = loadSessionIndex(root());
  assert.equal(bindings.size, 0);
  assert.equal(forkOf.size, 0);
});

test('binding task: append e rilettura', () => {
  const r = root();
  appendTaskBinding(r, 'sid-1', 'T28');
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('sid-1'), 'T28');
  assert.equal(forkOf.size, 0);
});

test('fork di sessione scoped: il ramo porta binding e lineage', () => {
  const r = root();
  appendTaskBinding(r, 'origine', 'T28');
  appendSessionRecord(r, { sessionId: 'ramo', taskId: 'T28', forkOf: 'origine' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('ramo'), 'T28', 'il ramo eredita la task dell’origine');
  assert.equal(forkOf.get('ramo'), 'origine');
  assert.equal(forkOf.has('origine'), false, 'l’origine non è un fork');
});

test('fork di sessione spot: lineage senza task', () => {
  const r = root();
  appendSessionRecord(r, { sessionId: 'ramo', forkOf: 'origine' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.has('ramo'), false, 'nessun taskId → resta spot');
  assert.equal(forkOf.get('ramo'), 'origine');
});

test('campi indipendenti: un record di solo forkOf non cancella il binding', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T28');
  appendSessionRecord(r, { sessionId: 'sid', forkOf: 'altra' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('sid'), 'T28');
  assert.equal(forkOf.get('sid'), 'altra');
});

test('last-wins per campo su re-pin dello stesso sessionId', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T01');
  appendTaskBinding(r, 'sid', 'T02');
  assert.equal(loadSessionIndex(r).bindings.get('sid'), 'T02');
});

test('retrocompat: i record pre-T28 (solo taskId) restano validi', () => {
  const r = root();
  const p = taskIndexPath(r);
  mkdirSync(join(r, '.claude', 'loom'), { recursive: true });
  writeFileSync(p, '{"sessionId":"vecchia","taskId":"T19","ts":"2026-07-01T00:00:00Z"}\n');
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('vecchia'), 'T19');
  assert.equal(forkOf.size, 0);
});

test('righe corrotte o senza sessionId: skippate senza affondare la lettura', () => {
  const r = root();
  appendTaskBinding(r, 'buona', 'T28');
  writeFileSync(taskIndexPath(r), '{non json}\n{"taskId":"T99"}\n\n', { flag: 'a' });
  appendSessionRecord(r, { sessionId: 'ramo', forkOf: 'buona' });
  const { bindings, forkOf } = loadSessionIndex(r);
  assert.equal(bindings.get('buona'), 'T28');
  assert.equal(forkOf.get('ramo'), 'buona');
  assert.equal(bindings.size, 1);
});

// ── T50 · pin store ─────────────────────────────────────────────────────────

test('pin: append pinned:true → la sessione è nella mappa pinned', () => {
  const r = root();
  appendPin(r, 'sid-1', true);
  const { pinned } = loadSessionIndex(r);
  assert.equal(pinned.has('sid-1'), true);
});

test('unpin last-wins: pinned:false finale toglie la chiave', () => {
  const r = root();
  appendPin(r, 'sid', true);
  appendPin(r, 'sid', false);
  assert.equal(loadSessionIndex(r).pinned.has('sid'), false);
});

test('re-pin dopo unpin: la sessione torna pinnata, in cima (rango più alto)', () => {
  const r = root();
  appendPin(r, 'A', true); // rango 0
  appendPin(r, 'B', true); // rango 1
  appendPin(r, 'A', false); // A spinnata
  appendPin(r, 'A', true); // A ripinnata → rango 2 > B
  const { pinned } = loadSessionIndex(r);
  assert.equal(pinned.has('A'), true);
  assert.equal(pinned.has('B'), true);
  assert.ok((pinned.get('A') ?? -1) > (pinned.get('B') ?? -1), 'A pinnata più di recente di B');
});

test('rango di pin crescente nell’ordine di append (ultima pinnata = rango massimo)', () => {
  const r = root();
  appendPin(r, 'A', true);
  appendPin(r, 'B', true);
  const { pinned } = loadSessionIndex(r);
  assert.ok((pinned.get('B') ?? -1) > (pinned.get('A') ?? -1));
});

test('campi indipendenti: un pin non cancella il binding, e viceversa', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T50');
  appendPin(r, 'sid', true);
  const idx = loadSessionIndex(r);
  assert.equal(idx.bindings.get('sid'), 'T50', 'il pin non tocca il binding');
  assert.equal(idx.pinned.has('sid'), true);
});

test('pin: file assente → mappa pinned vuota, nessun throw', () => {
  assert.equal(loadSessionIndex(root()).pinned.size, 0);
});

// ── T53 · note store ────────────────────────────────────────────────────────

test('nota: append e rilettura', () => {
  const r = root();
  appendNote(r, 'sid-1', 'regex + reader');
  assert.equal(loadSessionIndex(r).notes.get('sid-1'), 'regex + reader');
});

test('nota last-wins: la seconda scrittura sostituisce la prima', () => {
  const r = root();
  appendNote(r, 'sid', 'prima');
  appendNote(r, 'sid', 'seconda');
  assert.equal(loadSessionIndex(r).notes.get('sid'), 'seconda');
});

test('nota vuota = cancellazione: la chiave sparisce dalla mappa', () => {
  const r = root();
  appendNote(r, 'sid', 'da togliere');
  appendNote(r, 'sid', '');
  assert.equal(
    loadSessionIndex(r).notes.has('sid'),
    false,
    'stringa vuota → nessuna nota, non una nota vuota',
  );
});

test('nota riscritta dopo la cancellazione: torna presente', () => {
  const r = root();
  appendNote(r, 'sid', 'v1');
  appendNote(r, 'sid', '');
  appendNote(r, 'sid', 'v2');
  assert.equal(loadSessionIndex(r).notes.get('sid'), 'v2');
});

test('campi indipendenti: la nota non tocca binding e pin, e viceversa', () => {
  const r = root();
  appendTaskBinding(r, 'sid', 'T53');
  appendPin(r, 'sid', true);
  appendNote(r, 'sid', 'annotata');
  const idx = loadSessionIndex(r);
  assert.equal(idx.bindings.get('sid'), 'T53');
  assert.equal(idx.pinned.has('sid'), true);
  assert.equal(idx.notes.get('sid'), 'annotata');
  // E l'inverso: un unpin successivo non deve portarsi via la nota.
  appendPin(r, 'sid', false);
  const dopo = loadSessionIndex(r);
  assert.equal(dopo.pinned.has('sid'), false);
  assert.equal(dopo.notes.get('sid'), 'annotata', 'la nota sopravvive allo spin');
});

test('retrocompat: i record pre-T53 (senza note) non azzerano una nota scritta', () => {
  const r = root();
  appendNote(r, 'sid', 'viva');
  // Record senza il campo `note`: il `typeof` deve ignorarlo, non trattarlo
  // come una cancellazione — altrimenti ogni pin successivo spegnerebbe la nota.
  appendSessionRecord(r, { sessionId: 'sid', forkOf: 'altra' });
  assert.equal(loadSessionIndex(r).notes.get('sid'), 'viva');
});

test('nota: file assente → mappa notes vuota, nessun throw', () => {
  assert.equal(loadSessionIndex(root()).notes.size, 0);
});
