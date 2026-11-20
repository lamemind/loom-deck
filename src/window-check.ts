// T198 — prima di una tab chiesta da una conversazione: la finestra in focus è
// del progetto?
//
// Ptyxis apre `--tab` nella SUA finestra attiva, da riga di comando e da D-Bus:
// non si sceglie la finestra. Con la finestra di un altro progetto davanti, la
// tab di questo progetto nasce là. Il deck non sposta il focus per farla
// nascere al posto giusto — uno spostamento deciso da un agente, in un momento
// che l'utente non sceglie, porta la tastiera di chi sta scrivendo o dettando
// in un'altra conversazione dentro la tab nuova —, quindi chiede e, se la
// finestra non è del progetto, rifiuta col motivo.
//
// T229 — il `no` non è più un rifiuto: la richiesta va in coda
// (`spawn-queue.ts`), e la tab nasce quando una finestra del progetto torna in
// focus. Il controllo qui resta quello di T198, e ne è il primo passo; il
// secondo è l'attesa, `awaitProjectFocus` in fondo al file.
//
// Lo sa compass, che gira dentro Mutter: il metodo D-Bus di sola lettura
// `ProjectFocused` risponde `si`, `no` o `ignoto` (`loom-compass`,
// `projectFocusOutcome`). Il deck si ferma SOLO sul `no` (P1 preflight): ogni
// «non lo so» — compass assente, compass senza il metodo, progetto che compass
// non conosce, progetto senza `id` — apre come prima di T198 e lo dice nella
// risposta, perché rifiutare nel dubbio bloccherebbe ogni spawn su una macchina
// senza compass.
//
// Il tasto ⏎ del deck non passa di qui: chi preme il tasto ha davanti la
// finestra del deck per costruzione.
//
// T234 — un «non lo so» non è più sempre «compass assente». Con lo schermo
// bloccato lo shell spegne compass, e `ProjectFocused` risponde
// `ServiceUnknown` come su una macchina senza compass. Su quel ramo, e solo
// lì, il controllo chiede allo shell se lo schermo è bloccato con compass
// abilitato (`screen-lock.ts`): se sì l'esito è `locked`, nessuna tab, e la
// richiesta aspetta lo sblocco; se no resta l'avviso di T198.
//
// Due metà, come `focus-session.ts`: la DECISIONE (`windowCheckOf`, pura) e il
// CANALE (`checkProjectWindow`, un `gdbus call` via `compassCall`, più le
// domande allo shell sul ramo `ServiceUnknown`).
import { compassCall, type CompassReply } from './focus-session.js';
import { screenLockedWithCompass } from './screen-lock.js';
import { NO_SPAWN } from './spawn.js';

/** Il timeout di `gdbus` sulla risposta, in secondi. `ProjectFocused` legge il
 *  focus e il registry in memoria e risponde subito: la soglia scatta solo su
 *  un compass appeso, e un compass assente non la aspetta (il bus risponde
 *  subito `ServiceUnknown`). */
export const WINDOW_CHECK_TIMEOUT_S = 2;

/** Il seguito del controllo: apri, rifiuta col motivo, aspetta lo sblocco
 *  dello schermo (T234), o apri e avvisa. */
export type WindowCheck = { ok: true } | { refuse: string } | { locked: string } | { warning: string };

/** La coda di ogni avviso: la conseguenza per chi ha chiesto. */
const UNVERIFIED = 'la tab nasce nella finestra di terminale attiva';

/** Il motivo del rifiuto. Porta l'istruzione (P4 preflight): la conversazione
 *  lo riporta così com'è all'utente, che è l'unico a poter portare davanti la
 *  finestra. Comincia col fatto, `finestra del progetto non in focus`, perché
 *  è la parte che si cerca. */
export function refuseReason(projectId: string): string {
  return (
    `finestra del progetto non in focus (${projectId}): la tab nascerebbe nella finestra di un altro progetto. ` +
    'Porta davanti una finestra del progetto e richiedi lo spawn'
  );
}

/** L'avviso di una tab aperta senza verifica, col perché. */
export function unverifiedWarning(why: string): string {
  return `finestra non verificata (${why}): ${UNVERIFIED}`;
}

/** T234 — il motivo di una tab non aperta a schermo bloccato. Comincia col
 *  fatto, `schermo bloccato`, come `refuseReason`. */
export function lockedReason(projectId: string): string {
  return (
    `schermo bloccato (${projectId}): compass è spento dal blocco e la finestra del progetto non si può verificare. ` +
    'Richiedi lo spawn dopo lo sblocco'
  );
}

/** T234 — compass non è sul bus: il nome non c'è, `ServiceUnknown`. È il solo
 *  «non lo so» su cui il blocco dello schermo si chiede allo shell: un
 *  `gdbus` che manca o un compass che non ha il metodo non dipendono dal
 *  blocco. */
export function compassOffBus(r: CompassReply): boolean {
  return 'unreachable' in r && /ServiceUnknown/.test(r.unreachable);
}

