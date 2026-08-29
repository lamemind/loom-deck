// Glifi letterali del frame e formatter di display. Fase VISTA, ma senza JSX:
// tutto qui è puro e testabile, e nessun sito di render scrive un glifo nudo.
import { sanitize } from './width.js';

// Glifi LETTERALI del JSX. I dati passano dai loader, che sanificano al
// confine; questi no — quindi passano da `sanitize` una volta qui, così nessun
// sito di render scrive un glifo nudo. `↳ ○ ▸ ⏎ · − ↑ ↓` sono già concordi e
// restano intatti; `▶` e `⚠` sono discordi e vengono sostituiti (`width.ts`).
export const CARET = sanitize('▶ ');
export const CARET_OFF = '  ';
export const WARN = sanitize('⚠');
// Prefisso del sessionId mostrato in lista: stesso dato e stessa lunghezza del
// widget `⛓ <8 char>` della statusline, così le due superfici si confrontano a
// occhio.
export const SID_CHARS = 8;

/** T60 — segnaposto della colonna task su una riga senza binding. Una cella
 *  vuota di soli spazi lascerebbe un buco che si legge come "colonna finita",
 *  e la riga tornerebbe a sembrare disallineata pur non essendolo. */
export const TASK_EMPTY = '·';

/** T110 — colonna modello della lista sessioni. Larghezza COSTANTE e non
 *  misurata come `taskW`/`ageW`: il dominio è chiuso e le short sono tutte
 *  larghe 3, quindi farla passare per `sessionCols` ricalcolerebbe a ogni
 *  render un numero già noto. */
export const MODEL_W = 3;

/** Le short sono CHIESTE, non derivate: `slice(0,3)` darebbe `opu` e `hai`, e
 *  sbaglierebbe proprio le due voci su quattro che a occhio non si controllano
 *  (`fab` e `son` coincidono col troncamento e coprono l'errore). La chiave è
 *  il token di FAMIGLIA, non l'id intero: `claude-opus-5 → ops` sarebbe un
 *  calco della generazione corrente, falso al primo bump e col sintomo del
 *  fallback «ignoto» proprio sul modello più usato. */
export const MODEL_SHORT: Record<string, string> = {
  fable: 'fab',
  opus: 'ops',
  sonnet: 'son',
  haiku: 'hak',
};

/** Nessun record assistant: la conversazione non ha ancora girato. Stesso
 *  glifo della cella task vuota accanto — il vocabolario non cresce. */
export const MODEL_EMPTY = TASK_EMPTY;

/** Id presente ma fuori dalle famiglie note: gira su qualcosa che la lista non
 *  sa nominare. Distinto dall'assenza, o un'estensione mancata del catalogo si
 *  legge come una riga normale e si scorre senza notarla; l'id per intero sta
 *  nel blocco preview. */
export const MODEL_UNKNOWN = '?';

export function modelShort(id: string): string {
  if (!id) return MODEL_EMPTY;
  const lower = id.toLowerCase();
  for (const [family, short] of Object.entries(MODEL_SHORT)) {
    if (lower.includes(family)) return short;
  }
  return MODEL_UNKNOWN;
}

// T62 — colonna liveness, larga 1, incollata al sessionId senza gutter proprio:
// il glifo qualifica QUELL'id, e uno spazio in mezzo lo farebbe leggere come una
// colonna a sé. Entrambi Ambiguous (EAW) → 1 colonna per il terminale e 1 cella
// per Ink, quindi concordi (invariante ① di width.ts): il pieno/vuoto del
// cerchio è l'unico asse che varia, e resta scandibile in verticale.
//
// Sulla riga CHIUSA c'è uno spazio e non un terzo glifo: le chiuse sono la
// maggioranza di ogni lista, e marcarle vorrebbe dire disegnare N volte «niente
// da dire» — la colonna diventerebbe rumore invece di un segnale.
//
// T124 — non sono più il vocabolario di una superficie sola: la riga del pane
// task adotta la stessa coppia, nella stessa forma (glifo attaccato all'id che
// qualifica, colore e grassetto sull'id) e con lo stesso significato. L'unica
// differenza ammessa è la POPOLAZIONE su cui il glifo si pronuncia — una
// conversazione di là, le N conversazioni di una task di qua, con un rollup che
// fa vincere `busy`. Riusarli con un significato spostato sarebbe un falso
// amico, peggio di un glifo nuovo.
export const LIVE_IDLE = '●';
export const LIVE_BUSY = '◍';
export const LIVE_NONE = ' ';

/**
 * T134 — colonna di stato della riga inbox, larga 2 come la cella marker della
 * lista sessioni.
 *
 * `held` non ha glifo, e non è una dimenticanza: un file senza il token
 * `drainable` resta eseguibile se qualcuno lo nomina, quindi ogni simbolo di
 * divieto direbbe una cosa più forte del vero. L'assenza dice «non è in coda»
 * senza promettere altro, e la colonna natura accanto continua a nominarlo.
 *
 * Nessun glifo è riusato dalla lista sessioni con un significato spostato: là
 * `●`/`◍` dicono la liveness di un processo e `📌`/`🔗`/`○` l'appartenenza,
 * qui si parla di una coda di lavoro. Un falso amico costa più di un simbolo
 * nuovo.
 */
