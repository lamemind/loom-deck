// Modello del deck: i tipi e i cataloghi che descrivono COSA il deck
// rappresenta — la selezione a tre casi, i modi, le griglie dei modali. Sta a
// monte della vista: i componenti di `ui/` li importano da qui, mai dai moduli
// che li consumano, così la dipendenza resta in un verso solo.
import type { FieldSpec } from './fields.js';
import type { BodyKind } from './sessions.js';
import type { Mode as ViewportMode } from './viewport.js';
import type { PriName, ProgName, SortKey } from './view.js';

export const POLL_MS = 1500;

// Finestra entro cui la SECONDA pressione di `^C` chiude il deck. Scaduta, la
// prima pressione è dimenticata e la successiva riparte dall'avviso: un `^C`
// battuto per abitudine mezzo minuto prima non deve poter uscire a insaputa di
// chi preme. Il valore è anche il tempo per cui l'avviso resta in riga di stato
// — armamento e messaggio scadono insieme, o la riga prometterebbe un'uscita
// che il tasto non fa più.
export const QUIT_WINDOW_MS = 5000;

// Cap del pane sessioni: le più recenti (ts desc), le altre restano nell'indice
// ma fuori vista. Non-silenzioso → l'header mostra quante sono nascoste.
export const MAX_SESSIONS = 30;

// T59 D3 — cap dedicato alla vista "tutte": a 30 su un progetto con ~170
// conversazioni la lista sarebbe esaustiva solo sull'ultimo 17%, cioè
// contraddirebbe lo scopo della riga. 100 copre la finestra temporale utile e
// tiene comunque un tetto alle righe da attraversare con ↑↓.
export const MAX_SESSIONS_ALL = 100;

// Modello task-centrico: il Tasks pane ha, oltre alle task reali, DUE righe
// meta in testa — `≡ tutte` (ogni conversazione del progetto) e `○ spot` (le
// sole NON legate ad alcuna task). La selezione nel Tasks pane è il "padre"; il
// Sessions pane mostra i suoi figli.
//
// T59 D1 — le sentinelle sono Symbol, non `null` né stringhe riservate: la
// selezione è un ENUM a tre casi (task / spot / tutte), non un flag. Un Symbol
// non può collidere con un task id e si confronta secco (`sel === ALL`); una
// stringa sentinella farebbe invece circolare un id-fantasma dentro un tipo che
// altrove significa "task id".
export const SPOT = Symbol('spot');

export const ALL = Symbol('all');

export type Parent = string | typeof SPOT | typeof ALL; // taskId | spot | tutte

// Le righe meta occupano le prime posizioni della lista: l'indice di una task
// nella VISTA è quindi il suo indice in `viewTasks` + META_ROWS.
export const ROW_ALL = 0;

export const ROW_SPOT = 1;

export const META_ROWS = 2;

/**
 * T134 — quale dei due pane occupa lo SLOT DESTRO. Uno è montato e l'altro non
 * esiste a schermo (D6): con due pane i tipi delle righe restano disgiunti per
 * costruzione, invece di un'unione discriminata dentro il catalogo delle viste
 * sessione e di un'azione resa inerte su ogni riga sbagliata.
 *
 * VOLATILE come la vista attiva (D6 preflight): non entra in `deck-view.json`,
 * il deck riapre sempre sulle sessioni. T100 aveva già separato le due nature —
 * la vista è dove stai guardando adesso, il filtro è una preferenza — e
 * montare un pane è la prima delle due.
 */
export type RightPane = 'sessions' | 'inbox';

/**
 * Il pane a fuoco. Tre valori e non due più un asse a parte: `inbox` NON è
 * `sessions` con un contenuto diverso, ed è ciò che tiene vere per costruzione
 * tutte le guardie già scritte come `focus !== 'sessions'` (pin, nota,
 * riassegna, fork, resume). Col pane inbox montato quelle azioni non hanno una
 * riga su cui agire, e nessuna di loro ha dovuto imparare la differenza.
 *
 * `←→` restano un binding ASSOLUTO SPAZIALE: `←` porta sempre sui task, `→`
 * sempre sul pane destro — cioè su `sessions` o `inbox` a seconda di quale sia
 * montato.
 */
export type Focus = 'tasks' | 'sessions' | 'inbox';

// Standard shortcut (T39): MAIUSCOLA apre un modale, minuscola è azione
// immediata, 1..9 sono le voci launch del file config. I modali catturano tutti
// i tasti: dentro, `esc` annulla e non esce dal deck.
//
// Il tipo vive in viewport.ts perché ogni modale ha un COSTO IN RIGHE che il
// budget d'altezza deve conoscere: tenerli in due posti li farebbe divergere in
// silenzio, e una modale non contabilizzata è esattamente ciò che fa sforare il
// frame.
export type Mode = ViewportMode;

// Griglia del modale filtri: riga 0 = priorità, riga 1 = stato.
export interface FilterCursor {
  row: 0 | 1;
  col: number;
}

