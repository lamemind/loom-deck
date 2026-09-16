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
// T57 — lo spawn è il momento in cui il binding NASCE, non l'unico in cui si
// scrive: `taskId` è a tutti gli effetti un campo MUTABILE (il terzo, dopo
// `pinned` e `note`), riassegnabile a posteriori dal deck. Il caso è quello di
// una conversazione aperta nuda per esplorare, che solo dopo si rivela lavoro
// di una task. Nessun formato nuovo e nessuna migrazione: l'append-only +
// last-wins per campo regge la riassegnazione esattamente come regge un re-pin,
// e la CANCELLAZIONE (torna spot) è la stringa vuota, gemella di `note:''`.
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
//
// T162 — `title` e `model` sono i primi campi DERIVATI del record: non li
// decide un umano né lo spawn, sono una COPIA di un dato che vive nel transcript
// di Claude Code e che il deck ha già in mano a ogni tick. Esistono perché
// compass non può leggere un transcript — gira dentro il processo di
// gnome-shell, e una lettura sincrona di qualche megabyte blocca il compositore,
// cioè l'intero desktop. Il sidecar è invece un file piccolo che compass già
// apre, quindi il dato deve arrivargli per questa via.
//
// Ne discende la forma: chi POSSIEDE il dato riempie i buchi quando passa (vedi
// `sidecarGaps` in `session-meta.ts`), invece di scriverlo al momento
// dell'azione umana — compass pinna da sé, dalla modale sulla conversazione in
// focus, e il titolo non lo conosce. Il campo è quindi EVENTUALMENTE
// CONSISTENTE: esiste una finestra in cui manca (chi legge deve avere un
// fallback), e invecchia se il possessore non gira — chi rinomina una
// conversazione cambia il titolo nel transcript, non qui.

export interface SessionRecord {
  sessionId: string;
  /** Task a cui la sessione è legata (assente = spot; T57 — stringa vuota =
   *  binding cancellato, la sessione torna spot). */
  taskId?: string;
  /** sessionId dell'origine, se questa sessione nasce da un fork. */
  forkOf?: string;
  /** T50 — pin/unpin della conversazione. true = pinnata, false = spinnata. */
  pinned?: boolean;
  /** T53 — nota umana sulla conversazione. Stringa vuota = nota cancellata. */
  note?: string;
  /** T158 — conversazione PRIORITARIA: ogni suo cambio di stato notevole produce
   *  banner e ding per-conversazione. true = marcata, false = smarcata. */
  priority?: boolean;
  /** T162 — titolo mostrabile della conversazione, per un lettore che non può
   *  aprire il transcript (compass). È il RESIDUO del titolo, non il titolo
   *  grezzo: vedi `sidecarTitle` in `session-meta.ts`. Stringa vuota =
   *  cancellazione, come `note`. */
  title?: string;
  /** T162 — ALIAS del modello (`fable|opus|sonnet|haiku`), non l'id versionato
   *  che sta sul transcript: serve a chi riprende la conversazione da fuori dal
   *  deck e deve passare `--model` a `deck-run`, che accetta l'enum degli alias.
   *  Un id versionato obbligherebbe il consumer a rifare la mappa
   *  famiglia → alias. Stringa vuota = cancellazione. */
  model?: string;
}

export function taskIndexPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom', 'session-tasks.jsonl');
}

export function appendSessionRecord(projectRoot: string, rec: SessionRecord): void {
  const path = taskIndexPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...rec, ts: new Date().toISOString() }) + '\n');
}

/**
 * Lega una sessione a una task. T57 — vale sia alla nascita (spawn) sia dopo:
 * un secondo record con un `taskId` diverso RIASSEGNA la conversazione, e
 * `taskId` VUOTO la stacca (torna spot), come `note:''` cancella la nota.
 */
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

/**
 * T158 — marca/smarca la conversazione come prioritaria: stessa forma di
 * `appendPin`, quarto campo mutabile del record.
 *
 * Il campo lo leggono TRE attori a rilascio indipendente — il deck, compass e
 * l'hook `announce-state.sh` del plugin. Il nome, una volta scritto nei file
 * degli utenti, non si rinomina senza migrazione: è un contratto fra tre repo,
 * non un dettaglio interno di questo modulo.
 */
export function appendPriority(projectRoot: string, sessionId: string, priority: boolean): void {
  appendSessionRecord(projectRoot, { sessionId, priority });
}

