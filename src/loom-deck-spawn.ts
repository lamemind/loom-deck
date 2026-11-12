#!/usr/bin/env node
// T196 — l'ingresso di `loom-deck-spawn`, seconda voce `bin` del pacchetto. La
// logica sta in `spawn-client.ts`, che si testa senza lanciare un processo.
import { runClient } from './spawn-client.js';

runClient(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then((code) => {
  process.exitCode = code;
});
