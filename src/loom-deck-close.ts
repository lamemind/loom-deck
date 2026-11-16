#!/usr/bin/env node
// T204 — l'ingresso di `loom-deck-close`, terza voce `bin` del pacchetto. La
// logica sta in `close-client.ts`, che si testa senza lanciare un processo.
import { runCloseClient } from './close-client.js';

runCloseClient(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then((code) => {
  process.exitCode = code;
});
