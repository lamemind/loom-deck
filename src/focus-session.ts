// T184 — `⏎` su una conversazione: davanti la sua tab se è VIVA, ripresa in una
// tab nuova se non lo è.
//
// Perché la viva non si riprende: un secondo `deck-run --resume` su una
// conversazione che ha già il suo processo `claude` ne apre un secondo sullo
// stesso transcript, cioè due scrittori sullo stesso file.
//
// Perché il focus lo fa compass e non il deck: il deck è una TUI dentro una tab
// Ptyxis, e su Wayland solo il compositore porta davanti un'altra finestra.
// compass gira dentro Mutter ed espone il salto come metodo D-Bus
// (`org.lamemind.Compass.FocusSession`, T183): tab giusta, poi la sua finestra,
// e in risposta una parola dell'esito.
//
// Il modulo ha due metà, e solo la prima tocca un processo: il CANALE
// (`focusSession`, un `gdbus call`) e la DECISIONE (`enterSession`, pura, col
// canale iniettato). Così la scelta viva → focus / non viva → resume si collauda
// con un canale finto, senza compass e senza processi vivi. Il cablaggio coi
// valori del deck (`model.live`, `resumeSession`, `setNote`) sta in
// `actions.ts`, che è lo strato che sa cosa è selezionato.
import type { ChildProcess } from 'node:child_process';
import { spawnOut } from './spawn.js';

// Il binario del canale. L'override esiste per il collaudo del ramo «canale
// assente», stesso schema di `LOOM_DECK_NOTIFY_CMD` (`spawn.ts`): su una
// macchina dove `gdbus` c'è e compass è sul bus, quel ramo non è altrimenti
// raggiungibile.
export const FOCUS_CMD = process.env.LOOM_DECK_FOCUS_CMD ?? 'gdbus';

/**
 * Il timeout che `gdbus` applica alla risposta, in secondi.
 *
 * compass risponde DOPO il salto: l'helper AT-SPI e la ricerca della finestra
 * costano qualche decimo di secondo ciascuno, quindi la soglia sta un ordine di
 * grandezza sopra il caso normale e scatta solo su un compass appeso. Un compass
 * assente non la aspetta: il bus risponde subito `ServiceUnknown`.
 */
export const FOCUS_TIMEOUT_S = 5;

/**
 * La rete sotto il timeout di `gdbus`: Node uccide il figlio se nemmeno quello
 * esce, per esempio con un bus di sessione che non risponde alla connessione.
 * Senza, un `⏎` resterebbe senza nota per sempre.
 */
const FOCUS_KILL_MS = (FOCUS_TIMEOUT_S + 1) * 1000;

/** Gli esiti che portano alla conversazione: la tab era già davanti
 *  (`esatta`) o il salto l'ha portata davanti (`tab`). Ogni altra parola del
 *  vocabolario di compass dice perché non ci si è arrivati. */
const REACHED = new Set(['esatta', 'tab']);

/** compass ha risposto con un esito, oppure il canale non c'è. Sono due fatti
 *  diversi e producono due note diverse: il primo dice cosa è successo alla
 *  tab, il secondo che nessuno ha provato a cercarla. */
export type FocusResult =
  | { reached: boolean; outcome: string }
  | { unreachable: string };

/** L'argv di `gdbus` per chiedere a compass il focus di `sessionId`. Il
 *  `sessionId` va nudo: `gdbus` legge il tipo `s` dall'introspezione del metodo
 *  e un UUID non è testo GVariant valido, quindi lo prende come stringa. */
export function focusSessionArgs(sessionId: string): string[] {
  return [
    'call',
    '--session',
    '--dest',
    'org.lamemind.Compass',
    '--object-path',
    '/org/lamemind/Compass',
    '--method',
    'org.lamemind.Compass.FocusSession',
    '--timeout',
    String(FOCUS_TIMEOUT_S),
    sessionId,
  ];
}

/**
 * L'esito dentro la risposta testuale di `gdbus`, o `null` se la risposta non
 * ha la forma attesa.
 *
 * Un metodo con firma `(s)` esce come tupla GVariant di un elemento:
 * `('tab',)`. La parola non si confronta col vocabolario di compass: un esito
 * che una versione futura aggiungesse deve arrivare nella nota così com'è,
 * invece di confondersi con un canale rotto.
 */
