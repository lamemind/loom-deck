// T180 — il comando della notifica per piattaforma, il toast di Windows e il
// suo tramite.
//
// Gira su ogni piattaforma: i costruttori sono puri, `notifyCommand` prende la
// piattaforma come argomento, e il tramite è uno script di Node che si prova
// con Node. Nessun PowerShell lanciato qui: il toast vero si collauda a mano
// sulla macchina Windows (DLV2 di T180).
//
// File separato da `notify.test.ts`: lì `LOOM_DECK_NOTIFY_CMD` è scritta prima
// dell'import, qui deve restare assente — l'override si legge a import-time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyCommand } from '../src/spawn.js';
import {
  BODY_ENV,
  encodeCommand,
  relayCommand,
  RELAY_ARGV_ENV,
  RELAY_SCRIPT,
  TITLE_ENV,
  toastArgs,
  toastCommand,
  toastEnv,
  TOAST_SCRIPT,
} from '../src/windows-notify.js';

const TITLE = 'loom-deck · project status';
const BODY = "loom-works: recap pronto — l'apice, $env:PATH e \"virgolette\"";

/** L'argv che il tramite riceve nell'env. */
function relayedArgv(env: Record<string, string | undefined> | undefined): string[] {
  return JSON.parse(env?.[RELAY_ARGV_ENV] ?? 'null');
}

test('su Linux la notifica resta notify-send', () => {
  assert.deepEqual(notifyCommand(TITLE, BODY, 'linux'), {
    cmd: 'notify-send',
    args: ['--app-name=loom-deck', TITLE, BODY],
  });
});

test('su Windows il deck lancia il tramite node, e il tramite Windows PowerShell', () => {
  const { cmd, args, env } = notifyCommand(TITLE, BODY, 'win32');
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ['-e', RELAY_SCRIPT]);
  const [inner, ...innerArgs] = relayedArgv(env);
  // Windows PowerShell di sistema, non `pwsh`: solo lui carica i tipi WinRT.
  assert.match(inner!, /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.deepEqual(innerArgs, toastArgs());
  assert.equal(env?.[TITLE_ENV], TITLE);
  assert.equal(env?.[BODY_ENV], BODY);
});

test("titolo e corpo viaggiano nell'env, mai nell'argv", () => {
  // Il testo sulla riga di comando passerebbe dal quoting di Windows e dal
  // parser di PowerShell: un apice o un `$` cambierebbero lo script.
  const { args } = toastCommand(TITLE, BODY, { SystemRoot: 'C:\\Windows' });
  const decoded = Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le');
  assert.equal(decoded, TOAST_SCRIPT);
  assert.ok(!decoded.includes('recap pronto'), 'il corpo è finito nello script');
  assert.ok(decoded.includes(`$env:${TITLE_ENV}`));
  assert.ok(decoded.includes(`$env:${BODY_ENV}`));
  for (const arg of [...args, ...notifyCommand(TITLE, BODY, 'win32').args]) {
    assert.ok(!arg.includes(BODY), "il corpo è finito nell'argv");
  }
});

test('lo script codificato è UTF-16LE in base64, come vuole -EncodedCommand', () => {
  const script = "'àè · ✓'";
  assert.equal(Buffer.from(encodeCommand(script), 'base64').toString('utf16le'), script);
  assert.equal(toastArgs()[toastArgs().length - 2], '-EncodedCommand');
  assert.ok(toastArgs().includes('-NoProfile'), 'senza -NoProfile il profilo utente rallenta e può stampare');
});

test("l'env del toast tiene quella del deck e ci aggiunge titolo e corpo", () => {
  const env = toastEnv(TITLE, BODY, { PATH: 'C:\\bin', SystemRoot: 'D:\\Win' });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env[TITLE_ENV], TITLE);
  assert.equal(env[BODY_ENV], BODY);
  assert.match(toastCommand(TITLE, BODY, { SystemRoot: 'D:\\Win' }).cmd, /^D:\\Win[\\/]System32/);
});

test('lo script del tramite attraversa la riga di comando di Windows come un argomento solo', () => {
  // Una virgoletta doppia passerebbe dall'escape di Node per la riga di
  // comando: lo script resterebbe giusto solo finché l'escape è giusto.
  assert.ok(!RELAY_SCRIPT.includes('"'));
});

test('il tramite lancia il comando con il suo argv e la sua env, senza la variabile del canale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-deck-relay-'));
  try {
    const out = join(dir, 'out.json');
    // Il comando "vero" è un altro node che scrive cosa ha ricevuto.
    const probe =
      'require("fs").writeFileSync(process.argv[1], JSON.stringify({' +
      ` argv: process.argv.slice(2), title: process.env.${TITLE_ENV} ?? null,` +
      ` channel: process.env.${RELAY_ARGV_ENV} ?? null }))`;
    const relay = relayCommand({
      cmd: process.execPath,
      args: ['-e', probe, out, "l'apice", 'due parole'],
      env: { ...process.env, [TITLE_ENV]: TITLE },
    });
    const r = spawnSync(relay.cmd, relay.args, { env: relay.env as NodeJS.ProcessEnv, windowsHide: true, timeout: 30_000 });
    assert.equal(r.status, 0, String(r.stderr));
    // Il tramite resta vivo finché il comando non esce: a tramite uscito il
    // file c'è già.
    const got = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(got, { argv: ["l'apice", 'due parole'], title: TITLE, channel: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un comando assente non abbatte il tramite, e il tramite esce subito', () => {
  const relay = relayCommand({ cmd: join(tmpdir(), 'non-esiste-notify-finto'), args: [], env: { ...process.env } });
  const started = Date.now();
  const r = spawnSync(relay.cmd, relay.args, { env: relay.env as NodeJS.ProcessEnv, windowsHide: true, timeout: 30_000 });
  assert.equal(r.status, 0, String(r.stderr));
  // Senza l'uscita sull'errore il tramite aspetterebbe il timer di `timeout`
  // (RELAY_TIMEOUT_MS), che su uno spawn fallito non si spegne.
  assert.ok(Date.now() - started < 15_000, `tramite uscito dopo ${Date.now() - started} ms`);
});
