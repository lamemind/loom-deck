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
// Lo sa compass, che gira dentro Mutter: il metodo D-Bus di sola lettura
// `ProjectFocused` risponde `si`, `no` o `ignoto` (`loom-compass`,
// `projectFocusOutcome`). Il deck rifiuta SOLO sul `no` (P1 preflight): ogni
// «non lo so» — compass assente, compass senza il metodo, progetto che compass
// non conosce, progetto senza `id` — apre come prima di T198 e lo dice nella
// risposta, perché rifiutare nel dubbio bloccherebbe ogni spawn su una macchina
// senza compass.
//
// Il tasto ⏎ del deck non passa di qui: chi preme il tasto ha davanti la
// finestra del deck per costruzione.
//
// Due metà, come `focus-session.ts`: la DECISIONE (`windowCheckOf`, pura) e il
// CANALE (`checkProjectWindow`, un `gdbus call` via `compassCall`).
import { compassCall, type CompassReply } from './focus-session.js';
import { NO_SPAWN } from './spawn.js';

/** Il timeout di `gdbus` sulla risposta, in secondi. `ProjectFocused` legge il
 *  focus e il registry in memoria e risponde subito: la soglia scatta solo su
 *  un compass appeso, e un compass assente non la aspetta (il bus risponde
 *  subito `ServiceUnknown`). */
export const WINDOW_CHECK_TIMEOUT_S = 2;

/** Il seguito del controllo: apri, rifiuta col motivo, o apri e avvisa. */
export type WindowCheck = { ok: true } | { refuse: string } | { warning: string };

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

/**
 * La risposta di compass tradotta nel seguito. Una parola che questa versione
 * non conosce non rifiuta: un compass più nuovo che aggiungesse un esito non
 * deve bloccare gli spawn di un deck più vecchio.
 *
 * `ServiceUnknown` è compass assente dal bus; `UnknownMethod` è un compass
 * acceso ma più vecchio di T198. Il secondo si nomina, perché il rimedio è
 * diverso: aggiornare compass, non avviarlo.
 */
export function windowCheckOf(r: CompassReply, projectId: string): WindowCheck {
  if ('unreachable' in r) {
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
    compassCall('ProjectFocused', projectId, WINDOW_CHECK_TIMEOUT_S, (r) => resolve(windowCheckOf(r, projectId))),
  );
}
