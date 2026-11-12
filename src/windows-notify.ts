// T180 — NOTIFICHE SU WINDOWS: un toast di sistema al posto di `notify-send`.
//
// Il toast si chiede alle API WinRT di Windows (`ToastNotificationManager`)
// da Windows PowerShell, che le carica senza moduli da installare. Quattro
// vincoli danno la forma al comando, e nessuno dei quattro si vede da un errore:
//
// - WINDOWS POWERSHELL 5.1, non PowerShell 7. `pwsh` gira su .NET 5+, che non
//   proietta più i tipi WinRT: la stessa riga lì non trova il tipo. Il binario
//   è quello di sistema, per path assoluto (`powershellPath`).
// - LO SCRIPT VIAGGIA IN `-EncodedCommand`, non in un file `.ps1`. La execution
//   policy di una macchina aziendale può rifiutare un file non firmato
//   (misurato: «non è firmato digitalmente»), e non si applica a un comando
//   passato sulla riga. La forma codificata (UTF-16LE in base64) tiene lo script
//   fuori dalle regole di quoting della riga di comando di Windows.
// - TITOLO E CORPO VIAGGIANO NELL'ENV, non nello script. Lo script resta una
//   costante, e il testo — accenti, `·`, apici, `$` — non passa da nessun parser:
//   l'env di un processo Windows è Unicode, e PowerShell lo legge com'è
//   (misurato: i code point del toast coincidono con quelli della stringa).
// - POWERSHELL PARTE DA UN TRAMITE, non dal deck (`relayCommand`). Le due forme
//   dirette perdono il toast, ognuna in un caso diverso (misurato):
//   · `detached`: Node passa `DETACHED_PROCESS`, il figlio nasce senza console,
//     e Windows PowerShell senza console esce con exit 0 SENZA eseguire lo
//     script — nessun output, nessun errore, nessun toast;
//   · non `detached`: Node mette il figlio nel job object del deck, che Windows
//     chiude col deck — un deck chiuso nei secondi in cui PowerShell parte
//     (2-5 s misurati) porta via il toast prima del `Show`.
//   Il tramite è un `node` `detached`: Node gira senza console, e il tramite
//   sopravvive al deck. Da lì PowerShell parte non `detached` e con
//   `windowsHide`, cioè con una console sua senza finestra: nessuna finestra
//   visibile nuova durante tutto il toast (misurato con l'elenco delle finestre
//   top-level, contro un `ping` di controllo che invece ne apre una).
//
// Modulo PURO: l'env arriva come valore, nessun I/O.

import { powershellPath } from './windows-liveness.js';

/** Un comando di notifica: binario, argv, ed env quando il testo viaggia lì. */
export interface NotifyCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

/** Le variabili con cui titolo e corpo arrivano allo script. */
export const TITLE_ENV = 'LOOM_DECK_NOTIFY_TITLE';
export const BODY_ENV = 'LOOM_DECK_NOTIFY_BODY';

/**
 * L'identità dell'app a cui Windows attribuisce il toast (AppUserModelID): è
 * quella di Windows PowerShell, e il toast si presenta come suo.
 *
 * Un programma non installato da pacchetto può mostrare toast solo a nome di
 * un id che Windows conosce, cioè registrato da un collegamento nel menu Start.
 * Quello di Windows PowerShell c'è su ogni Windows: il notificatore risponde
 * `Enabled`. Un id libero come `loom-deck` non ha impostazioni (misurato: la
 * proprietà `Setting` resta vuota), e registrarne uno vorrebbe dire scrivere
 * nel registry o nel menu Start dell'utente, per una funzione che non è il
 * deliverable del deck. Il titolo del toast dice già da dove viene.
 */
export const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Lo script del toast: modello a due righe (`ToastText02`, titolo in grassetto
 * e corpo), testo dall'env, poi `Show`. `Show` ritorna appena il toast è
 * consegnato al sistema, che lo tiene nel centro notifiche anche dopo che
 * PowerShell è uscito — come il cassetto di GNOME.
 *
 * `$ErrorActionPreference = 'Stop'` fa uscire con exit non-zero su un passo
 * fallito: il deck non lo legge (la degradazione è muta, `notifyDone`), il
 * collaudo a mano sì.
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  `$text.Item(0).AppendChild($xml.CreateTextNode($env:${TITLE_ENV})) > $null`,
  `$text.Item(1).AppendChild($xml.CreateTextNode($env:${BODY_ENV})) > $null`,
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
].join('\n');

/** Uno script nella forma di `-EncodedCommand`: UTF-16LE, in base64. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** L'argv di PowerShell per il toast. */
export function toastArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(TOAST_SCRIPT)];
}

/** L'env del processo del toast: quella del deck, più titolo e corpo. */
export function toastEnv(
  title: string,
  body: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return { ...env, [TITLE_ENV]: title, [BODY_ENV]: body };
}

/** Il comando del toast, senza tramite: Windows PowerShell di sistema, lo
 *  script codificato, titolo e corpo nell'env. */
export function toastCommand(
  title: string,
  body: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotifyCommand {
  return { cmd: powershellPath(env), args: toastArgs(), env: toastEnv(title, body, env) };
}

/** La variabile con cui l'argv del comando arriva al tramite. Il tramite la
 *  toglie prima di lanciarlo, come `LOOM_DECK_TAB_ARGV` nel wrapper delle tab. */
export const RELAY_ARGV_ENV = 'LOOM_DECK_NOTIFY_ARGV';

/** Oltre questo il tramite uccide il comando: un PowerShell appeso non deve
 *  restare vivo per sempre insieme al suo tramite. */
export const RELAY_TIMEOUT_MS = 60_000;

/**
 * Il tramite, come script di `node -e` (CommonJS). Lancia il comando dell'env
 * non `detached` e con `windowsHide`, e resta vivo finché il comando non esce:
 * è lui a tenere aperto il job object in cui il comando gira.
 *
 * Nessuna virgoletta doppia: lo script attraversa intero la riga di comando di
 * Windows come un argomento solo. Un comando assente arriva come evento
 * `error`, agganciato perché il tramite non muoia di un'eccezione; e il
 * tramite esce lì, esplicitamente: il timer di `timeout` si spegne solo
 * sull'evento `exit`, che uno spawn fallito non emette, e senza l'uscita il
 * tramite resterebbe in piedi fino al timeout (misurato).
 */
export const RELAY_SCRIPT = [
  `const argv = JSON.parse(process.env.${RELAY_ARGV_ENV});`,
  `delete process.env.${RELAY_ARGV_ENV};`,
  "require('child_process')",
  `  .spawn(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true, timeout: ${RELAY_TIMEOUT_MS} })`,
  "  .on('error', () => process.exit(0));",
].join('\n');

/** Il comando avvolto nel tramite: `node -e`, col comando vero nell'env. */
export function relayCommand(inner: NotifyCommand, nodePath: string = process.execPath): NotifyCommand {
  return {
    cmd: nodePath,
    args: ['-e', RELAY_SCRIPT],
    env: { ...(inner.env ?? process.env), [RELAY_ARGV_ENV]: JSON.stringify([inner.cmd, ...inner.args]) },
  };
}
