// T176 — il composer della tab, PURO: argomenti, quattro assi, titolo, argv di
// `claude` e riga in-tab, sulle due piattaforme.
//
// La parità con lo script bash che il composer ha sostituito la misura
// `deck-run.test.ts` su Linux, sullo shim vero. Qui si misurano le regole una
// per una, e le due forme dell'uscita — l'argv che su Windows viaggia nell'env
// della tab e la riga che su Linux gira in `bash -lc` — sugli stessi ingressi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isUsageError, parseTabArgs, USAGE, type TabRequest } from '../src/tab-args.js';
import { composeTab, posixQuote, projectLabel, ptyxisArgv, type ComposeContext } from '../src/tab-compose.js';
import type { CatalogEntry } from '../src/prompt-catalog.js';
import { unixOnly } from './platform-gates.js';

const SID = '11111111-2222-3333-4444-555555555555';

const CATALOG = new Map<string, CatalogEntry>([
  ['recap', { template: '/loom-works:recap-status {TASK}', model: 'opus' }],
  ['preflight', { template: '/loom-works:preflight-task {TASK}', model: 'fable' }],
  ['run', { template: '/loom-works:run-task {TASK}', model: 'opus' }],
]);

function ctx(over: Partial<ComposeContext> = {}): ComposeContext {
  return { env: {}, config: null, catalog: CATALOG, catalogPath: '/cat', platform: 'linux', ...over };
}

function req(argv: string[]): TabRequest {
  const r = parseTabArgs(argv);
  assert.ok(!isUsageError(r), `argv rifiutato: ${argv.join(' ')} → ${isUsageError(r) ? r.lines[0] : ''}`);
  return r as TabRequest;
}

function usage(argv: string[]): string[] {
  const r = parseTabArgs(argv);
  assert.ok(isUsageError(r), `argv accettato: ${argv.join(' ')}`);
  return r.lines;
}

// ── gli argomenti ──────────────────────────────────────────────────────────

test('le due forme di un flag con valore si equivalgono', () => {
  assert.deepEqual(
    req(['T1', '--model', 'opus', '--prompt', 'ciao', '--title-note', 'n', '--session-id', SID]),
    req(['T1', '--model=opus', '--prompt=ciao', '--title-note=n', `--session-id=${SID}`]),
  );
});

test('--prompt vuoto è un prompt dato, il flag assente no', () => {
  assert.equal(req(['T1', '--prompt', '']).promptGiven, true);
  assert.equal(req(['T1']).promptGiven, false);
});

test('gli errori d’uso, nell’ordine e con le parole dello script', () => {
  assert.deepEqual(usage(['--no-task', 'T1']), ['--no-task e <TaskID> sono mutuamente esclusivi', USAGE]);
  assert.deepEqual(usage([]), [USAGE]);
  assert.match(usage(['T1', '--fork'])[0]!, /^--fork richiede --resume/);
  assert.deepEqual(usage(['T1', '--resume', SID, '--session-id', SID]).slice(0, 2), [
    '--resume e --session-id sono mutuamente esclusivi (la sessione ripresa ha già il suo id)',
    'usa --fork se vuoi un ramo con id nuovo',
  ]);
  assert.equal(
    usage(['T1', '--prompt-kind', 'bogus'])[0],
    "--prompt-kind ignoto: 'bogus' (usa none|recap|recap-task|recap-epic|preflight|run|checkpoint)",
  );
  assert.match(usage(['--no-task', '--prompt-kind', 'run'])[0]!, /^--prompt-kind richiede una task/);
  assert.match(usage(['T1', '--prompt', 'x', '--prompt-kind', 'run'])[0]!, /mutuamente esclusivi/);
  // Un secondo posizionale è un errore senza l'uso in coda, come nello script.
  assert.deepEqual(usage(['T1', 'T2']), ["argomento inatteso: 'T2'"]);
  assert.match(usage(['T1', '--model'])[0]!, /--model richiede un valore/);
});

test('un fork pinna un id nuovo, una ripresa nuda no', () => {
  assert.equal(req(['T1', '--resume', SID, '--fork', '--session-id', 'NEW']).sessionId, 'NEW');
});

// ── il titolo ──────────────────────────────────────────────────────────────

const LABELED = { id: 'demo', emoji: '🧵', name: 'demo', owner: 'LOCAL' };