// T41 — Bozza del modale edit: valori scelti, non ancora scritti su disco.
// `detail` è il progresso arbitrario (`85%`, `In Progress`, …); vuoto = default
// dello stato. `title` è il titolo della task (descrizione in tasks.md + H1 del
// task file: una cosa sola, scritta in due posti).
// Righe del modale: 0 priorità · 1 stato · 2 progresso libero · 3 titolo.
// Il titolo sta IN CODA e non in testa apposta: le righe 0-2 conservano la
// posizione che avevano, quindi `E ←→` continua a cambiare la priorità come
// prima invece di finire su un campo di testo.
// T54/T117 — il caret NON sta più qui: vive nel `FieldsCursor` dell'area di
// compilazione, insieme alla riga in fuoco. Sono due facce della stessa
// posizione (quale campo, e dove dentro) e tenerle in due stati separati
// significa allinearle a mano a ogni cambio riga. La bozza porta i VALORI, il
// cursore la posizione.
export interface EditDraft {
  pri: PriName;
  prog: ProgName;
  detail: string;
  title: string;
}

// Modale sort a grammatica libera: un tasto per chiave, pressioni successive
// ciclano asc → desc → fuori dalla chain.
export const SORT_TASTI: Record<string, SortKey> = { p: 'pri', s: 'prog', i: 'id' };

// T52 — campi del modale ricerca, ciclati da Tab.
export type SearchField = 'hash' | 'query';

// T52 — toggle del modale ricerca, tutti su CTRL (D2).
//
// I due campi di testo mangiano ogni lettera nuda, quindi un toggle non può
// essere una lettera semplice: resterebbero i caratteri della query. CTRL è
// l'unico livello che convive con la digitazione senza modi né navigazione.
//
// Le mnemoniche ovvie sono precluse dall'ASCII, non da una scelta di design:
// `^I` È il Tab (0x09) e `^H` È il Backspace (0x08) — stesso byte, nessuna
// distinzione possibile a valle. Quindi niente I=IA e niente H=human. Bruciati
// per lo stesso motivo `^M` (Enter), `^J` (LF), `^[` (Esc). Tutto il resto passa
// pulito, `^S`/`^Q` inclusi: il raw mode di Ink disattiva il flow-control XON/XOFF
// che altrimenti se li mangerebbe il terminale.
export const SEARCH_TOGGLE_KEYS = {
  r: 'regex',
  a: 'caseSensitive',
  w: 'wholeWord',
} as const;

export const SEARCH_KIND_KEYS: Record<string, BodyKind> = { b: 'ai', t: 'tool', u: 'human' };

export const KIND_LABEL: Record<BodyKind, string> = { ai: 'IA', tool: 'tools', human: 'human' };

// T41 — ordine dei valori nel modale edit. Deliberatamente DIVERSO da
// PRI_ENTRIES/PROG_ENTRIES (che seguono il rango di sort): qui si sceglie un
// valore, non si ordina, quindi vince l'ordine del CICLO DI VITA — da fare →
// preflight fatto → in corso → chiusa → bloccata. La priorità resta alta→bassa,
// che è già l'ordine naturale di lettura.
//
// L'elenco deve coprire OGNI valore di ProgName: il cursore del modale nasce da
// `Math.max(0, EDIT_PROG.indexOf(prog))` (`overlays/modals.ts`), quindi un valore assente
// torna -1, viene schiacciato a 0 e salvare retrocede la task alla prima voce.
export const EDIT_PRI: readonly PriName[] = ['high', 'med', 'low'];

export const EDIT_PROG: readonly ProgName[] = ['todo', 'ready', 'wip', 'done', 'locked'];

// T117 — le righe del modale edit come DATO, nella forma che `fields.ts`
// consuma: 0 priorità · 1 stato · 2 progresso libero · 3 titolo. Il modale non
// dà lettere di selezione alle due righe a scelta, dove i valori sono glifi e
// non hanno un'iniziale da premere.
export const EDIT_FIELDS: readonly FieldSpec[] = [
  { kind: 'choice', count: EDIT_PRI.length },
  { kind: 'choice', count: EDIT_PROG.length },
  { kind: 'text' },
  { kind: 'text' },
];

/** Chiave della bozza scritta dalla riga di testo `r` (2 = progresso, 3 = titolo). */
export function editTextField(r: number): 'detail' | 'title' {
  return r === 2 ? 'detail' : 'title';
}

// T112 — bozza della conferma di eliminazione. UNA sola per i due bersagli
// (D5): fra `CANC` sulla task selezionata e `CANC` sull'intera vista
// `archiviabili` cambia il testo, non la meccanica — e un modale che esiste in
// due copie diverge alla prima modifica.
export interface PurgeDraft {
  /** Il bersaglio EFFETTIVO, già depurato dei non conformi al gate. */
  ids: string[];
  /** Scartati a monte perché la loro folder ha file che `git rm` non rimuove:
   *  il gate del plugin esce 2 prima di toccare qualsiasi cosa, quindi in un
   *  bulk uno solo di questi annullerebbe il purge di tutti gli altri. */
  skipped: string[];
  /** `true` = l'intera vista `archiviabili`; `false` = la task selezionata. */
  bulk: boolean;
  /** Regime della conferma: `null` = binaria (⏎/esc); un valore = ternaria, la
   *  singola task ha superstiti e la scelta viaggia come `--ignored-files`. */
  ignored: 'keep' | 'purge' | null;
  /** File superstiti della singola task sporca, nominati nella conferma. */
  survivors: number;
}
