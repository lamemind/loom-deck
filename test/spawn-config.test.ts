// T161 — il blocco `spawn` di `.claude/loom-works.json`: formato, validazione
// al confine, scrittura.
//
// Il file è committato, editabile a mano e NON è del deck: regge identità,
// label, surface e registry di compass. Le asserzioni che contano qui sono
// quindi due — che una voce sbagliata non porti via le altre, e che il saver
// non tocchi niente di ciò che non è suo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPAWN_BLOCK,
  loadSpawnOverrides,
  parseSpawnOverrides,
  saveSpawnOverrides,
  serializeSpawnBlock,
  type SpawnOverride,
} from '../src/spawn-config.js';
import type { SpawnActionId } from '../src/spawn-catalog.js';

/** Un progetto finto col suo `.claude/loom-works.json`. */
function project(doc: unknown | null): string {
  const root = mkdtempSync(join(tmpdir(), 'loom-spawn-cfg-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (doc !== null) {
    const text = typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n';
    writeFileSync(join(root, '.claude', 'loom-works.json'), text);
  }
  return root;
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.claude', 'loom-works.json'), 'utf8'));
}

function entries(pairs: Array<[SpawnActionId, SpawnOverride]>) {
  return new Map(pairs);
}

// ── parse ──────────────────────────────────────────────────────────────────

test('blocco assente → nessun override e nessun avviso', () => {
  const r = parseSpawnOverrides({ id: 'x', name: 'x' });
  assert.equal(r.entries.size, 0);
  assert.deepEqual(r.warnings, []);
});

test('una voce buona entra coi soli campi scritti', () => {
  const r = parseSpawnOverrides({ [SPAWN_BLOCK]: { run: { model: 'sonnet' } } });
  assert.deepEqual(r.entries.get('run'), { model: 'sonnet' });
  assert.deepEqual(r.warnings, []);
});

test('una voce sbagliata cade da sola: il resto del blocco vive', () => {
  // È il punto della validazione per voce: un refuso su una riga non deve
  // spegnere in silenzio gli override di tutte le altre.
  const r = parseSpawnOverrides({
    [SPAWN_BLOCK]: {
      run: { model: 'sonnet' },
      'azione-che-non-esiste': { model: 'opus' },
      preflight: { model: 'claude-opus-5' },
    },
  });
  assert.deepEqual(r.entries.get('run'), { model: 'sonnet' });
  assert.equal(r.entries.has('preflight'), false, 'il solo campo cade, e la voce resta vuota');
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings.join('\n'), /azione-che-non-esiste/);
  assert.match(r.warnings.join('\n'), /claude-opus-5/);
});

test('un campo su una cella fissa cade e lo dice con la sua ragione', () => {
  const r = parseSpawnOverrides({ [SPAWN_BLOCK]: { bare: { title: 'ciao', model: 'haiku' } } });
  assert.deepEqual(r.entries.get('bare'), { model: 'haiku' });
  assert.match(r.warnings.join('\n'), /bare\.title: nessun sessionId pinnato/);
});

test('il titolo si riduce alla lettura, non solo al salvataggio', () => {
  // Il file è editabile a mano: se la riduzione stesse solo nel saver, un
  // titolo scritto col vi comparirebbe intero nella pagina e mutilato nella tab.
  const r = parseSpawnOverrides({ [SPAWN_BLOCK]: { run: { title: "🔥 p'ova   {slug}!" } } });
  assert.equal(r.entries.get('run')?.title, 'pova {slug}');
});

test('vuoto non è assente: un titolo svuotato resta un override', () => {
  const r = parseSpawnOverrides({ [SPAWN_BLOCK]: { run: { title: '' } } });
  assert.deepEqual(r.entries.get('run'), { title: '' });
});

test('un blocco che non è un oggetto viene ignorato, non fa cadere il file', () => {
  const r = parseSpawnOverrides({ [SPAWN_BLOCK]: ['run'] });
  assert.equal(r.entries.size, 0);
  assert.equal(r.warnings.length, 1);
});

// ── load ───────────────────────────────────────────────────────────────────