/**
 * La risposta di compass tradotta nel seguito. Una parola che questa versione
 * non conosce non rifiuta: un compass più nuovo che aggiungesse un esito non
 * deve bloccare gli spawn di un deck più vecchio.
 *
 * `ServiceUnknown` è compass assente dal bus; `UnknownMethod` è un compass
 * acceso ma più vecchio di T198. Il secondo si nomina, perché il rimedio è
 * diverso: aggiornare compass, non avviarlo.
 *
 * T234 — `locked` è la risposta dello shell sul ramo `ServiceUnknown`: lo
 * schermo è bloccato con compass abilitato. Vale solo lì, dove compass non è
 * sul bus.
 */
export function windowCheckOf(r: CompassReply, projectId: string, locked = false): WindowCheck {
  if ('unreachable' in r) {
    if (locked && compassOffBus(r)) return { locked: lockedReason(projectId) };
    if (/UnknownMethod/.test(r.unreachable)) return { warning: unverifiedWarning('compass senza ProjectFocused, da aggiornare') };
    return { warning: unverifiedWarning(`compass non raggiungibile: ${r.unreachable}`) };
  }
  switch (r.word) {
    case 'si':
      return { ok: true };
    case 'no':
      return { refuse: refuseReason(projectId) };
    case 'ignoto':
      return { warning: unverifiedWarning(`compass non conosce il progetto ${projectId}`) };
    default:
      return { warning: unverifiedWarning(`compass ha risposto «${r.word}»`) };
  }
}

/**
 * Chiede a compass se la finestra in focus è del progetto `projectId`.
 *
 * `null` = il file di progetto non dichiara un `id`: compass riconosce i
 * progetti per `id`, e senza non c'è niente da chiedere.
 *
 * Col freno dei test (`LOOM_DECK_NO_SPAWN`) compass non si chiede: `spawnOut`
 * restituisce un figlio inerte che non emette mai `close`, e il controllo
 * resterebbe appeso con la richiesta — il deck sotto test morirebbe senza
 * rispondere. E un deck di test non deve leggere il focus della sessione vera:
 * l'esito dipenderebbe dalla finestra che l'utente ha davanti mentre la suite
 * gira.
 */
export function checkProjectWindow(projectId: string | null): Promise<WindowCheck> {
  if (NO_SPAWN) return Promise.resolve({ warning: unverifiedWarning('deck col freno LOOM_DECK_NO_SPAWN, compass non chiesto') });
  if (projectId === null) return Promise.resolve({ warning: unverifiedWarning('progetto senza id in .claude/loom-works.json') });
  return new Promise((resolve) =>
    compassCall('ProjectFocused', projectId, WINDOW_CHECK_TIMEOUT_S, (r) => {
      // T234 — compass non è sul bus: spento dal blocco o assente dalla
      // macchina. Lo dice lo shell, con una o due domande in più su questo
      // ramo soltanto.
      if (!compassOffBus(r)) return resolve(windowCheckOf(r, projectId));
      void screenLockedWithCompass().then((locked) => resolve(windowCheckOf(r, projectId, locked)));
    }),
  );
}

/** T229 — quanto oltre la scadenza della richiesta `gdbus` aspetta la risposta
 *  di `AwaitProjectFocus`, in secondi. La scadenza la tiene compass, che
 *  risponde `scaduta`; questo margine copre un compass che non risponde più
 *  senza essere uscito dal bus, e non deve scattare prima di lui. */
export const AWAIT_MARGIN_S = 60;

/**
 * T229 — aspetta che la finestra in focus diventi del progetto: il metodo
 * D-Bus `AwaitProjectFocus` di compass, con `notice` per la notifica dello
 * spawn in attesa e `deadlineS` per la vita della richiesta. La risposta arriva
 * a `onResult` una volta sola: `si` al ritorno del focus, `scaduta`,
 * `interrotta` se compass si spegne a metà, oppure il canale che cade.
 *
 * → la funzione che interrompe l'attesa: uccide il `gdbus call`, e compass,
 * che segue il chiamante sul bus, chiude l'attesa e ritira la notifica. Dopo
 * l'interruzione può arrivare ancora un `onResult` (la fine del processo
 * ucciso): chi chiama lo deve ignorare.
 *
 * Col freno dei test risponde subito «non raggiungibile» senza lanciare
 * niente, come `checkProjectWindow`: un figlio inerte non risponde mai, e la
 * richiesta resterebbe appesa.
 */
export function awaitProjectFocus(
  projectId: string,
  notice: string,
  deadlineS: number,
  onResult: (r: CompassReply) => void,
): () => void {
  if (NO_SPAWN) {
    setImmediate(() => onResult({ unreachable: 'deck col freno LOOM_DECK_NO_SPAWN, compass non chiesto' }));
    return () => {};
  }
  const seconds = Math.max(1, Math.ceil(deadlineS));
  const child = compassCall(
    'AwaitProjectFocus',
    [projectId, notice, String(seconds)],
    seconds + AWAIT_MARGIN_S,
    onResult,
  );
  return () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
}
