import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitize } from './width.js';

// SIDECAR sessionId ↔ taskId (T27) + sessionId ↔ origine del fork (T28).
//
// Lo store JSONL di CC NON registra LOOM_TASK/taskId: la classificazione
// spot vs scoped non può derivare dal transcript. La verità è QUESTO indice,
// che il deck popola allo spawn — quando pinna `--session-id <uuid>` (D1
// preflight) il sessionId è già noto, quindi il binding è deterministico.
//
// T28 — il sidecar ospita anche il LINEAGE del fork, per la stessa ragione:
// `--fork-session` produce un transcript che è una COPIA VERBATIM dell'origine
// (stessi uuid dei messaggi) e NON contiene da nessuna parte il sessionId di
// provenienza (verificato empiricamente). `parentUuid` incatena i messaggi
// dentro un transcript, non le sessioni fra loro: nel fork vale `null` esatto
// come nell'origine. Senza un record nostro, un fork è indistinguibile da una
// sessione qualunque — e siccome eredita il titolo, comparirebbe come riga
// gemella dell'originale.
//
// Store (D3 preflight): project-local `<root>/.claude/loom/session-tasks.jsonl`,
// JSONL append-only. Append (non read-modify-write) = concurrency-safe fra
// spawn concorrenti; last-wins in lettura copre eventuali re-pin.
//
// Il record ha i campi OPZIONALI e indipendenti: un fork di sessione spot porta
// `forkOf` senza `taskId`, un normale spawn scoped l'inverso, un fork di sessione
// scoped entrambi. I lettori filtrano per campo → i record scritti prima di T28
// (solo taskId) restano validi, nessuna migrazione.
//
// T50 — il pin di una conversazione è un altro campo indipendente (`pinned`),
// stessa forma: keyed su sessionId, machine-local, scrittura immediata. È il
// primo campo MUTABILE (pin↔unpin nel tempo, non un fatto scritto una volta allo
// spawn): l'append-only + last-wins già previsto ("copre eventuali re-pin") lo
// regge — l'unpin è un append `{sessionId, pinned:false}` che vince sull'ultimo
// `pinned:true`. Ogni toggle aggiunge una riga (churn trascurabile, azione umana).
//
// T53 — la NOTA (`note`) è il secondo campo mutabile, gemello di `pinned`: testo
// libero scritto dall'umano per dire cosa è quella conversazione, quando il
// titolo derivato non basta. Vive qui e non nel transcript per la stessa ragione
// del binding task: lo store di CC è di CC, non abbiamo un posto dove scrivere
// dentro un suo file. La cancellazione è un append di stringa VUOTA (`note:''`),
// non un record di tipo diverso — last-wins la fa vincere sull'ultima nota, come
// `pinned:false` vince sull'ultimo `pinned:true`.

export interface SessionRecord {
  sessionId: string;
  /** Task a cui la sessione è legata (assente = spot). */
  taskId?: string;
  /** sessionId dell'origine, se questa sessione nasce da un fork. */
  forkOf?: string;
  /** T50 — pin/unpin della conversazione. true = pinnata, false = spinnata. */
  pinned?: boolean;
  /** T53 — nota umana sulla conversazione. Stringa vuota = nota cancellata. */
  note?: string;
}

export function taskIndexPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom', 'session-tasks.jsonl');
}

export function appendSessionRecord(projectRoot: string, rec: SessionRecord): void {
  const path = taskIndexPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...rec, ts: new Date().toISOString() }) + '\n');
}

export function appendTaskBinding(projectRoot: string, sessionId: string, taskId: string): void {
  appendSessionRecord(projectRoot, { sessionId, taskId });
}

/** T50 — pin/unpin (toggle): append immediato, il reader risolve last-wins. */
export function appendPin(projectRoot: string, sessionId: string, pinned: boolean): void {
  appendSessionRecord(projectRoot, { sessionId, pinned });
}

/** T53 — scrive (o cancella, con `note` vuota) la nota di una conversazione. */
export function appendNote(projectRoot: string, sessionId: string, note: string): void {
  appendSessionRecord(projectRoot, { sessionId, note });
}

export interface SessionIndex {
  /** sessionId → taskId (solo le scoped). */
  bindings: Map<string, string>;
  /** sessionId → sessionId d'origine (solo i fork). */
  forkOf: Map<string, string>;
  /** T50 — sessionId → rango di pin (posizione nel file dell'ultimo record
   *  `pinned:true`). Solo le pinnate correnti (un `pinned:false` finale toglie
   *  la chiave). Rango crescente = pinnata più di recente → ordinamento del
   *  blocco pinnate `desc` (ultima in cima, D2 preflight). */
  pinned: Map<string, number>;
  /** T53 — sessionId → nota corrente. Solo le note NON vuote: una `note:''`
   *  finale toglie la chiave, così chi legge non deve distinguere «assente» da
   *  «cancellata» (sono la stessa cosa a schermo). */
  notes: Map<string, string>;
}

// Una sola lettura del JSONL per entrambe le mappe: il deck poll-a l'indice a
// ogni tick, leggere il file due volte raddoppierebbe l'I/O per nulla.
// Last-wins per campo (un re-pin dello stesso sessionId sovrascrive), e i due
// campi sono indipendenti — un record di solo `forkOf` non cancella un binding
// task scritto prima per lo stesso sessionId.
export function loadSessionIndex(projectRoot: string): SessionIndex {
  const bindings = new Map<string, string>();
  const forkOf = new Map<string, string>();
  const pinned = new Map<string, number>();
  const notes = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(taskIndexPath(projectRoot), 'utf8');
  } catch {
    return { bindings, forkOf, pinned, notes };
  }
  let order = 0; // posizione crescente dei record pinned → rango di pin (D2)
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as {
        sessionId?: unknown;
        taskId?: unknown;
        forkOf?: unknown;
        pinned?: unknown;
        note?: unknown;
      };
      if (typeof d.sessionId !== 'string') continue;
      if (typeof d.taskId === 'string') bindings.set(d.sessionId, d.taskId);
      if (typeof d.forkOf === 'string') forkOf.set(d.sessionId, d.forkOf);
      // last-wins per campo: un `pinned:false` finale rimuove il pin, un
      // `pinned:true` (ri)assegna il rango con la posizione corrente nel file.
      if (typeof d.pinned === 'boolean') {
        if (d.pinned) pinned.set(d.sessionId, order++);
        else pinned.delete(d.sessionId);
      }
      // T53 — stesso last-wins: la stringa vuota è la CANCELLAZIONE, non una
      // nota vuota da mostrare. Il `typeof` esclude i record senza il campo, che
      // non devono toccare una nota scritta da un record precedente.
      if (typeof d.note === 'string') {
        // Sanificata in lettura, non solo alla digitazione: `sanitizeTyped`
        // toglie i byte di controllo ma non ripara la larghezza, e il file è
        // editabile a mano — una nota con un `✅` finirebbe nel frame larga il
        // doppio di quanto Ink ha contato. Il round-trip (edit di una nota già
        // sanificata → riscrittura del sostituto) è il prezzo accettato: a
        // schermo il glifo originale non era comunque disegnabile.
        if (d.note) notes.set(d.sessionId, sanitize(d.note));
        else notes.delete(d.sessionId);
      }
    } catch {
      // riga corrotta → skip
    }
  }
  return { bindings, forkOf, pinned, notes };
}
