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
// T50 — separatore leggero fra blocco pinnate e contestuali. `─` (box-drawing) è
// largo 1 sia per string-width sia per il terminale. Corto +
// wrap="truncate-end" così non va mai a capo nel pane al 50%.
export const SESSION_SEP = '─'.repeat(16);
// Prefisso del sessionId mostrato in lista: stesso dato e stessa lunghezza del
// widget `⛓ <8 char>` della statusline, così le due superfici si confrontano a
// occhio.
export const SID_CHARS = 8;

/** T60 — segnaposto della colonna task su una riga senza binding. Una cella
 *  vuota di soli spazi lascerebbe un buco che si legge come "colonna finita",
 *  e la riga tornerebbe a sembrare disallineata pur non essendolo. */
export const TASK_EMPTY = '·';

// T62 — colonna liveness, larga 1, incollata al sessionId senza gutter proprio:
// il glifo qualifica QUELL'id, e uno spazio in mezzo lo farebbe leggere come una
// colonna a sé. Entrambi Ambiguous (EAW) → 1 colonna per il terminale e 1 cella
// per Ink, quindi concordi (invariante ① di width.ts): il pieno/vuoto del
// cerchio è l'unico asse che varia, e resta scandibile in verticale.
//
// Sulla riga CHIUSA c'è uno spazio e non un terzo glifo: le chiuse sono la
// maggioranza di ogni lista, e marcarle vorrebbe dire disegnare N volte «niente
// da dire» — la colonna diventerebbe rumore invece di un segnale.
export const LIVE_IDLE = '●';
export const LIVE_BUSY = '◍';
export const LIVE_NONE = ' ';

// Marker Done per il DISPLAY. `task.prog` resta il `✔️` letto da tasks.md —
// `isDone()` e le lookup di `view.ts` ci confrontano sopra, e `task-edit` lo
// riscrive sul file: è una chiave semantica, non testo. Qui `sanitize` lo
// traduce nel suo gemello concorde (`✅`) solo per finire nel frame.
export function displayProg(prog: string): string {
  return sanitize(prog);
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