export function parseFocusReply(stdout: string): string | null {
  const m = /^\('([^']*)',\)$/.exec(stdout.trim());
  return m ? m[1]! : null;
}

/**
 * Chiede a compass il focus di `sessionId` e consegna l'esito a `onResult`,
 * una volta sola.
 *
 * Il listener su `error` è OBBLIGATORIO e non difensivo: senza `gdbus` (su
 * Windows, o su un Linux senza glib) lo spawn fallisce con un `error`
 * asincrono, e un `error` non agganciato su un `ChildProcess` abbatte il deck.
 * Agganciato, è il ramo «canale assente», ed è anche il solo gate di
 * piattaforma che serve: nessun `process.platform` qui.
 *
 * Il codice d'uscita decide, lo stderr no: `gdbus` lo scrive nella lingua del
 * sistema (`Errore: GDBus.Error:…ServiceUnknown`), e ne resta solo l'ultima
 * riga come motivo, per chi legge il risultato in un test.
 */
export function focusSession(
  sessionId: string,
  onResult: (r: FocusResult) => void,
): ChildProcess {
  const child = spawnOut(FOCUS_CMD, focusSessionArgs(sessionId), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FOCUS_KILL_MS,
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });
  // `error` e `close` possono arrivare entrambi per lo stesso spawn fallito:
  // la nota è una sola.
  let done = false;
  const finish = (r: FocusResult) => {
    if (done) return;
    done = true;
    onResult(r);
  };
  child.on('error', (e: NodeJS.ErrnoException) => finish({ unreachable: e.code ?? e.message }));
  child.on('close', (code, signal) => {
    if (code !== 0) {
      const last = err.trim().split('\n').pop() ?? '';
      finish({ unreachable: signal ? `timeout (${signal})` : last || `exit ${code}` });
      return;
    }
    const outcome = parseFocusReply(out);
    finish(
      outcome === null
        ? { unreachable: `risposta inattesa: ${out.trim()}` }
        : { reached: REACHED.has(outcome), outcome },
    );
  });
  return child;
}

/**
 * La nota di un `⏎` su una viva, a ogni esito, successo compreso.
 *
 * Sul successo la tab del deck va dietro, quindi la nota non la legge nessuno
 * subito: si legge al ritorno, ed è l'unica traccia di cosa ha fatto il tasto —
 * ogni spawn del deck lascia già la sua riga di stato, e un `⏎` muto sarebbe
 * l'unica azione senza.
 *
 * `sconosciuta` (compass non trova il `sessionId` fra i vivi) cade nella forma
 * di ogni esito fuori dalla tab, senza un resume: vuol dire che la
 * conversazione è finita dopo l'ultimo tick del deck, e il `⏎` successivo, a
 * tick avvenuto, la vede non viva e la riprende.
 */
export function focusNote(r: FocusResult, name: string): string {
  if ('unreachable' in r) return `⚠ compass non raggiungibile — ${name}`;
  return r.reached ? `→ ${name}` : `⚠ focus ${r.outcome} — ${name}`;
}

export interface EnterDeps {
  /** Il predicato di «viva»: il registro dei processi (`model.live`), lo
   *  stesso della lista. NON le marche live del sidecar, che dicono «era
   *  nell'ultimo insieme vivo» e servono al restore. */
  isLive: (sessionId: string) => boolean;
  /** Il nome con cui la nota nomina la conversazione. */
  nameOf: (sessionId: string) => string;
  focus: (sessionId: string, onResult: (r: FocusResult) => void) => void;
  resume: (sessionId: string) => void;
  note: (s: string) => void;
}

/**
 * La scelta del `⏎`. Una viva non si riprende MAI, qualunque esito torni:
 * né su `assente` (viva, ma senza una tab col suo nome — lanciata fuori da
 * Ptyxis) né con compass irraggiungibile. In entrambi i casi il processo
 * `claude` c'è, e un resume sarebbe il secondo scrittore.
 */
export function enterSession(sessionId: string, deps: EnterDeps): 'focus' | 'resume' {
  if (!deps.isLive(sessionId)) {
    deps.resume(sessionId);
    return 'resume';
  }
  const name = deps.nameOf(sessionId);
  deps.focus(sessionId, (r) => deps.note(focusNote(r, name)));
  return 'focus';
}
