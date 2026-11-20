// T198 — il controllo della finestra prima di una tab chiesta da una
// conversazione: la decisione pura sulla risposta di compass, e il canale vero
// contro un `gdbus` finto.
//
// Il finto risponde secondo l'id di progetto che riceve (l'ultimo argomento) e
// scrive il metodo chiamato in un file, così un solo binario copre le tre
// parole di compass, il compass vecchio senza il metodo e il bus senza compass.
// File separato perché il binario si legge a import-time
// (`LOOM_DECK_FOCUS_CMD`), come in `focus-channel.test.ts`.
//
// T234 — lo stesso finto risponde anche alle due domande allo shell sul ramo
// `ServiceUnknown`: `GetActive` legge il file `active` (assente = shell senza
// il salvaschermo), `GetExtensionInfo` il file `extinfo`. Ogni metodo chiamato
// si accoda a `calls`, così un test vede quali domande sono partite. Il blocco
// dello schermo si collauda così, senza bloccare lo schermo di chi lancia la
// suite.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unixOnly } from './platform-gates.js';

const dir = mkdtempSync(join(tmpdir(), 'window-check-'));
const fake = join(dir, 'gdbus');
const argvLog = join(dir, 'argv');
const callsLog = join(dir, 'calls');
const activeFile = join(dir, 'active');
const extinfoFile = join(dir, 'extinfo');
writeFileSync(
  fake,
  `#!/bin/sh
printf '%s\\n' "$@" > '${argvLog}'
printf '%s\\n' "$8" >> '${callsLog}'
for last; do :; done
# T234 — le domande allo shell: il salvaschermo e la scheda di compass.
case "$8" in
  *GetActive)
    if [ -f '${activeFile}' ]; then cat '${activeFile}'; exit 0; fi
    echo "Errore: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable" >&2
    exit 1 ;;
  *GetExtensionInfo)
    cat '${extinfoFile}'
    exit 0 ;;
esac
# T229 — AwaitProjectFocus: l'id del progetto è l'undicesimo argomento.
case "$8" in
  *AwaitProjectFocus)
    case "\${11}" in
      torna) sleep 0.2; echo "('si',)" ;;
      scade) echo "('scaduta',)" ;;
      vecchio)
        echo "Errore: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Method AwaitProjectFocus is not implemented" >&2
        exit 1 ;;
      appeso) exec sleep 30 ;;
    esac
    exit 0 ;;
esac
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
const {
  AWAIT_MARGIN_S,
  awaitProjectFocus,
  checkProjectWindow,
  lockedReason,
  refuseReason,
  windowCheckOf,
  WINDOW_CHECK_TIMEOUT_S,
} = await import('../src/window-check.js');

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

nodeTest('T234 decisione: schermo bloccato solo con compass fuori dal bus, ogni altro guasto resta l’avviso', () => {
  const offBus = { unreachable: 'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable' };
  assert.deepEqual(windowCheckOf(offBus, 'demo', true), { locked: lockedReason('demo') });
  assert.ok('warning' in windowCheckOf(offBus, 'demo', false), 'sbloccato: compass assente, come T198');
  // Il blocco detto dallo shell non vale dove compass è sul bus, o dove manca
  // gdbus: lì il guasto non dipende dal blocco.
  for (const r of [{ unreachable: 'ENOENT' }, { unreachable: 'GDBus.Error:…UnknownMethod: …' }, { word: 'ignoto' }]) {
    assert.ok('warning' in windowCheckOf(r, 'demo', true), JSON.stringify(r));
  }
  assert.deepEqual(windowCheckOf({ word: 'no' }, 'demo', true), { refuse: refuseReason('demo') });
  assert.match(lockedReason('loom-works'), /^schermo bloccato \(loom-works\): compass è spento dal blocco/);
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

// T229 — l'attesa del focus: il metodo AwaitProjectFocus con progetto, avviso e
// scadenza, il timeout di gdbus oltre la scadenza, e l'interruzione.
type Reply = Parameters<Parameters<typeof awaitProjectFocus>[3]>[0];
const awaitOnce = (id: string, deadlineS = 1800) =>
  new Promise<Reply>((resolve) => {
    awaitProjectFocus(id, 'spawn in attesa: T9 preflight', deadlineS, resolve);
  });

channel('attesa: il metodo AwaitProjectFocus con avviso e scadenza, e il timeout di gdbus oltre la scadenza', async () => {
  assert.deepEqual(await awaitOnce('torna', 1799.2), { word: 'si' });
  const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
  assert.deepEqual(argv.slice(6), [
    '--method',
    'org.lamemind.Compass.AwaitProjectFocus',
    '--timeout',
    String(1800 + AWAIT_MARGIN_S),
    'torna',
    'spawn in attesa: T9 preflight',
    '1800',
  ]);
  assert.deepEqual(await awaitOnce('scade'), { word: 'scaduta' });
  const old = await awaitOnce('vecchio');
  assert.ok('unreachable' in old && /UnknownMethod/.test(old.unreachable), JSON.stringify(old));
});

channel('attesa interrotta: il gdbus si uccide, e la sua fine arriva come canale caduto', async () => {
  let got: Reply | null = null;
  const stop = awaitProjectFocus('appeso', 'spawn in attesa: T9 preflight', 1800, (r) => {
    got = r;
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got, null, 'l’attesa resta aperta');
  stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(got !== null && 'unreachable' in got, JSON.stringify(got));
});

// T234 — il ramo `ServiceUnknown` chiede allo shell: salvaschermo attivo e
// compass abilitato insieme fanno `locked`, ogni altro esito resta l’avviso.
const COMPASS_ON = `({'uuid': <'compass@lamemind'>, 'state': <2.0>, 'enabled': <true>, 'sessionModes': <[<'user'>]>},)`;
const COMPASS_OFF = `({'uuid': <'compass@lamemind'>, 'state': <2.0>, 'enabled': <false>},)`;
const NOT_INSTALLED = '(@a{sv} {},)';

/** Il controllo su compass fuori dal bus, con lo shell che risponde `active` e
 *  `extinfo` (`null` = il servizio non c'è) → l’esito e i metodi chiamati. */
async function offBusCheck(active: string | null, extinfo: string) {
  rmSync(activeFile, { force: true });
  if (active !== null) writeFileSync(activeFile, `${active}\n`);
  writeFileSync(extinfoFile, `${extinfo}\n`);
  writeFileSync(callsLog, '');
  try {
    const check = await checkProjectWindow('spento');
    const calls = readFileSync(callsLog, 'utf8').trim().split('\n').map((m) => m.replace(/^.*\./, ''));
    return { check, calls };
  } finally {
    rmSync(activeFile, { force: true });
  }
}

channel('T234 canale: schermo bloccato con compass abilitato → locked, nessuna tab', async () => {
  const { check, calls } = await offBusCheck('(true,)', COMPASS_ON);
  assert.deepEqual(check, { locked: lockedReason('spento') });
  assert.deepEqual(calls, ['ProjectFocused', 'GetActive', 'GetExtensionInfo']);
  const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
  assert.deepEqual(argv.slice(2), [
    '--dest',
    'org.gnome.Shell',
    '--object-path',
    '/org/gnome/Shell',
    '--method',
    'org.gnome.Shell.Extensions.GetExtensionInfo',
    '--timeout',
    '2',
    'compass@lamemind',
  ]);
});

channel('T234 canale: schermo sbloccato, una domanda sola e l’avviso di T198', async () => {
  const { check, calls } = await offBusCheck('(false,)', COMPASS_ON);
  assert.ok('warning' in check, JSON.stringify(check));
  assert.match(check.warning, /compass non raggiungibile: .*ServiceUnknown/);
  assert.deepEqual(calls, ['ProjectFocused', 'GetActive']);
});

channel('T234 canale: bloccato ma compass non installato o disabilitato, o shell senza salvaschermo → avviso', async () => {
  const cases: Array<[string | null, string, string[]]> = [
    ['(true,)', NOT_INSTALLED, ['ProjectFocused', 'GetActive', 'GetExtensionInfo']],
    ['(true,)', COMPASS_OFF, ['ProjectFocused', 'GetActive', 'GetExtensionInfo']],
    ['(true,)', 'risposta che non è una scheda', ['ProjectFocused', 'GetActive', 'GetExtensionInfo']],
    [null, COMPASS_ON, ['ProjectFocused', 'GetActive']],
    ['forse', COMPASS_ON, ['ProjectFocused', 'GetActive']],
  ];
  for (const [active, extinfo, expectedCalls] of cases) {
    const { check, calls } = await offBusCheck(active, extinfo);
    assert.ok('warning' in check, `${active} ${extinfo}: ${JSON.stringify(check)}`);
    assert.match(check.warning, /^finestra non verificata \(compass non raggiungibile: .*ServiceUnknown/);
    assert.deepEqual(calls, expectedCalls, `${active} ${extinfo}`);
  }
});

channel('T234 canale: compass sul bus ma vecchio, nessuna domanda allo shell', async () => {
  writeFileSync(activeFile, '(true,)\n');
  writeFileSync(extinfoFile, `${COMPASS_ON}\n`);
  writeFileSync(callsLog, '');
  try {
    const check = await checkProjectWindow('vecchio');
    assert.ok('warning' in check && /da aggiornare/.test(check.warning), JSON.stringify(check));
    assert.deepEqual(readFileSync(callsLog, 'utf8').trim().split('\n'), ['org.lamemind.Compass.ProjectFocused']);
  } finally {
    rmSync(activeFile, { force: true });
  }
});
