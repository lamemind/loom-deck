// T198 — il controllo della finestra prima di una tab chiesta da una
// conversazione: la decisione pura sulla risposta di compass, e il canale vero
// contro un `gdbus` finto.
//
// Il finto risponde secondo l'id di progetto che riceve (l'ultimo argomento) e
// scrive il metodo chiamato in un file, così un solo binario copre le tre
// parole di compass, il compass vecchio senza il metodo e il bus senza compass.
// File separato perché il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), come in `focus-channel.test.ts`.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unixOnly } from './platform-gates.js';

const dir = mkdtempSync(join(tmpdir(), 'window-check-'));
const fake = join(dir, 'gdbus');
const argvLog = join(dir, 'argv');
writeFileSync(
  fake,
  `#!/bin/sh
printf '%s\\n' "$@" > '${argvLog}'
for last; do :; done
case "$last" in
  davanti) echo "('si',)" ;;
  dietro) echo "('no',)" ;;
  sconosciuto) echo "('ignoto',)" ;;
  futuro) echo "('forse',)" ;;
  vecchio)
    echo "Errore: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Method ProjectFocused is not implemented" >&2
    exit 1 ;;
  spento)
    echo "Errore: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable" >&2
    exit 1 ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env.LOOM_DECK_FOCUS_CMD = fake;
const { checkProjectWindow, refuseReason, windowCheckOf, WINDOW_CHECK_TIMEOUT_S } = await import(
  '../src/window-check.js'
);

// T175 — il `gdbus` finto è uno script sh con exec bit, che Windows non lancia.
const channel = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, { skip: unixOnly('gdbus finto in sh, metodo ProjectFocused di compass') }, fn);

nodeTest('decisione: si apre, no rifiuta, ogni «non lo so» apre con l’avviso', () => {
  assert.deepEqual(windowCheckOf({ word: 'si' }, 'demo'), { ok: true });
  assert.deepEqual(windowCheckOf({ word: 'no' }, 'demo'), { refuse: refuseReason('demo') });
  const warnings: Array<[Parameters<typeof windowCheckOf>[0], RegExp]> = [
    [{ word: 'ignoto' }, /compass non conosce il progetto demo/],
    [{ word: 'forse' }, /compass ha risposto «forse»/],
    [{ unreachable: 'ENOENT' }, /compass non raggiungibile: ENOENT/],
    [{ unreachable: 'GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: …' }, /compass senza ProjectFocused, da aggiornare/],
  ];
  for (const [reply, re] of warnings) {
    const w = windowCheckOf(reply, 'demo');
    assert.ok('warning' in w, JSON.stringify(w));
    assert.match(w.warning, re);
    assert.match(w.warning, /^finestra non verificata .*: la tab nasce nella finestra di terminale attiva$/);
  }
});

nodeTest('il motivo del rifiuto dice il fatto e l’istruzione per l’utente', () => {
  const r = refuseReason('loom-works');
  assert.match(r, /^finestra del progetto non in focus \(loom-works\)/);
  assert.match(r, /Porta davanti una finestra del progetto e richiedi lo spawn$/);
});

channel('canale: il metodo ProjectFocused, il timeout corto e l’id nudo in coda', async () => {
  assert.deepEqual(await checkProjectWindow('davanti'), { ok: true });
  assert.deepEqual(readFileSync(argvLog, 'utf8').trim().split('\n'), [
    'call',
    '--session',
    '--dest',
    'org.lamemind.Compass',
    '--object-path',
    '/org/lamemind/Compass',
    '--method',
    'org.lamemind.Compass.ProjectFocused',
    '--timeout',
    String(WINDOW_CHECK_TIMEOUT_S),
    'davanti',
  ]);
});

channel('canale: le parole di compass e i due guasti del bus', async () => {
  assert.deepEqual(await checkProjectWindow('dietro'), { refuse: refuseReason('dietro') });
  const cases: Array<[string, RegExp]> = [
    ['sconosciuto', /compass non conosce il progetto sconosciuto/],
    ['futuro', /compass ha risposto «forse»/],
    ['vecchio', /compass senza ProjectFocused, da aggiornare/],
    ['spento', /compass non raggiungibile: .*ServiceUnknown/],
  ];
  for (const [id, re] of cases) {
    const w = await checkProjectWindow(id);
    assert.ok('warning' in w, `${id}: ${JSON.stringify(w)}`);
    assert.match(w.warning, re);
  }
});

nodeTest('progetto senza id: nessuna chiamata, apre con l’avviso', async () => {
  const w = await checkProjectWindow(null);
  assert.ok('warning' in w);
  assert.match(w.warning, /progetto senza id/);
});
