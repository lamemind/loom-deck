// T217 — la lista unica delle variabili di sessione che nessun `claude` lanciato
// dal deck eredita, e il terzo dei suoi consumatori: il `claude -p` delle skill
// (`spawnSkill`), lanciato davvero con un `claude` finto che scrive su file
// l'env ricevuto. Gli altri due — tab di Windows Terminal e turni headless —
// si misurano in `tab-launch.test.ts` e `headless.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dropEnv, INHERITED_SESSION_ENV } from '../src/session-env.js';
import { SKILL_DROP_ENV, skillEnv } from '../src/spawn.js';

// ── la lista ───────────────────────────────────────────────────────────────

test('la lista è l’unione delle due liste di prima più le tre variabili misurate su Windows', () => {
  // Le 10 delle tab di Windows Terminal (`SESSION_MARKERS`)…
  const tabs = [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_EXECPATH',
  ];
  // …le 2 in più dei turni headless (`INHERITED_SESSION_ENV`, 12 nomi)…
  const headless = [...tabs, 'CLAUDE_AFK_TIMEOUT_MS', 'CLAUDE_CODE_BRIDGE_SESSION_ID'];
  // …e le 3 lette nell'env di una sessione su Windows.
  const added = ['BUN_INSPECT', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP'];
  assert.deepEqual([...INHERITED_SESSION_ENV].sort(), [...headless, ...added].sort());
  assert.equal(new Set(INHERITED_SESSION_ENV).size, INHERITED_SESSION_ENV.length, 'nomi doppi');
});

test('la configurazione dell’utente non è nella lista', () => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'PATH', 'AI_AGENT', 'GIT_EDITOR']) {
    assert.ok(!INHERITED_SESSION_ENV.includes(k), k);
  }
});

// ── dropEnv ────────────────────────────────────────────────────────────────

test('dropEnv toglie ignorando le maiuscole, tiene il resto e non tocca l’originale', () => {
  const env = { Claude_Pid: '42', CLAUDECODE: '1', PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/cfg' };
  const out = dropEnv(env, INHERITED_SESSION_ENV);
  assert.deepEqual(out, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  assert.equal(env.Claude_Pid, '42', 'originale modificato');
});

// ── skillEnv ───────────────────────────────────────────────────────────────

const SESSION = Object.fromEntries(INHERITED_SESSION_ENV.map((k) => [k, '1']));
const BASH = 'C:\\Git\\bin\\bash.exe';

test('skillEnv: via le variabili di sessione e il profilo di stato, su Linux nient’altro', () => {
  const env = skillEnv({ ...SESSION, PTYXIS_PROFILE: 'loom-works', PATH: '/usr/bin', LOOM_TASK: 'T1' }, 'linux', () => BASH);
  assert.deepEqual(env, { PATH: '/usr/bin', LOOM_TASK: 'T1' });
  for (const k of INHERITED_SESSION_ENV) assert.ok(SKILL_DROP_ENV.includes(k), k);
});

test('skillEnv: su Windows anche il bash di Git', () => {
  const env = skillEnv({ ...SESSION, PTYXIS_PROFILE: 'loom-works', PATH: 'C:\\x' }, 'win32', () => BASH);
  assert.deepEqual(env, { PATH: 'C:\\x', CLAUDE_CODE_GIT_BASH_PATH: BASH });
});

// ── spawnSkill, davvero ────────────────────────────────────────────────────

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const SPAWN_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'spawn.ts');

/** Un `claude` finto: scrive su file l'env ricevuto e chiude il turno con
 *  l'evento `result` che `spawnSkill` legge. */
function fakeClaude(dir: string): { cmd: string; probe: string } {
  const probe = join(dir, 'env.json');
  writeFileSync(
    join(dir, 'probe.js'),
    `require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify(process.env));` +
      `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\\n');`,
  );
  if (process.platform === 'win32') {
    // La forma di cmd-shim: `claude-cmd.ts` la legge e lancia il `.js` col node.
    const shim = join(dir, 'claude.cmd');
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\probe.js" %*\r\n');
    return { cmd: shim, probe };
  }
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire(${JSON.stringify(join(dir, 'probe.js'))});\n`);
  chmodSync(bin, 0o755);
  return { cmd: bin, probe };
}

test('spawnSkill: il claude -p di una skill non eredita le variabili di sessione né il profilo di stato del deck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-deck-skill-'));
  const claude = fakeClaude(dir);
  // Un driver che chiama `spawnCreateTask` col deck vero, in un processo suo:
  // `claudeLauncher` legge `LOOM_DECK_CLAUDE_CMD` una volta per processo.
  const driver = join(dir, 'driver.mts');
  writeFileSync(
    driver,
    `import { spawnCreateTask } from ${JSON.stringify(pathToFileURL(SPAWN_TS).href)};\n` +
      `spawnCreateTask('prova', ${JSON.stringify(dir)}, 'sid-1', (ok) => process.stdout.write(JSON.stringify({ ok })));\n`,
  );
  const r = spawnSync(process.execPath, [tsxCli, driver], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...SESSION,
      BUN_INSPECT: 'ws://127.0.0.1:9222/',
      // Il profilo di stato della tab del deck: i deck vivi lo portano.
      PTYXIS_PROFILE: 'loom-works',
      LOOM_DECK_CLAUDE_CMD: claude.cmd,
      CLAUDE_CONFIG_DIR: join(dir, 'cfg'),
    },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  const received = JSON.parse(readFileSync(claude.probe, 'utf8')) as Record<string, string>;
  for (const k of SKILL_DROP_ENV) assert.equal(received[k], undefined, `${k} ereditata dalla skill`);
  assert.equal(received.PTYXIS_PROFILE, undefined, 'profilo di stato ereditato dalla skill');
  assert.equal(received.CLAUDE_CONFIG_DIR, join(dir, 'cfg'), 'la configurazione dell’utente passa');
});
