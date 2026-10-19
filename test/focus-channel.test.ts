// T184 — il canale di focus VERO, un processo per chiamata, contro un `gdbus`
// finto.
//
// Il finto è uno script che risponde secondo il `sessionId` che riceve (l'ultimo
// argomento), così un solo binario copre la risposta di compass, il bus che
// rifiuta e la risposta di forma inattesa. File separato perché il binario si
// legge a import-time (`LOOM_DECK_FOCUS_CMD`): l'env va scritta prima che il
// modulo entri.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FocusResult } from '../src/focus-session.js';

const dir = mkdtempSync(join(tmpdir(), 'focus-channel-'));
const fake = join(dir, 'gdbus');
writeFileSync(
  fake,
  `#!/bin/sh
for last; do :; done
case "$last" in
  viva-tab) echo "('tab',)" ;;
  viva-esatta) echo "('esatta',)" ;;
  viva-assente) echo "('assente',)" ;;
  morta) echo "('sconosciuta',)" ;;
  bus-rifiuta)
    echo "avviso di libatspi" >&2
    echo "Errore: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable" >&2
    exit 1 ;;
  strano) echo "(true,)" ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env.LOOM_DECK_FOCUS_CMD = fake;
const { focusSession } = await import('../src/focus-session.js');

function ask(sessionId: string): Promise<FocusResult> {
  return new Promise((resolve) => focusSession(sessionId, resolve));
}

test('compass ha raggiunto la tab: tab ed esatta', async () => {
  assert.deepEqual(await ask('viva-tab'), { reached: true, outcome: 'tab' });
  assert.deepEqual(await ask('viva-esatta'), { reached: true, outcome: 'esatta' });
});

test('compass ha risposto senza raggiungerla: esito con la sua parola', async () => {
  assert.deepEqual(await ask('viva-assente'), { reached: false, outcome: 'assente' });
  assert.deepEqual(await ask('morta'), { reached: false, outcome: 'sconosciuta' });
});

test('il bus rifiuta: canale irraggiungibile, motivo dall’ultima riga di stderr', async () => {
  const r = await ask('bus-rifiuta');
  assert.ok('unreachable' in r, `atteso un canale irraggiungibile, arrivato ${JSON.stringify(r)}`);
  assert.match(r.unreachable, /ServiceUnknown/);
});

test('una risposta di forma inattesa non diventa un esito', async () => {
  const r = await ask('strano');
  assert.ok('unreachable' in r, `atteso un canale irraggiungibile, arrivato ${JSON.stringify(r)}`);
});
