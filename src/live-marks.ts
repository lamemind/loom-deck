// T181 — la MARCA `live` del sidecar: quali conversazioni stavano nell'ultimo
// insieme vivo del progetto, e quindi quali riapre il bottone di restore.
//
// Stesso schema di `session-meta.ts`: CONVERGENZA, non evento. A ogni tick del
// poll il deck confronta la marca su disco con le vive del registro e appende
// solo i buchi. Nessuno stato sul «giro precedente» a parte l'isteresi qui
// sotto: un deck che riparte converge dal sidecar com'è, e un tick perso si
// recupera al tick dopo.
//
// Il giudizio è separato dalla scrittura (`liveMarkPlan` decide,
// `writeLiveMarks` scrive) per la stessa ragione di `sidecarGaps`: la parte non
// ovvia è la convergenza, e un piano che non converge appenderebbe a ogni tick
// del poll, per sempre, senza nessun errore a dirlo.
//
// Nessun import da ink/react: il chiamante è un hook, questo modulo no.

import type { LiveSession } from './live-sessions.js';
import type { Session } from './sessions.js';
import { NO_SPAWN } from './spawn.js';
import { appendLive } from './task-index.js';

/**
 * L'insieme vivo della feature: le vive del registro che hanno anche una
 * `Session` nel deck (P2 preflight), ordinate per avvio del processo.
 *
 * L'incrocio è lo stesso del contatore «vive» e del rollup (`rollupChildren` in
 * `deck-model.ts`), ed è l'unico insieme che `resumeSession` sa riprendere: lo
 * spawn parte con cwd = root del progetto e prende il modello dalla `Session`.
 * Ne restano fuori due casi, entrambi di proposito:
 *
 *  - una conversazione aperta in una SOTTOCARTELLA del progetto — il registro
 *    la include (filtro `cwd` per prefisso), ma il transcript sta sotto un altro
 *    hash di progetto e il deck non ha una `Session` per lei. Non si marca, e la
 *    sua presenza non azzera l'insieme da ripristinare;
 *  - una conversazione appena nata, o appena passata da un `/clear` — il
 *    registro la conosce prima del suo primo record di transcript. Entra al
 *    primo prompt.
 *
 * L'ordine per `startedAt` decide il rango di chi entra nello stesso tick: è
 * l'ordine in cui le tab sono state aperte, quindi quello che il restore deve
 * ricalcare. A parità (registro senza il campo) decide il `sessionId`, perché un
 * piano deve essere deterministico per essere testabile.
 */
