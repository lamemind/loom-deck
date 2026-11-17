#!/usr/bin/env node
// T205 — l'ingresso di `loom-deck-headless`, quarta voce `bin` del pacchetto. La
// logica sta in `headless-client.ts` e `headless.ts`, che si testano senza
// lanciare un processo.
import { runHeadlessClient } from './headless-client.js';
import { realHeadlessIo } from './headless-io.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

runHeadlessClient(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  headless: realHeadlessIo(),
}).then((code) => {
  process.exitCode = code;
});
