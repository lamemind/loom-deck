import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T56 — gate sul COMANDO IN-TAB che deck-run compone: è la superficie dove il
// prompt viene scelto e quotato, e nessun altro test la copre (il resto della
// suite è TypeScript, questo è l'unico anello bash).
//
// Tecnica: uno shim `ptyxis` in testa al PATH che stampa i propri argv invece di
// aprire una tab. deck-run finisce con `exec ptyxis … -- bash -lc "$IN_TAB_CMD"`,
// quindi l'ULTIMO argomento stampato è esattamente il comando che girerebbe
// dentro la tab. Nessun --dry-run da aggiungere allo script: il test osserva il
// codice vero, non un ramo scritto per lui.
//
// LOOM_DECK_WORKDIR punta a una dir temporanea SENZA .claude/loom-works.json →
// label e permissionMode cadono sui fallback (`cc <task>`, `manual`), così le
// asserzioni non dipendono dal progetto in cui gira la suite.

const DECK_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deck-run');
const SID = '11111111-2222-3333-4444-555555555555';

const shimDir = mkdtempSync(join(tmpdir(), 'loom-deck-shim-'));
writeFileSync(join(shimDir, 'ptyxis'), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n");
chmodSync(join(shimDir, 'ptyxis'), 0o755);

const workdir = mkdtempSync(join(tmpdir(), 'loom-deck-wd-'));
mkdirSync(workdir, { recursive: true });

type Run = { ok: boolean; out: string; err: string };

function deckRun(args: string[], env: Record<string, string> = {}): Run {
  try {
    const out = execFileSync('bash', [DECK_RUN, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        LOOM_DECK_WORKDIR: workdir,
        LOOM_DECK_PERMISSION_MODE: 'manual',
        LOOM_DECK_ENTER_PROMPT: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

/** Ultimo argv dello shim = il comando passato a `bash -lc` dentro la tab. */
function inTabCmd(args: string[], env: Record<string, string> = {}): string {
  const r = deckRun(args, env);
  assert.ok(r.ok, `deck-run ${args.join(' ')} è fallito: ${r.err}`);
  const lines = r.out.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

const PROMPTS: Array<[string, string | null]> = [
  ['none', null],
  ['recap', 'recap stato task T56'],
  ['preflight', '/loom-works:preflight-task T56'],
  ['run', '/loom-works:run-task T56'],
];

for (const [kind, prompt] of PROMPTS) {
  test(`--prompt-kind ${kind}: sessione bound, prompt ${prompt ?? 'assente'}`, () => {
    const cmd = inTabCmd(['T56', '--session-id', SID, '--prompt-kind', kind]);
    // Task-bound su TUTTI e quattro: è ciò che distingue questi spawn da
    // `--no-task`, che spegne il prompt ma perde anche la task.
    assert.match(cmd, /^LOOM_TASK=T56 claude /);
    assert.ok(cmd.includes(`--session-id ${SID}`));
    if (prompt === null) {
      // `none` non è stringa vuota: l'argomento posizionale sparisce del tutto,
      // altrimenti CC riceverebbe un prompt vuoto. Il prompt è sempre l'ULTIMO
      // elemento ed è single-quoted → assenza = la riga non finisce per apice
      // (gli apici di `--name '…'` stanno in mezzo, non in coda).
      assert.ok(!cmd.trimEnd().endsWith("'"), `atteso nessun prompt, trovato: ${cmd}`);
    } else {
      // Il prompt è single-quoted: è così che `/loom-works:…` arriva intero,
      // senza che lo shell tocchi slash e due punti.
      assert.ok(cmd.endsWith(`'${prompt}'`), `atteso prompt '${prompt}', trovato: ${cmd}`);
    }
  });
}

test('kind run su una task D: dispatch su run-doc, non run-task', () => {
  // `run-task` è dichiarata code-only e la lista del deck contiene entrambe le
  // famiglie del contratto loom → su una D il prompt deve puntare alla skill
  // complementare, o `^R` invocherebbe quella sbagliata su un terzo della lista.
  assert.ok(inTabCmd(['D02', '--prompt-kind', 'run']).endsWith("'/loom-works:run-doc D02'"));
  // Gli altri kind non discriminano: preflight-task risolve per id.
  assert.ok(
    inTabCmd(['D02', '--prompt-kind', 'preflight']).endsWith("'/loom-works:preflight-task D02'"),
  );
});

test('retro-compat: senza flag il prompt resta il recap di prima', () => {
  const nudo = inTabCmd(['T56', '--session-id', SID]);
  const esplicito = inTabCmd(['T56', '--session-id', SID, '--prompt-kind', 'recap']);
  assert.equal(nudo, esplicito);
  assert.ok(nudo.endsWith("'recap stato task T56'"));
});

test('LOOM_DECK_ENTER_PROMPT vince sul kind, ma non su none', () => {
  const env = { LOOM_DECK_ENTER_PROMPT: 'x {TASK} y' };
  assert.ok(inTabCmd(['T56'], env).endsWith("'x T56 y'"));
  assert.ok(inTabCmd(['T56', '--prompt-kind', 'run'], env).endsWith("'x T56 y'"));
  // Chi chiede esplicitamente nessun prompt non vuole quello d'ambiente.
  assert.ok(!inTabCmd(['T56', '--prompt-kind', 'none'], env).includes("'x T56 y'"));
});

test('--prompt-kind ignoto: errore d’uso, non fallback silenzioso', () => {
  const r = deckRun(['T56', '--prompt-kind', 'bogus']);
  assert.equal(r.ok, false);
  assert.match(r.err, /--prompt-kind ignoto: 'bogus'/);
});

test('--prompt-kind con --no-task: richiesta contraddittoria, rifiutata', () => {
  const r = deckRun(['--no-task', '--prompt-kind', 'run']);
  assert.equal(r.ok, false);
  assert.match(r.err, /--prompt-kind richiede una task/);
});

test('--resume: nessun prompt, qualunque sia il kind', () => {
  const cmd = inTabCmd(['T56', '--resume', SID, '--prompt-kind', 'run']);
  assert.ok(cmd.includes(`--resume ${SID}`));
  // Riprendere una conversazione significa continuarla, non iniettarle un
  // messaggio nuovo: il kind non riapre quella porta.
  assert.ok(!cmd.includes("'/loom-works:run-task"), `prompt inatteso sul resume: ${cmd}`);
});

// T58 — derivazione della label dal file config. Il resto della suite gira su un
// workdir SENZA `.claude/loom-works.json` (fallback `cc <task>`): questo è
// l'unico punto che osserva la formula vera, cioè la chiave con cui compass
// riconosce la finestra.
const labeledWd = mkdtempSync(join(tmpdir(), 'loom-deck-wd-cfg-'));
mkdirSync(join(labeledWd, '.claude'), { recursive: true });
writeFileSync(
  join(labeledWd, '.claude', 'loom-works.json'),
  JSON.stringify({ id: 'demo', emoji: '🧵', owner: 'LOCAL', name: 'demo', surfaces: { claude: true } }),
);

test('titolo tab: `<emoji> <name>` + suffisso task, owner escluso', () => {
  const cmd = inTabCmd(['T58'], { LOOM_DECK_WORKDIR: labeledWd });
  assert.ok(cmd.includes("--name '🧵 demo · T58'"), `titolo inatteso: ${cmd}`);
  assert.ok(!cmd.includes('LOCAL'), `owner presente nel titolo: ${cmd}`);
});

test('titolo tab senza task: solo la label, nessun suffisso', () => {
  const cmd = inTabCmd(['--no-task'], { LOOM_DECK_WORKDIR: labeledWd });
  assert.ok(cmd.includes("--name '🧵 demo'"), `titolo inatteso: ${cmd}`);
});
