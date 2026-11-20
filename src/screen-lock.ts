// T234 — il blocco dello schermo visto dal deck.
//
// Con lo schermo bloccato GNOME Shell spegne le estensioni utente, compass
// compreso: il suo nome sparisce dal bus di sessione, e `ProjectFocused`
// risponde `ServiceUnknown` come su una macchina senza compass. Sono due casi
// con risposte opposte. Senza compass sulla macchina nessuno saprà mai dire
// dove nasce la tab, e lo spawn apre con l'avviso (T198). Con compass spento
// dal blocco la risposta arriva allo sblocco, e la richiesta aspetta in coda
// (`spawn-queue.ts`).
//
// Il deck distingue i due casi chiedendo allo shell, non a compass, che resta
// spento sulla schermata di blocco per scelta (P1 preflight): acceso lì,
// menu e scorciatoia lancerebbero comandi senza password. Allo shell chiede due
// fatti (P2 preflight), e il blocco è riconosciuto solo se sono veri entrambi:
//   - il salvaschermo è attivo — `org.gnome.ScreenSaver.GetActive`;
//   - compass è abilitato — la scheda `org.gnome.Shell.Extensions.
//     GetExtensionInfo 'compass@lamemind'` porta `'enabled': <true>`.
// Il primo da solo non basta: una macchina GNOME senza compass, a schermo
// bloccato, metterebbe in coda una richiesta che nessuno sveglia. `enabled`
// segue la scelta dell'utente (`enabled-extensions`, `disabled-extensions`,
// `disable-user-extensions`), non la modalità di sessione: il blocco non lo
// cambia. Ogni altro esito — shell senza quei servizi, risposta inattesa,
// compass non installato o disabilitato — resta «compass assente».
//
// Allo sblocco l'attesa finisce quando il nome di compass torna sul bus:
// `gdbus wait` (P3 preflight), lo stesso tipo di canale del deck verso la
// sessione, un processo e un esito. Controlla all'arrivo, quindi uno sblocco
// fra la domanda e l'attesa non si perde, e aspetta proprio ciò che serve al
// passo dopo: `AwaitProjectFocus` di compass. compass esporta l'oggetto prima
// di prendere il nome (`impl.js`, `enable()`), quindi a nome presente il
// metodo risponde.
//
// Due tempi dello shell, misurati sui sorgenti di GNOME Shell 50
// (`screenShield.js`): al blocco manuale lo shell spegne le estensioni
// all'inizio dell'animazione e dichiara il salvaschermo attivo solo a
// schermata mostrata, circa 0,3 secondi dopo; allo sblocco le riaccende prima
// di dichiarare il salvaschermo spento. Chi sente compass sparire e chiede
// subito `GetActive` legge quindi «schermo sbloccato»: `screenLockedSettled`
// ripete la domanda oltre quella finestra.
import { gdbusRun } from './focus-session.js';
import { NO_SPAWN } from './spawn.js';

/** L'uuid dell'estensione compass, la chiave della sua scheda nello shell. */
export const COMPASS_UUID = 'compass@lamemind';

/** Il nome di compass sul bus di sessione. */
export const COMPASS_BUS_NAME = 'org.lamemind.Compass';

/** Il timeout di `gdbus` sulle domande allo shell, in secondi. Lo shell
 *  risponde dalla memoria e subito: la soglia scatta solo su uno shell appeso. */
export const SHELL_QUERY_TIMEOUT_S = 2;

/** Quanto aspettare prima di ripetere `GetActive`, in millisecondi: oltre la
 *  finestra di circa 0,3 secondi fra lo spegnimento delle estensioni e il
 *  salvaschermo dichiarato attivo, con margine per una macchina carica. */
export const LOCK_SETTLE_MS = 1500;

/** L'argv di `gdbus` per `org.gnome.ScreenSaver.GetActive`. */
export function screenSaverActiveArgs(timeoutS = SHELL_QUERY_TIMEOUT_S): string[] {
  return [
    'call',
    '--session',
    '--dest',
    'org.gnome.ScreenSaver',
    '--object-path',
    '/org/gnome/ScreenSaver',
    '--method',
    'org.gnome.ScreenSaver.GetActive',
    '--timeout',
    String(timeoutS),
  ];
}

/** L'argv di `gdbus` per la scheda di un'estensione nello shell. L'uuid va
 *  nudo, come gli argomenti di `compassArgs`: il tipo `s` lo legge `gdbus`
 *  dall'introspezione. */