export const INBOX_MARK: Record<'broken' | 'branched' | 'held' | 'queued', string> = {
  broken: WARN,
  branched: sanitize('🔒'),
  held: '',
  queued: sanitize('⏳'),
};

/** Larghezza della cella marker della riga inbox, gemella dei 2 della lista
 *  sessioni: la cella si riempie di spazi anche quando è vuota, o le righe
 *  `held` sposterebbero a sinistra tutto ciò che segue. */
export const INBOX_MARK_W = 2;

// Marker Done per il DISPLAY. `task.prog` resta il `✔️` letto da tasks.md —
// `isDone()` e le lookup di `view.ts` ci confrontano sopra, e `task-edit` lo
// riscrive sul file: è una chiave semantica, non testo. Qui `sanitize` lo
// traduce nel suo gemello concorde (`✅`) solo per finire nel frame.
export function displayProg(prog: string): string {
  return sanitize(prog);
}

/**
 * T118 — coda della riga task: marker dirty e contatore di conversazioni, nella
 * colonna ancorata al bordo destro del pane.
 *
 * Il contatore va per ULTIMO perché è lui ad allinearsi al bordo — la colonna è
 * resa `pad(…, 'right')`, quindi ciò che sta in fondo alla stringa cade sempre
 * nella stessa colonna. Il marker gli sta a sinistra, dentro la stessa cella
 * invece che in una colonna propria: è raro, e una colonna dedicata costerebbe
 * 3 spazi vuoti su ogni riga di un pane largo la metà del terminale.
 *
 * Vive qui e non nel sito di render perché la STESSA stringa serve due volte —
 * a misurare la larghezza della colonna (sulla vista completa, in `deck-model.ts`) e
 * a disegnarla (sulla finestra, in `panes.tsx`). Due formattazioni gemelle
 * divergerebbero alla prima modifica, e la colonna risulterebbe larga quanto
 * una stringa che nessuno scrive.
 *
 * T124 — il contatore spezza vive e totali (`(1/5`) invece di sommarle: un
 * numero solo cresce e non torna più indietro, quindi dice quanta storia ha la
 * task e non se lì sta succedendo qualcosa adesso. A zero vive resta il solo
 * totale (`(5`): scrivere `(0/5` metterebbe uno zero su quasi tutte le righe di
 * ogni lista, e il segnale sparirebbe nel rumore.
 *
 * La parentesi di CHIUSURA cade sempre. La colonna è ancorata a destra, quindi
 * la `)` costerebbe una cella per spostare verso l'interno l'unica cosa che si
 * legge davvero; il bordo del pane chiude già il gruppo. Quella di apertura
 * serve invece a staccare il contatore dalla descrizione a lunghezza libera che
 * gli sta a sinistra — l'asimmetria è voluta.
 */
export function taskTail(live: number, total: number, dirty: boolean): string {
  const count = total > 0 ? (live > 0 ? `(${live}/${total}` : `(${total}`) : '';
  if (!dirty) return count;
  return count ? `${WARN} ${count}` : WARN;
}

/** T124 — contatore di una riga META del pane task (`≡ tutte`, `○ spot`), che
 *  non è una colonna ancorata a niente. Prende comunque la grafia senza chiusa:
 *  due forme dello stesso oggetto a due righe di distanza si leggono come un
 *  errore, mentre una forma sola applicata anche dove la sua ragione non serve
 *  si legge come una convenzione. */
export function metaCount(n: number): string {
  return n > 0 ? ` (${n}` : '';
}

// T49 — size umana compatta per il detail pane sessione.
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// T49 — ultima attività ESTESA (giorno/mese ora:minuti) per il detail pane;
// nella riga di lista resta il relTime compatto.
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// T121 — sola ora del giorno, per l'indicatore di project status in testata. Il
// giorno non ci sta e non servirebbe: un recap del giorno prima è comunque
// stale, e la cache muore col reboot.
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Età relativa compatta (ms epoch → "2m"/"3h"/"5d") per il preview sessioni.
export function relTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * Ripulisce un chunk di stdin prima di scriverlo in un campo di testo.
 *
 * `useInput` consegna il CHUNK letto da stdin, non un tasto: un incollaggio — o
 * una raffica piu' veloce di una read — arriva come stringa unica, byte di
 * controllo compresi. Non si vedono a schermo, ma Ink li conta nella larghezza
 * della riga, e in un campo che finisce su disco (la nota, T53) resterebbero
 * li' per sempre. Le newline diventano SPAZIO invece di sparire: incollare due
 * righe deve separare le parole, non fonderle.
 */
export function sanitizeTyped(s: string): string {
  return s.replace(/[\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
}

export const META_KEYS = ['Priority', 'Size', 'Estimated Time', 'Progress'];