test('la label è `{emoji} {name}`, owner escluso; senza file ricade su cc', () => {
  assert.equal(projectLabel(LABELED), '🧵 demo');
  assert.equal(projectLabel(null), '');
  assert.equal(projectLabel({ name: 'solo-nome' }), '');
  assert.equal(composeTab(req(['T1']), ctx()).title, 'cc T1');
  assert.equal(composeTab(req(['--no-task']), ctx()).title, 'cc');
  assert.equal(composeTab(req(['T1']), ctx({ config: LABELED })).title, '🧵 demo · T1');
  assert.equal(composeTab(req(['--no-task']), ctx({ config: LABELED })).title, '🧵 demo');
});

test('nota ridotta in coda alla task, fork in coda a tutto, label in testa', () => {
  const p = composeTab(req(['T64', '--resume', SID, '--fork', '--title-note', "l'apice; 🔥 ramo"]), ctx({ config: LABELED }));
  assert.equal(p.title, '🧵 demo · T64 lapice ramo · fork');
  // Una nota ridotta a vuoto non lascia nessun suffisso.
  assert.equal(composeTab(req(['T64', '--title-note', '🔥 !!']), ctx({ config: LABELED })).title, '🧵 demo · T64');
});

// ── i quattro assi ─────────────────────────────────────────────────────────

test('binding: LOOM_TASK sul ramo bound, mai su --no-task', () => {
  assert.deepEqual(composeTab(req(['T1']), ctx()).sessionEnv, { LOOM_TASK: 'T1' });
  assert.deepEqual(composeTab(req(['--no-task']), ctx()).sessionEnv, {});
});

test('continuità: la ripresa non porta prompt, il fork aggiunge --fork-session', () => {
  const resume = composeTab(req(['T1', '--resume', SID, '--prompt', 'ignorato']), ctx());
  assert.deepEqual(resume.claudeArgs.slice(-2), ['--resume', SID]);
  const fork = composeTab(req(['T1', '--resume', SID, '--fork', '--session-id', 'NEW']), ctx());
  assert.deepEqual(fork.claudeArgs.slice(-5), ['--session-id', 'NEW', '--resume', SID, '--fork-session']);
});

test('prompt: kind dal catalogo, letterale, none, nuda muta, ENTER_PROMPT', () => {
  const last = (argv: string[], over: Partial<ComposeContext> = {}) => composeTab(req(argv), ctx(over)).claudeArgs.at(-1);
  assert.equal(last(['T5', '--prompt-kind', 'run']), '/loom-works:run-task T5');
  assert.equal(last(['T5']), '/loom-works:recap-status T5');
  assert.equal(last(['T5', '--prompt', 'testo mio']), 'testo mio');
  // Senza prompt l'ultimo argomento è il modello: `none` non ha riga di catalogo.
  assert.equal(last(['T5', '--prompt-kind', 'none']), 'fable');
  assert.equal(last(['--no-task']), 'fable');
  assert.equal(last(['T5', '--prompt-kind', 'run'], { env: { LOOM_DECK_ENTER_PROMPT: 'x {TASK} {TASK}' } }), 'x T5 T5');
  assert.equal(last(['T5', '--prompt', 'mio'], { env: { LOOM_DECK_ENTER_PROMPT: 'x' } }), 'mio');
});

test('catalogo senza la voce: nessun prompt, e lo dice', () => {
  const p = composeTab(req(['T5', '--prompt-kind', 'checkpoint']), ctx());
  assert.equal(p.claudeArgs.at(-1), 'fable');
  assert.deepEqual(p.warnings, ["catalogo prompt non leggibile ('/cat'): sessione senza prompt iniziale"]);
});

test('modello: --model > LOOM_DECK_MODEL > catalogo > default, ignoto → default con avviso', () => {
  const model = (argv: string[], env = {}) => {
    const a = composeTab(req(argv), ctx({ env })).claudeArgs;
    return a[a.indexOf('--model') + 1];
  };
  assert.equal(model(['T1', '--model', 'haiku'], { LOOM_DECK_MODEL: 'sonnet' }), 'haiku');
  assert.equal(model(['T1', '--prompt-kind', 'run'], { LOOM_DECK_MODEL: 'sonnet' }), 'sonnet');
  assert.equal(model(['T1', '--prompt-kind', 'run']), 'opus');
  assert.equal(model(['T1', '--prompt-kind', 'preflight']), 'fable');
  assert.equal(model(['--no-task']), 'fable');
  const bogus = composeTab(req(['T1', '--model', 'bogus']), ctx());
  assert.ok(bogus.claudeArgs.includes('fable'));
  assert.match(bogus.warnings[0]!, /^modello ignoto: 'bogus'/);
});

