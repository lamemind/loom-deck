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
  resolveSpawn,
  saveSpawnOverrides,
  serializeSpawnBlock,
  type SpawnOverride,
} from '../src/spawn-config.js';
import { spawnAction, type SpawnActionId } from '../src/spawn-catalog.js';
import { loadPromptCatalog, type CatalogEntry } from '../src/prompt-catalog.js';

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

// ── resolve: default del deck ← override di progetto ───────────────────────

/** Un catalogo dati finto: il merge si asserisce sui gradini, non sul contenuto
 *  reale di `scripts/prompt-catalog` (che ha un test suo). */
const CATALOG = new Map<string, CatalogEntry>([
  ['run', { template: '/loom-works:run-task {TASK}', model: 'opus' }],
  ['preflight', { template: '/loom-works:preflight-task {TASK}' }],
]);

const NONE = new Map();

test('senza override: i valori cablati nella riga sono i default', () => {
  const r = resolveSpawn(spawnAction('unwrap')!, NONE, CATALOG, { path: 'runtime reference' });
  assert.equal(r.model, 'sonnet');
  assert.match(r.prompt!, /^lancia md-wrap modo apply su runtime reference /);
  assert.equal(r.title, '📏 runtime reference');
  assert.equal(r.overridden.size, 0);
});

test('senza override: un’azione con un kind prende modello e prompt dal catalogo dati', () => {
  const r = resolveSpawn(spawnAction('run')!, NONE, CATALOG, { TASK: 'T42', slug: 'la mia task' });
  assert.equal(r.model, 'opus');
  assert.equal(r.prompt, '/loom-works:run-task T42');
  assert.equal(r.title, '🚀 la mia task');
});

test('riga di catalogo dati senza modello → si cade su MODEL_DEFAULT', () => {
  const r = resolveSpawn(spawnAction('preflight')!, NONE, CATALOG, { TASK: 'T42', slug: 'x' });
  assert.equal(r.model, 'fable');
});

test('catalogo dati assente: nessun prompt inventato dal deck', () => {
  // Un default scritto nel deck sarebbe la copia del catalogo che il file dati
  // esiste per non avere, e divergerebbe in silenzio.
  const r = resolveSpawn(spawnAction('checkpoint')!, NONE, new Map(), { TASK: 'T1', slug: 'x' });
  assert.equal(r.prompt, '');
  assert.equal(r.model, 'fable');
});

test('l’override vince su entrambe le sorgenti di default, cella per cella', () => {
  const ov = entries([['run', { model: 'haiku', prompt: 'fai {TASK} a modo mio' }]]);
  const r = resolveSpawn(spawnAction('run')!, ov, CATALOG, { TASK: 'T42', slug: 'la mia task' });
  assert.equal(r.model, 'haiku');
  assert.equal(r.prompt, 'fai T42 a modo mio');
  // Il titolo non è stato toccato: resta il default, e la riga lo sa.
  assert.equal(r.title, '🚀 la mia task');
  assert.deepEqual([...r.overridden].sort(), ['model', 'prompt']);
});

test('un override a vuoto è onorato: nessun titolo, nessun prompt', () => {
  const ov = entries([['run', { title: '', prompt: '' }]]);
  const r = resolveSpawn(spawnAction('run')!, ov, CATALOG, { TASK: 'T42', slug: 'la mia task' });
  assert.equal(r.title, null, 'titolo a vuoto = nessuna nota');
  assert.equal(r.prompt, '', 'prompt a vuoto = nessun prompt, non il default');
});

test('un buco senza valore spegne il titolo invece di lasciare il solo prefisso', () => {
  // `📐` da solo sarebbe uguale per ogni task: peggio di nessun titolo.
  const r = resolveSpawn(spawnAction('preflight')!, NONE, CATALOG, { TASK: 'T42', slug: '' });
  assert.equal(r.title, null);
});

test('il titolo si riduce DOPO l’interpolazione: i buchi portano dentro l’alfabeto sporco', () => {
  const r = resolveSpawn(spawnAction('drain')!, NONE, CATALOG, { file: 'T158-nozioni.md' });
  assert.equal(r.title, '🧹 T158-nozionimd');
});

test('il prompt del drain resta al chiamante: la skill è una funzione della natura', () => {
  const r = resolveSpawn(spawnAction('drain')!, NONE, CATALOG, { file: 'x' });
  assert.equal(r.prompt, null);
  assert.equal(r.model, 'fable');
});

test('la nuda non ha un titolo da risolvere', () => {
  const r = resolveSpawn(spawnAction('bare')!, NONE, CATALOG, {});
  assert.equal(r.title, null);
  assert.equal(r.prompt, '');
  assert.equal(r.model, 'opus');
});

test('project status: opus e la sua skill, senza titolo', () => {
  const r = resolveSpawn(spawnAction('project-status')!, NONE, CATALOG, {});
  assert.equal(r.model, 'opus');
  assert.equal(r.prompt, '/loom-works:recap-status-project');
  assert.equal(r.title, null);
});

test('col catalogo dati VERO le sette azioni su task restano quelle di prima', () => {
  // Il gate contro la regressione silenziosa del refactoring: prima di T161 il
  // modello di questi kind veniva da `modelFor` alla sede di chiamata, ora dal
  // merge — e deve dare lo stesso valore.
  const real = loadPromptCatalog();
  const model = (id: SpawnActionId) =>
    resolveSpawn(spawnAction(id)!, NONE, real, { TASK: 'T42', slug: 'x' }).model;
  assert.equal(model('recap'), 'opus');
  assert.equal(model('recap-task'), 'opus');
  assert.equal(model('recap-epic'), 'opus');
  assert.equal(model('preflight'), 'fable');
  assert.equal(model('run'), 'opus');
  assert.equal(model('checkpoint'), 'opus');
  assert.equal(model('none'), 'opus');
  assert.equal(
    resolveSpawn(spawnAction('none')!, NONE, real, { TASK: 'T42', slug: 'x' }).prompt,
    '',
    'open resta senza prompt',
  );
});
