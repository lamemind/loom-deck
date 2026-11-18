// T184 — `⏎` su una conversazione: davanti la sua tab se è VIVA, ripresa in una
// tab nuova se non lo è. T206 — nessuna delle due su un turno headless in corso.
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
//
// T198 — il canale è generico (`compassCall`): lo usa anche il controllo della
// finestra prima di una tab chiesta da una conversazione (`window-check.ts`),
// che chiama `ProjectFocused` con lo stesso binario e la stessa forma di
// risposta.
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

/** L'argv di `gdbus` per chiamare un metodo di compass con un argomento `s`.
 *  L'argomento va nudo: `gdbus` legge il tipo `s` dall'introspezione del metodo
 *  e un testo che non è GVariant valido (un UUID, un id di progetto) lo prende
 *  come stringa — anche `123`, `true`, apici e spazi, misurato su
 *  `ProjectFocused` (T198). */
export function compassArgs(method: string, arg: string, timeoutS: number): string[] {
  return [
    'call',
    '--session',
    '--dest',
    'org.lamemind.Compass',
    '--object-path',
    '/org/lamemind/Compass',
    '--method',
    `org.lamemind.Compass.${method}`,
    '--timeout',
    String(timeoutS),
    arg,
  ];
}

/** L'argv di `gdbus` per chiedere a compass il focus di `sessionId`. */
export function focusSessionArgs(sessionId: string): string[] {
  return compassArgs('FocusSession', sessionId, FOCUS_TIMEOUT_S);
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

/** compass ha risposto con una parola, oppure il canale non c'è. */
export type CompassReply = { word: string } | { unreachable: string };

/**
 * Chiama il metodo `method` di compass con l'argomento `arg` e consegna la
 * parola della risposta a `onResult`, una volta sola. Il canale di
 * `FocusSession` (T184) e di `ProjectFocused` (T198): un metodo con firma
 * `(s) → (s)`.
 *
 * Il listener su `error` è OBBLIGATORIO e non difensivo: senza `gdbus` (su
 * Windows, o su un Linux senza glib) lo spawn fallisce con un `error`
 * asincrono, e un `error` non agganciato su un `ChildProcess` abbatte il deck.
 * Agganciato, è il ramo «canale assente».
 *
 * Il codice d'uscita decide, lo stderr no: `gdbus` lo scrive nella lingua del
 * sistema (`Errore: GDBus.Error:…ServiceUnknown`), e ne resta solo l'ultima
 * riga come motivo, per chi legge il risultato in un test o in un avviso.
 *
 * `timeoutS` è il timeout che `gdbus` applica alla risposta; Node uccide il
 * figlio un secondo dopo, se nemmeno quello esce — per esempio con un bus di
 * sessione che non risponde alla connessione.
 */
export function compassCall(
  method: string,
  arg: string,
  timeoutS: number,
  onResult: (r: CompassReply) => void,
): ChildProcess {
  const child = spawnOut(FOCUS_CMD, compassArgs(method, arg, timeoutS), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: (timeoutS + 1) * 1000,
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
  // il risultato è uno solo.
  let done = false;
  const finish = (r: CompassReply) => {
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
    const word = parseFocusReply(out);
    finish(word === null ? { unreachable: `risposta inattesa: ${out.trim()}` } : { word });
  });
  return child;
}

/**
 * Chiede a compass il focus di `sessionId` e consegna l'esito a `onResult`,
 * una volta sola. Nessun gate di piattaforma: su Windows `gdbus` manca, e il
 * ramo «canale assente» di `compassCall` basta.
 */
export function focusSession(
  sessionId: string,
  onResult: (r: FocusResult) => void,
): ChildProcess {
  return compassCall('FocusSession', sessionId, FOCUS_TIMEOUT_S, (r) =>
    onResult('unreachable' in r ? r : { reached: REACHED.has(r.word), outcome: r.word }),
  );
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
  /** T206 — il pid del turno headless in corso sulla conversazione
   *  (`model.headless`), `null` se non ce n'è uno. */
  headlessPid: (sessionId: string) => number | null;
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
 *
 * T206 — una conversazione col turno headless in corso nemmeno: il processo
 * `claude -p` scrive già sul transcript, e non c'è una tab da portare davanti.
 * Il tasto lo dice in una nota e non fa altro; a turno finito la conversazione
 * torna una chiusa, e il `⏎` successivo la riprende.
 */
export function enterSession(sessionId: string, deps: EnterDeps): 'focus' | 'resume' | 'headless' {
  if (deps.isLive(sessionId)) {
    const name = deps.nameOf(sessionId);
    deps.focus(sessionId, (r) => deps.note(focusNote(r, name)));
    return 'focus';
  }
  const pid = deps.headlessPid(sessionId);
  if (pid !== null) {
    deps.note(headlessNote(deps.nameOf(sessionId), pid));
    return 'headless';
  }
  deps.resume(sessionId);
  return 'resume';
}

/** T206/P6 — la nota di un `⏎` su una conversazione col turno headless in
 *  corso. */
export function headlessNote(name: string, pid: number): string {
  return `⏎ → ${name}: turno headless in corso (pid ${pid})`;
}