test('file assente → nessun override e NESSUN avviso', () => {
  // È lo stato normale di un progetto che non ha mai aperto la pagina: dirlo a
  // ogni avvio sarebbe lo stesso messaggio per sempre.
  const r = loadSpawnOverrides(project(null));
  assert.equal(r.entries.size, 0);
  assert.deepEqual(r.warnings, []);
});

test('file illeggibile come JSON → default CON avviso', () => {
  // Qui un file c'è, e sta dicendo qualcosa che non si riesce a leggere.
  const r = loadSpawnOverrides(project('{ questo non è json'));
  assert.equal(r.entries.size, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /non si parsa/);
});

test('load legge il blocco del file vero', () => {
  const root = project({ id: 'p', name: 'p', [SPAWN_BLOCK]: { unwrap: { model: 'haiku' } } });
  assert.deepEqual(loadSpawnOverrides(root).entries.get('unwrap'), { model: 'haiku' });
});

// ── serialize ──────────────────────────────────────────────────────────────

test('nessun override → nessun blocco, non un blocco vuoto', () => {
  assert.equal(serializeSpawnBlock(new Map()), undefined);
  assert.equal(serializeSpawnBlock(entries([['run', {}]])), undefined);
});

test('le voci si scrivono nell’ordine del catalogo, non in quello di modifica', () => {
  // Il file è committato e lo si legge in diff: una riga che si sposta da sola a
  // ogni salvataggio è rumore su cui poi si fa merge.
  const block = serializeSpawnBlock(
    entries([
      ['unwrap', { model: 'opus' }],
      ['none', { title: 'x' }],
      ['run', { model: 'haiku' }],
    ]),
  );
  assert.deepEqual(Object.keys(block!), ['none', 'run', 'unwrap']);
});

// ── save ───────────────────────────────────────────────────────────────────

test('il saver conserva ogni altra chiave, e il loro ordine', () => {
  const root = project({
    id: 'p',
    emoji: '🧵',
    name: 'p',
    surfaces: { claude: true, deck: true },
    order: 50,
  });
  saveSpawnOverrides(root, entries([['run', { model: 'haiku' }]]));
  const doc = readConfig(root);
  assert.deepEqual(Object.keys(doc), ['id', 'emoji', 'name', 'surfaces', 'order', SPAWN_BLOCK]);
  assert.deepEqual(doc.surfaces, { claude: true, deck: true });
  assert.deepEqual(doc[SPAWN_BLOCK], { run: { model: 'haiku' } });
});

test('un override rimosso non lascia residui: il blocco sparisce', () => {
  const root = project({ id: 'p', name: 'p', [SPAWN_BLOCK]: { run: { model: 'haiku' } } });
  saveSpawnOverrides(root, new Map());
  const doc = readConfig(root);
  assert.equal(SPAWN_BLOCK in doc, false);
  assert.deepEqual(Object.keys(doc), ['id', 'name']);
});

test('file rotto → il saver RIFIUTA di scrivere invece di rigenerarlo', () => {
  // `loom-works.json` regge identità, label e registry di compass: sostituirlo
  // con uno rigenerato dal deck significherebbe perderli, e il deck non li
  // conosce nemmeno tutti.
  const root = project('{ rotto');
  const before = readFileSync(join(root, '.claude', 'loom-works.json'), 'utf8');
  assert.throws(() => saveSpawnOverrides(root, entries([['run', { model: 'haiku' }]])));
  assert.equal(readFileSync(join(root, '.claude', 'loom-works.json'), 'utf8'), before);
});

test('file assente → il saver rifiuta: un progetto non registrato resta tale', () => {
  assert.throws(() => saveSpawnOverrides(project(null), entries([['run', { model: 'haiku' }]])));
});

test('scritto e riletto: il giro completo non perde niente', () => {
  const root = project({ id: 'p', name: 'p' });
  const written = entries([
    ['run', { model: 'haiku', title: '🚀 {slug} mio', prompt: 'fai {TASK} adesso' }],
    ['bare', { model: 'opus' }],
  ]);
  saveSpawnOverrides(root, written);
  const back = loadSpawnOverrides(root);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.entries.get('run'), {
    title: '🚀 {slug} mio',
    model: 'haiku',
    prompt: 'fai {TASK} adesso',
  });
  assert.deepEqual(back.entries.get('bare'), { model: 'opus' });
});
