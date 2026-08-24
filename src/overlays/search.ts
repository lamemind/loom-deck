// Overlay RICERCA e READER (T52): stato, derivati e input nello stesso file.
//
// I due lati stanno insieme perché sono la stessa cosa vista da due angoli — lo
// stato descrive cosa il modale mostra, l'handler cosa lo cambia — e separarli
// metterebbe ogni modifica a cavallo di due file.
//
// Reader e ricerca condividono un hook solo perché il primo è un modale DENTRO
// il secondo: l'occorrenza aperta nel reader è una riga della lista sottostante,
// e `esc` deve ritrovare quella lista esattamente com'era.
//
// Ciò che esce dal deck (il resume di una conversazione) NON sta qui: arriva
// come callback `onResume`. È il confine del criterio di partizione — gli
// effetti verso l'esterno stanno a monte, e un overlay li chiede invece di
// eseguirli.
import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'ink';
import {
  buildRows,
  firstRowKey,
  moveRowSelection,
  rowIndexOfKey,
  searchSessions,
  selectedRow,
  DEFAULT_OPTIONS,
  type SearchOptions,
  type SearchResult,
  type SearchRow,
} from '../search.js';
import { pageStep, readerCapacity, searchListCapacity } from '../viewport.js';
import { wrapWithOffsets } from '../width.js';
import { searchExcerptWidth } from '../layout.js';
import { sanitizeTyped } from '../glyphs.js';
import { SEARCH_KIND_KEYS, SEARCH_TOGGLE_KEYS, type Mode, type SearchField } from '../model.js';
import type { BodyKind, Session } from '../sessions.js';

export interface SearchOverlayDeps {
  sessions: Session[];
  rows: number;
  columns: number;
  hasNote: boolean;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Resume della conversazione su una riga-sessione: effetto esterno, non nostro. */
  onResume: (row: Extract<SearchRow, { kind: 'session' }>) => void;
}