export function aliveIds(
  live: ReadonlyMap<string, Pick<LiveSession, 'startedAt'>>,
  sessions: readonly Pick<Session, 'sessionId'>[],
): string[] {
  const known = new Set(sessions.map((s) => s.sessionId));
  return [...live.entries()]
    .filter(([id]) => known.has(id))
    .sort(([a, x], [b, y]) => x.startedAt - y.startedAt || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}

/**
 * Quanto a lungo una conversazione in riapertura resta tenuta, contato dalla
 * partenza della SUA tab.
 *
 * Il conto che lo regge: il registro vivo scrive il file del processo
 * nell'ordine del secondo dopo l'avvio di `claude` (`startedAt` contro
 * `procStart` dello stesso file), più il tempo di `deck-run` e della tab. Dieci
 * secondi coprono quel ritardo con un margine largo, e restano brevi abbastanza
 * da ritirare in tempi
 * umani la marca di una conversazione che non si riaccende — un `--resume` che
 * fallisce, una tab chiusa subito. Scaduta la tenuta, vale l'isteresi normale.
 */
export const RESTORE_HOLD_MS = 10_000;

export interface LiveMarkInput {
  /** L'insieme vivo di questo tick, già ordinato (`aliveIds`). */
  alive: readonly string[];
  /** La marca su disco: sessionId → rango di entrata (`liveMarks` dell'indice). */
  marked: ReadonlyMap<string, number>;
  /** Le marcate che mancavano dalle vive già al tick precedente. */
  missingOnce: ReadonlySet<string>;
  /** Le marcate che il restore sta riaprendo adesso: non si ritirano finché la
   *  loro tab non si accende (o finché la tenuta non scade, nel hook). */
  held: ReadonlySet<string>;
}

export interface LiveMarkPlan {
  /** Da appendere `live:true`, nell'ordine di rango. */
  enter: string[];
  /** Da appendere `live:false`. */
  leave: string[];
  /** Il `missingOnce` del tick dopo. */
  missing: Set<string>;
}

/**
 * Il piano di questo tick.
 *
 * **Insieme vivo VUOTO → nessun append, e l'isteresi riparte.** È la regola
 * dell'utente, «la traccia si sovrascrive solo quando ci sono conversazioni
 * vive»: è ciò che fa sopravvivere l'ultimo insieme alla chiusura del deck,
 * della finestra o della macchina, e che il bottone di restore legge alla
 * riapertura. Svuotare `missing` qui invece di portarlo avanti allunga il
 * ritiro, mai lo accorcia: il prezzo di una scelta prudente è un tick di
 * ritardo, il prezzo di quella opposta sarebbe ritirare al primo tick non vuoto
 * una conversazione vista mancare una volta sola, magari molto prima.
 *
 * **Insieme vivo non vuoto:**
 *  - ogni viva non marcata ENTRA, al primo tick in cui la si vede;
 *  - ogni marcata assente ESCE solo al SECONDO tick consecutivo di assenza
 *    (P3 preflight). Il primo la mette in `missing` e basta. Serve perché
 *    chiudere una finestra Ptyxis con N tab fa uscire N processi con tempi
 *    propri: un tick caduto in quella finestra vede un insieme non vuoto ma
 *    dimagrito, e senza isteresi ritirerebbe la marca alle già morte proprio
 *    mentre l'insieme stava per diventare vuoto — cioè l'insieme da salvare;
 *  - una marcata TENUTA (`held`) non esce e non conta come assente: il restore
 *    accende le tab una alla volta, e la prima viva non deve far ritirare le
 *    altre che stanno ancora partendo.
 *
 * Una viva già marcata non produce niente: è la convergenza — un sidecar
 * allineato dà un piano vuoto, e il giro dopo non trova niente da fare.
 */
export function liveMarkPlan(input: LiveMarkInput): LiveMarkPlan {
  const { alive, marked, missingOnce, held } = input;
  if (alive.length === 0) return { enter: [], leave: [], missing: new Set() };

  const aliveSet = new Set(alive);
  const enter = alive.filter((id) => !marked.has(id));
  const leave: string[] = [];
  const missing = new Set<string>();
  for (const id of marked.keys()) {
    if (aliveSet.has(id) || held.has(id)) continue;
    if (missingOnce.has(id)) leave.push(id);
    else missing.add(id);
  }
  return { enter, leave, missing };
}

/**
 * Scrive il piano. Ritorna quanti record ha appeso — zero è l'esito normale a
 * regime, non un fallimento.
 *
 * `NO_SPAWN` frena anche questa scrittura, come `fillSidecarGaps` e per la
 * stessa ragione: il gate su pseudo-terminale avvia il deck vero con cwd la
 * project root del cappello, e senza freno ogni run della suite appenderebbe la
 * marca nel sidecar reale di chi la lancia.
 *
 * Gli ingressi prima delle uscite: un tick che li porta entrambi è il passaggio
 * da un insieme all'altro (`/clear`, una tab chiusa mentre un'altra si apre), e
 * nell'ordine inverso un lettore che cade fra i due append vedrebbe per un
 * istante un insieme più piccolo di entrambi.
 *
 * Un sidecar non scrivibile non è un errore da mostrare: il giro dopo trova gli
 * stessi buchi e riprova.
 */
export function writeLiveMarks(projectRoot: string, plan: LiveMarkPlan): number {
  if (NO_SPAWN) return 0;
  let scritti = 0;
  try {
    for (const id of plan.enter) {
      appendLive(projectRoot, id, true);
      scritti++;
    }
    for (const id of plan.leave) {
      appendLive(projectRoot, id, false);
      scritti++;
    }
  } catch {
    // sidecar non scrivibile: si riprova al giro dopo, niente a schermo.
  }
  return scritti;
}

/**
 * Le conversazioni che il bottone riapre, nell'ordine di riapertura (rango di
 * entrata crescente, dalla più vecchia — P7 preflight). Vuoto = niente bottone.
 *
 * Vuoto in due casi oltre alla marca vuota: c'è almeno una viva (il bottone
 * vale solo finché non ce n'è nessuna, e appena una è viva la marca si
 * riallinea a lei), oppure un restore è già in corso — senza, un secondo
 * `^T` nei secondi prima che la prima tab si accenda riaprirebbe tutto due
 * volte.
 *
 * Solo le marcate che hanno una `Session` (P2): una marcata senza transcript —
 * cancellato, o di un altro hash di progetto — non si conta e non si segnala.
 * Il suo `live:false` arriva al primo tick con delle vive, come per ogni altra
 * marcata che non lo è.
 */
export function restoreSet(input: {
  marked: ReadonlyMap<string, number>;
  sessions: readonly Session[];
  alive: readonly string[];
  restoring: boolean;
}): Session[] {
  if (input.alive.length > 0 || input.restoring || input.marked.size === 0) return [];
  const byId = new Map(input.sessions.map((s) => [s.sessionId, s]));
  return [...input.marked.entries()]
    .sort((a, b) => a[1] - b[1])
    .flatMap(([id]) => {
      const s = byId.get(id);
      return s ? [s] : [];
    });
}