/**
 * T162 — scrive i campi DERIVATI (`title`, `model`) di una conversazione.
 *
 * I due vanno in UN record e non in due, anche se il lettore risolve last-wins
 * per campo e due append darebbero lo stesso esito finale: due record lasciano
 * un istante in cui su disco lo stato è a metà, e in quel mezzo ci sta il
 * lettore di compass — che mostrerebbe il titolo nuovo e riprenderebbe col
 * modello vecchio. È la stessa regola di `writeSessionMarks` lato compass.
 *
 * Il record porta SOLO i campi passati: uno che portasse anche l'altro col
 * valore che aveva prima lo riscriverebbe, e il last-wins trasformerebbe quella
 * riscrittura in una sovrascrittura di ciò che un altro scrittore ha messo nel
 * frattempo. Un insieme vuoto non scrive niente, invece di appendere un record
 * col solo `sessionId` che nessun lettore userebbe.
 */
export function appendSessionMeta(
  projectRoot: string,
  sessionId: string,
  fields: { title?: string; model?: string },
): void {
  const rec: SessionRecord = { sessionId };
  if (fields.title !== undefined) rec.title = fields.title;
  if (fields.model !== undefined) rec.model = fields.model;
  if (rec.title === undefined && rec.model === undefined) return;
  appendSessionRecord(projectRoot, rec);
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
  /** T158 — le conversazioni marcate prioritarie, come INSIEME e non come mappa:
   *  a differenza del pin non c'è un rango da conservare — nessuna vista ordina
   *  per marca — quindi un valore associato sarebbe un campo che nessuno legge. */
  priority: Set<string>;
  /** T162 — sessionId → titolo scritto nel sidecar. Solo i NON vuoti, come
   *  `notes`: la stringa vuota è la cancellazione e toglie la chiave. Serve al
   *  deck per sapere quali buchi riempire, non per rendere la lista — lì il
   *  titolo lo ha già dalla `Session`, che è la fonte. */
  titles: Map<string, string>;
  /** T162 — sessionId → alias di modello scritto nel sidecar, stessa regola. */
  models: Map<string, string>;
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
  const priority = new Set<string>();
  const titles = new Map<string, string>();
  const models = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(taskIndexPath(projectRoot), 'utf8');
  } catch {
    return { bindings, forkOf, pinned, notes, priority, titles, models };
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
        priority?: unknown;
        title?: unknown;
        model?: unknown;
      };
      if (typeof d.sessionId !== 'string') continue;
      // T57 — last-wins con la stringa vuota come CANCELLAZIONE: `taskId:''`
      // toglie la chiave, così chi legge non deve distinguere «mai legata» da
      // «staccata» (sono la stessa cosa: spot). Il `typeof` esclude i record
      // senza il campo, che non devono toccare un binding scritto prima.
      if (typeof d.taskId === 'string') {
        if (d.taskId) bindings.set(d.sessionId, d.taskId);
        else bindings.delete(d.sessionId);
      }
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
      // T158 — stesso last-wins per campo: `false` è una smarcatura esplicita e
      // toglie la chiave, il record che non nomina il campo non la tocca. Il
      // `typeof` è quindi obbligatorio anche qui: un test di verità confonderebbe
      // «smarcata» con «mai marcata», e la prima deve poter cancellare la seconda.
      if (typeof d.priority === 'boolean') {
        if (d.priority) priority.add(d.sessionId);
        else priority.delete(d.sessionId);
      }
      // T162 — stesso last-wins per campo di `note`, con una differenza che
      // conta: NESSUNA sanificazione in lettura. `note` la paga perché il deck
      // la mette nel frame e il file è editabile a mano; qui il valore non
      // entra nel frame (il deck il titolo lo ha dalla `Session`) e chi lo
      // rende — compass, sotto Pango — non fa contabilità di colonne.
      //
      // Sanificare qui avrebbe un costo suo: il deck decide se riempire il
      // buco CONFRONTANDO il valore letto con quello derivato, e un valore
      // riscritto in lettura non combacerebbe mai col derivato — un append a
      // ogni tick del poll, per sempre, senza nessun errore a dirlo.
      if (typeof d.title === 'string') {
        if (d.title) titles.set(d.sessionId, d.title);
        else titles.delete(d.sessionId);
      }
      if (typeof d.model === 'string') {
        if (d.model) models.set(d.sessionId, d.model);
        else models.delete(d.sessionId);
      }
    } catch {
      // riga corrotta → skip
    }
  }
  return { bindings, forkOf, pinned, notes, priority, titles, models };
}