export function useSearchOverlay(deps: SearchOverlayDeps) {
  const { sessions, rows, columns, hasNote, setMode, setNote, onResume } = deps;

  // T52 — stato del modale ricerca. VOLATILE per decisione (D4): vive in
  // memoria, quindi riaprendo il modale ritrovi query e toggle come li avevi
  // lasciati, ma un riavvio del deck riporta ai default. Niente schema nuovo su
  // `deck-view.json` e nessuna scrittura implicita su disco — che
  // contraddirebbe la regola T39 «il disco si tocca solo su `w`», qui non
  // trasportabile perché dentro il modale `w` è un carattere digitabile.
  const [hash, setHash] = useState('');
  const [query, setQuery] = useState('');
  const [field, setField] = useState<SearchField>('query');
  const [opts, setOpts] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [selKey, setSelKey] = useState<string | null>(null);
  // Occorrenza aperta nel reader; null = reader chiuso. Tenerla separata dalla
  // selezione della lista è ciò che permette a `esc` di tornare indietro
  // trovando la lista esattamente com'era.
  const [readerRow, setReaderRow] = useState<SearchRow | null>(null);
  const [readerTop, setReaderTop] = useState(0);

  // T52 — ricerca EAGER: rigira a ogni carattere digitato, non su ⏎. È
  // sostenibile perché i corpi sono già in RAM dentro la cache mtime-keyed
  // dell'adapter (D5): misurato su questo progetto, 0,8 ms sui soli corpi IA e
  // ≤9 ms su tutti i tipi — sotto il tempo fra due battute. Il memo evita di
  // rifarla sui re-render che non toccano né query né opzioni (il poll delle
  // sessioni ogni 1,5s è già filtrato dalla signature in `useSessions`).
  const result: SearchResult = useMemo(
    () => searchSessions(sessions, hash, query, opts, searchExcerptWidth(columns)),
    [sessions, hash, query, opts, columns],
  );
  // Con l'hash valorizzato la conversazione è una sola e già nominata nel campo:
  // la riga-sessione ripeterebbe un dato costante rubando una riga per gruppo.
  const flat = hash.trim().length > 0;
  const searchRows = useMemo(() => buildRows(result, flat), [result, flat]);

  // T52 — riga selezionata e, se è un'occorrenza, il suo corpo wrappato per
  // l'anteprima sotto la lista. Memoizzato per (testo, larghezza): navigando
  // con le frecce si ri-wrappa solo quando cambia davvero l'occorrenza.
  const selRow = useMemo(() => selectedRow(searchRows, selKey), [searchRows, selKey]);
  const previewWidth = Math.max(20, (columns || 80) - 8);
  const previewBody = useMemo(
    () => (selRow?.kind === 'hit' ? wrapWithOffsets(selRow.hit.text, previewWidth) : []),
    [selRow, previewWidth],
  );

  // T52 — corpo del messaggio aperto nel reader, wrappato UNA volta per (testo,
  // larghezza). Senza memo ogni pressione di freccia rifarebbe l'a-capo di un
  // messaggio che nella coda lunga arriva a 150k char.
  const readerWidth = Math.max(20, (columns || 80) - 6);
  const readerLines = useMemo(
    () => (readerRow?.kind === 'hit' ? wrapWithOffsets(readerRow.hit.text, readerWidth) : []),
    [readerRow, readerWidth],
  );
  const readerCap = readerCapacity(rows);
  const readerMaxTop = Math.max(0, readerLines.length - readerCap);
  const listCap = searchListCapacity(rows, hasNote);

  // T52 — invariante di validità della selezione, più stretta che altrove: la
  // lista si RICOSTRUISCE a ogni carattere digitato, quindi la chiave
  // selezionata sparisce di continuo. Persa → prima riga, mai una posizione
  // ereditata (che qui punterebbe a un'altra conversazione, non a un'altra riga).
  useEffect(() => {
    if (rowIndexOfKey(searchRows, selKey) < 0) {
      setSelKey(firstRowKey(searchRows));
    }
  }, [searchRows, selKey]);

  // T52 — `⏎` contestuale al TIPO di riga: la lista ne mescola due e l'azione
  // giusta dipende da quale è selezionata. Riga sessione → resume, identico al
  // `⏎` della lista sessioni (stessa funzione, T49). Riga occorrenza → reader.
  function submitRow() {
    const row = selectedRow(searchRows, selKey);
    if (!row) {
      setNote(result.error ? '⚠ regex non valida' : 'nessuna occorrenza selezionata');
      return;
    }
    if (row.kind === 'session') {
      onResume(row);
      return;
    }
    // D8 — il reader si apre POSIZIONATO sull'occorrenza, non in cima. Il 94%
    // dei messaggi entra in una schermata e la differenza non si vede; è sul 6%
    // lungo (p99 ≈ 88 righe, max ≈ 1547) che aprire in cima costringerebbe a
    // rifare a mano la ricerca appena fatta — cioè proprio il lavoro che questa
    // feature esiste per evitare.
    const lines = wrapWithOffsets(row.hit.text, readerWidth);
    const cap = readerCapacity(rows);
    const matchLine = lines.findIndex((l) => l.end > row.hit.matchStart);
    const maxTop = Math.max(0, lines.length - cap);
    setReaderRow(row);
    setReaderTop(Math.max(0, Math.min(maxTop, Math.max(0, matchLine) - Math.floor(cap / 2))));
    setNote('');
    setMode('reader');
  }

  function scrollReader(delta: number) {
    setReaderTop((t) => Math.max(0, Math.min(readerMaxTop, t + delta)));
  }

  // T52 — toggle di tipo messaggio. Spegnerli tutti è uno stato lecito (lista
  // vuota, nessun errore): è l'utente che ha chiuso ogni canale, non un guasto.
  function toggleKind(kind: BodyKind) {
    setOpts((o) => ({ ...o, kinds: { ...o.kinds, [kind]: !o.kinds[kind] } }));
  }

  function editField(fn: (s: string) => string) {
    // La nota racconta l'esito di un'AZIONE su una lista che, con l'eager, si
    // ricostruisce a ogni carattere: appena la query cambia è già scaduta.
    // Lasciarla lì la fa leggere come se descrivesse lo stato corrente — nello
    // specifico «nessuna occorrenza selezionata» sopra una lista con una riga
    // visibilmente selezionata, cioè una contraddizione a schermo.
    setNote('');
    if (field === 'hash') setHash(fn);
    else setQuery(fn);
  }

  // `useInput` consegna il CHUNK letto da stdin, non un tasto: un incollaggio —
  // o una raffica di tasti piu' veloce di una read — arriva come stringa unica,
  // byte di controllo compresi. Due conseguenze, entrambe verificate su pty:
  //
  //  1. I byte di controllo finiscono DENTRO il campo se non li si filtra. Non
  //     si vedono, ma Ink li conta nella larghezza della riga e nessun match li
  //     soddisfa -> la ricerca smette di trovare senza dire perche'. Le newline
  //     diventano spazio invece di sparire: incollare due righe deve separare
  //     le parole, non fonderle.
  //
  //  2. Un TAB digitato subito dopo una lettera (~60 ms, cioe' battitura veloce
  //     normale) arriva incollato ad essa: `key.tab` resta falso e il ramo del
  //     cambio campo non scatta mai. Trattarlo come testo lo renderebbe uno
  //     spazio, per giunta nel campo sbagliato — e' cosi' che `70897aff` + Tab
  //     + `congelat` finiva tutto quanto nel campo hash.
  //
  // Si spezza quindi il chunk SUL TAB applicando il cambio campo in mezzo: il
  // risultato e' identico alla battitura lenta. Stessa lezione del modale sort
  // (T39), che cicla sui caratteri del chunk invece di leggerlo intero.
  function typeIntoField(chunk: string) {
    setNote('');
    const parts = chunk.split('\t');
    let cur = field;
    const add: Record<SearchField, string> = { hash: '', query: '' };
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) cur = cur === 'hash' ? 'query' : 'hash';
      add[cur] += sanitizeTyped(parts[k]);
    }
    if (add.hash) setHash((v) => v + add.hash);
    if (add.query) setQuery((v) => v + add.query);
    setField(cur);
  }

  /** Apertura del modale dal modo normale: `^F`. */
  function open() {
    setNote('');
    setMode('search');
  }

  // Handler del modo `reader`. Sta prima di quello della ricerca nel catalogo di
  // `input-modes.ts`, ma la precedenza la porta ormai il modo: `mode` è un
  // valore solo, quindi i due non possono essere attivi insieme.
  function onReaderKey(input: string, key: Key) {
    if (key.escape) {
      setMode('search');
      setReaderRow(null);
    } else if (key.upArrow) {
      scrollReader(-1);
    } else if (key.downArrow) {
      scrollReader(1);
    } else if (key.pageUp) {
      scrollReader(-pageStep(readerCap));
    } else if (key.pageDown) {
      scrollReader(pageStep(readerCap));
    } else if (input === 'g') {
      // Estremi su lettera e non su Home/End: Ink RICONOSCE quelle due (le
      // mappa a 'home'/'end' nel parser) ma NON le espone — `nonAlphanumericKeys`
      // azzera l'input e nessun flag le rappresenta, quindi arrivano
      // indistinguibili da qualunque tasto ignoto. Verificato su pty reale.
      // Nel reader non c'è input di testo, quindi le lettere sono libere.
      setReaderTop(0);
    } else if (input === 'G') {
      setReaderTop(readerMaxTop);
    }
  }

  // T52 — modale ricerca. I due campi di testo mangiano ogni lettera nuda:
  // ogni comando che deve restare vivo MENTRE si digita passa da CTRL, dai
  // tasti freccia o da Tab. `esc` chiude il modale, non il deck.
  function onSearchKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setNote('');
      return;
    }
    if (key.ctrl) {
      const flag = SEARCH_TOGGLE_KEYS[input as keyof typeof SEARCH_TOGGLE_KEYS];
      if (flag) {
        setOpts((o) => ({ ...o, [flag]: !o[flag] }));
        return;
      }
      const kind = SEARCH_KIND_KEYS[input];
      if (kind) toggleKind(kind);
      return; // ogni altra combo ctrl (^F incluso: siamo già dentro) = no-op
    }
    if (key.tab) {
      setField((f) => (f === 'hash' ? 'query' : 'hash'));
    } else if (key.upArrow) {
      setSelKey((k) => moveRowSelection(searchRows, k, -1));
    } else if (key.downArrow) {
      setSelKey((k) => moveRowSelection(searchRows, k, 1));
    } else if (key.pageUp) {
      setSelKey((k) => moveRowSelection(searchRows, k, -Math.max(1, listCap)));
    } else if (key.pageDown) {
      setSelKey((k) => moveRowSelection(searchRows, k, Math.max(1, listCap)));
    } else if (key.return) {
      submitRow();
    } else if (key.backspace || key.delete) {
      editField((s) => s.slice(0, -1));
    } else if (input && !key.meta) {
      typeIntoField(input);
    }
  }

  return {
    hash,
    query,
    field,
    opts,
    selKey,
    setSelKey,
    result,
    rows: searchRows,
    selRow,
    previewBody,
    readerRow,
    readerTop,
    readerLines,
    readerCap,
    readerMaxTop,
    listCap,
    open,
    onReaderKey,
    onSearchKey,
    scrollReader,
  };
}