export function extensionInfoArgs(uuid: string, timeoutS = SHELL_QUERY_TIMEOUT_S): string[] {
  return [
    'call',
    '--session',
    '--dest',
    'org.gnome.Shell',
    '--object-path',
    '/org/gnome/Shell',
    '--method',
    'org.gnome.Shell.Extensions.GetExtensionInfo',
    '--timeout',
    String(timeoutS),
    uuid,
  ];
}

/** L'argv di `gdbus` che aspetta il nome di compass sul bus, per `deadlineS`
 *  secondi al massimo. */
export function compassWaitArgs(deadlineS: number): string[] {
  return ['wait', '--session', '--timeout', String(deadlineS), COMPASS_BUS_NAME];
}

/** La risposta di `GetActive` — `(true,)` o `(false,)` —, o `null` se la
 *  risposta non ha quella forma. */
export function parseScreenSaverActive(stdout: string): boolean | null {
  const m = /^\((true|false),\)$/.exec(stdout.trim());
  return m ? m[1] === 'true' : null;
}

/**
 * Il campo `enabled` di una scheda di `GetExtensionInfo`, o `null` se la
 * scheda non lo porta. Un'estensione non installata dà un dizionario vuoto,
 * `(@a{sv} {},)`: niente `enabled`, quindi `null`, che vale «non abilitata».
 */
export function parseExtensionEnabled(stdout: string): boolean | null {
  const m = /'enabled': <(true|false)>/.exec(stdout);
  return m ? m[1] === 'true' : null;
}

/** Una domanda allo shell: lo stdout di `gdbus`, o `null` se il canale non
 *  c'è o lo shell non risponde. */
function askShell(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    gdbusRun(args, SHELL_QUERY_TIMEOUT_S, (r) => resolve('stdout' in r ? r.stdout : null));
  });
}

/**
 * Lo schermo è bloccato con compass abilitato: compass è spento dal blocco e
 * torna allo sblocco. Le due domande allo shell in fila, la seconda solo se
 * la prima risponde `true`: su una macchina senza GNOME, o a schermo
 * sbloccato, una domanda sola.
 *
 * Col freno dei test (`LOOM_DECK_NO_SPAWN`) risponde `false` senza lanciare
 * niente: un figlio inerte non risponde mai, e un deck di test non deve
 * leggere lo stato della sessione vera.
 */
export async function screenLockedWithCompass(): Promise<boolean> {
  if (NO_SPAWN) return false;
  const active = await askShell(screenSaverActiveArgs());
  if (active === null || parseScreenSaverActive(active) !== true) return false;
  const info = await askShell(extensionInfoArgs(COMPASS_UUID));
  return info !== null && parseExtensionEnabled(info) === true;
}

/**
 * Come `screenLockedWithCompass`, per chi ha appena visto compass sparire:
 * se la prima risposta è no, la ripete dopo `settleMs`, oltre la finestra in
 * cui lo shell ha già spento le estensioni ma non dichiara ancora il
 * salvaschermo attivo. Il costo, un'attesa e una domanda in più, lo paga solo
 * un compass che si spegne a schermo sbloccato — un `compass reload`.
 */
export async function screenLockedSettled(
  probe: () => Promise<boolean> = screenLockedWithCompass,
  settleMs = LOCK_SETTLE_MS,
): Promise<boolean> {
  if (await probe()) return true;
  await new Promise((r) => setTimeout(r, settleMs));
  return probe();
}

/** La fine dell'attesa di compass: tornato sul bus, oppure no col motivo. */
export type CompassBack = { back: true } | { unreachable: string };

/**
 * Aspetta che compass torni sul bus — lo sblocco dello schermo — per
 * `deadlineS` secondi al massimo, e consegna l'esito a `onResult` una volta
 * sola. `gdbus wait` esce 0 appena il nome c'è, subito se c'è già; alla
 * scadenza esce 1.
 *
 * → la funzione che interrompe l'attesa: uccide il `gdbus wait`. Dopo
 * l'interruzione può arrivare ancora un `onResult` (la fine del processo
 * ucciso): chi chiama lo deve ignorare, come per `awaitProjectFocus`.
 *
 * Col freno dei test risponde subito «non raggiungibile» senza lanciare
 * niente.
 */
export function awaitCompassBack(deadlineS: number, onResult: (r: CompassBack) => void): () => void {
  if (NO_SPAWN) {
    setImmediate(() => onResult({ unreachable: 'deck col freno LOOM_DECK_NO_SPAWN, compass non atteso' }));
    return () => {};
  }
  const seconds = Math.max(1, Math.ceil(deadlineS));
  const child = gdbusRun(compassWaitArgs(seconds), seconds, (r) =>
    onResult('unreachable' in r ? r : { back: true }),
  );
  return () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
}