test('permission mode: env > file > manual, ignoto → manual con avviso', () => {
  const mode = (env: Record<string, string>, config: unknown = null) => {
    const a = composeTab(req(['T1']), ctx({ env, config })).claudeArgs;
    return a[a.indexOf('--permission-mode') + 1];
  };
  assert.equal(mode({}), 'manual');
  assert.equal(mode({}, { permissionMode: 'plan' }), 'plan');
  assert.equal(mode({ LOOM_DECK_PERMISSION_MODE: 'acceptEdits' }, { permissionMode: 'plan' }), 'acceptEdits');
  const p = composeTab(req(['T1']), ctx({ env: { LOOM_DECK_PERMISSION_MODE: 'nope' } }));
  assert.deepEqual(p.warnings, ["permissionMode ignoto: 'nope' → fallback 'manual'"]);
});

// ── le due forme dell'uscita ───────────────────────────────────────────────

test('Linux: la riga in-tab nella grafia storica, spazio finale senza prompt', () => {
  const p = composeTab(req(['T56', '--session-id', SID, '--prompt-kind', 'run']), ctx());
  assert.equal(
    p.inTab,
    `LOOM_TASK=T56 claude --name 'cc T56' --permission-mode manual --model opus --session-id ${SID} '/loom-works:run-task T56'`,
  );
  assert.equal(
    composeTab(req(['T56', '--resume', SID]), ctx()).inTab,
    `LOOM_TASK=T56 claude --name 'cc T56' --permission-mode manual --model opus --resume ${SID} `,
  );
});

test('Linux: chiave di stato in testa dal file, scartata fuori alfabeto', () => {
  assert.match(composeTab(req(['T60']), ctx({ config: LABELED })).inTab, /^PTYXIS_PROFILE=demo LOOM_TASK=T60 claude /);
  const bad = composeTab(req(['T60']), ctx({ config: { ...LABELED, id: 'demo:claude' } }));
  assert.match(bad.inTab, /^LOOM_TASK=T60 claude /);
  assert.match(bad.warnings[0]!, /profilo di stato ignorato/);
  // Settata a vuoto = nessun annuncio, anche col file.
  assert.match(composeTab(req(['T60']), ctx({ config: LABELED, env: { LOOM_DECK_STATE_PROFILE: '' } })).inTab, /^LOOM_TASK=/);
});

test('Windows: nessuna chiave di stato, compass lì non esiste', () => {
  const p = composeTab(req(['T60']), ctx({ config: LABELED, platform: 'win32', env: { LOOM_DECK_STATE_PROFILE: 'x"y' } }));
  assert.deepEqual(p.sessionEnv, { LOOM_TASK: 'T60' });
  assert.deepEqual(p.warnings, []);
  assert.match(p.inTab, /^LOOM_TASK=T60 claude --name '🧵 demo · T60' /);
});

test('Linux: argv di Ptyxis, tab o finestra nuova', () => {
  assert.deepEqual(ptyxisArgv(false, '/wd', 'cc T1', 'cmd'), ['--tab', '-d', '/wd', '-T', 'cc T1', '--', 'bash', '-lc', 'cmd']);
  assert.equal(ptyxisArgv(true, '/wd', 't', 'c')[0], '--new-window');
});

// AC3 — il prompt arriva a `claude` identico. Su Windows l'argv viaggia come
// JSON nell'env della tab, e il prompt non passa da nessun parser: è l'ultimo
// elemento dell'array, così com'era nel campo del deck.
const NASTY = `tutti ; ' " & % ^ | $ \` \\ ! * ? < > 🧵 🚀 à\nseconda riga`;

test('AC3 — il prompt con i caratteri speciali è l’ultimo argomento, identico, e regge il giro JSON', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const p = composeTab(req(['T1', '--prompt', NASTY]), ctx({ platform }));
    assert.equal(p.claudeArgs.at(-1), NASTY);
    assert.deepEqual(JSON.parse(JSON.stringify(p.claudeArgs)), p.claudeArgs);
  }
});

test('AC3 — Linux: una shell vera riceve il prompt come UN argomento', { skip: unixOnly('serve bash') }, () => {
  const p = composeTab(req(['T1', '--prompt', NASTY]), ctx());
  const probe = spawnSync('bash', ['-c', `claude() { printf '%s' "\${@: -1}"; }; ${p.inTab}`], { encoding: 'utf8' });
  assert.equal(probe.stdout, NASTY);
});

test('posixQuote chiude e riapre sugli apici', () => {
  assert.equal(posixQuote("a'b"), `'a'\\''b'`);
});
