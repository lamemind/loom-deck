// Overlay DETAIL della task (T66) con la sua ricerca interna (T91).
//
// Lo `sheet` è la task FOTOGRAFATA all'apertura — id, titolo e testo integrale
// del task file — e non una vista sulla selezione corrente: l'overlay copre la
// lista, quindi l'oggetto dell'azione deve restare quello che si è scelto anche
// se un tick del poll spostasse la selezione sotto.
//
// Si chiama `sheet` e non `detail` perché in `Deck` `detail` è già il
// `TaskDetail` del blocco preview sotto i pane: due cose vicine con lo stesso
// nome sono una trappola di lettura.
//
// Lo spawn della sessione dalla barra azioni NON sta qui: arriva come callback
// `onAction`, per lo stesso confine di `useSearchOverlay`.
import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'ink';
import { detailCapacity } from '../viewport.js';
import { wrapWithOffsets } from '../width.js';
import { scanText, topForOffset, type Occurrence } from '../text-search.js';
import { parseMarkdown } from '../markdown.js';
import { cpLen, insertAt, removeAt } from '../layout.js';
import { sanitizeTyped } from '../glyphs.js';
import { DETAIL_ACTIONS, type PromptKind } from '../spawn.js';
import type { Mode } from '../model.js';

export interface Sheet {
  id: string;
  title: string;
  text: string | null;
}

export interface FindState {
  q: string;
  caret: number;
  open: boolean;
}

export interface SheetOverlayDeps {
  rows: number;
  columns: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Spawn dalla barra azioni: effetto esterno, non nostro. */
  onAction: (taskId: string, kind: PromptKind, label: string) => void;
}

export function useSheetOverlay(deps: SheetOverlayDeps) {
  const { rows, columns, setMode, setNote, onAction } = deps;

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [top, setTop] = useState(0);
  const [action, setAction] = useState(0);

  // T91 — ricerca dentro il detail. `open` distingue i due modi in cui la si
  // lascia: `esc` butta via ciò che il modale ha prodotto (`find` a null,
  // evidenziazione via), `⏎` lo congela e restituisce il controllo allo strato
  // sotto — campo chiuso, occorrenze ancora colorate, scroll dov'era. Senza il
  // flag i due gesti collasserebbero su uno solo.
  const [find, setFind] = useState<FindState | null>(null);
  const [occIdx, setOccIdx] = useState(0);

  // Cornici da scalare: box esterno (2 bordi + 2 padding) + box testo (2 bordi +
  // 2 padding) = 8. Sottostimare tronca un carattere, sovrastimare manda a capo
  // una riga che il budget d'altezza non ha contato.
  const width = Math.max(20, (columns || 80) - 8);
  // T75 — il markdown si rende PRIMA del wrap, e il resto della catena lavora
  // sul testo reso: `**foo**` occupa 3 colonne rese e 7 grezze, quindi
  // wrappare sui marker manderebbe a capo su un conteggio che il terminale non
  // disegna. Memo separato dal wrap perché il parse dipende solo dal testo: un
  // resize ri-wrappa 9KB, non li ri-parsa.
  const doc = useMemo(() => (sheet?.text ? parseMarkdown(sheet.text) : null), [sheet]);
  // Le righe conservano i propri offset invece di essere appiattite a stringa
  // (T66 le buttava con `.map((l) => l.text)`): è ciò che rende
  // l'evidenziazione un'intersezione di intervalli invece di un caso speciale
  // per il match spezzato dall'a-capo. Dopo T75 gli offset indicizzano il testo
  // RESO, ed è l'unica coordinata coerente che resti — il sorgente non è più
  // ciò che sta a schermo.
  const lines = useMemo(() => (doc ? wrapWithOffsets(doc.text, width) : []), [doc, width]);
  const capacity = detailCapacity(rows, find?.open === true);
  const maxTop = Math.max(0, lines.length - capacity);

  // Lo scan gira sulla STESSA stringa che si renderizza: cercare su un testo
  // diverso da quello a schermo darebbe offset che indicizzano un altro
  // documento, cioè un'evidenziazione spostata di N caratteri e nessun errore.
  //
  // Dopo T75 quella stringa è il testo RESO, non più il sorgente: si cerca ciò
  // che si vede. Ne discende che `**` non è più cercabile — è la conseguenza
  // voluta, perché a schermo non c'è; e `Priority`, che prima era `**Priority**`
  // e si trovava lo stesso, continua a trovarsi.
  const findRes = useMemo(
    () => (find && doc ? scanText(doc.text, find.q) : { occ: [] as Occurrence[], error: '' }),
    [find?.q, doc],
  );
  // L'indice si clampa qui invece di essere corretto a ogni `setOccIdx`: la
  // lista si accorcia da sola mentre si digita, e un indice fuori range vivrebbe
  // per il tempo di un render.
  const occCur = findRes.occ.length > 0 ? Math.min(occIdx, findRes.occ.length - 1) : -1;

  // Salto all'occorrenza corrente, centrata. Non dipende da `top`, quindi non si
  // auto-rilancia; dipende da `lines` e `capacity`, quindi un resize ricalcola
  // la posizione senza toccare le occorrenze — che sono offset del sorgente e il
  // resize non le sposta.
  useEffect(() => {
    const o = occCur >= 0 ? findRes.occ[occCur] : undefined;
    if (!o) return;
    setTop(topForOffset(lines, o.start, capacity));
  }, [findRes, occCur, lines, capacity]);

  /** Apre il detail su una task, azzerando scroll, azione e ricerca. */
  function open(next: Sheet) {
    setSheet(next);
    setTop(0);
    setAction(0);
    setFind(null);
    setOccIdx(0);
    setNote('');
    setMode('detail');
  }

  function close() {
    setMode('normal');
    setSheet(null);
    setFind(null);
  }

  function scroll(delta: number) {
    setTop((t) => Math.max(0, Math.min(maxTop, t + delta)));
  }

  /** Modifica la query: l'insieme delle occorrenze cambia, quindi si riparte
   *  dalla prima. Il movimento del caret NON passa di qui — sposta il cursore,
   *  non i risultati. */
  function editFind(next: (f: FindState) => FindState) {
    setFind((f) => (f ? next(f) : f));
    setOccIdx(0);
  }

  function moveOcc(d: number) {
    const n = findRes.occ.length;
    if (n === 0) return;
    setOccIdx((i) => (Math.min(i, n - 1) + d + n) % n);
  }

  // T91 — il campo di ricerca è un modale DENTRO il detail, e lo intercetta per
  // intero: mentre è aperto mangia ogni lettera nuda, `g`/`G` compresi.
  function onFindKey(input: string, key: Key) {
    if (key.escape) {
      // Annulla: butta via ciò che il modale ha prodotto. Lo scroll resta dove
      // la ricerca l'ha portato — riavvolgerlo sarebbe una terza semantica che
      // nessun tasto ha chiesto.
      setFind(null);
    } else if (key.return) {
      // Congela: campo chiuso, occorrenze ancora colorate, scroll intatto.
      setFind((f) => (f ? { ...f, open: false } : f));
    } else if (key.upArrow) {
      moveOcc(-1);
    } else if (key.downArrow) {
      moveOcc(1);
    } else if (key.leftArrow || key.rightArrow) {
      const d = key.leftArrow ? -1 : 1;
      setFind((f) => (f ? { ...f, caret: Math.max(0, Math.min(cpLen(f.q), f.caret + d)) } : f));
    } else if (key.backspace || key.delete) {
      editFind((f) =>
        f.caret > 0 ? { ...f, q: removeAt(f.q, f.caret - 1), caret: f.caret - 1 } : f,
      );
    } else if (key.ctrl) {
      // `^U` svuota, come il filtro del modale assegnazione; ogni altra combo
      // è no-op — `^F` incluso, siamo già dentro.
      if (input === 'u') editFind((f) => ({ ...f, q: '', caret: 0 }));
    } else if (input && !key.meta) {
      const ins = sanitizeTyped(input);
      editFind((f) => ({ ...f, q: insertAt(f.q, f.caret, ins), caret: f.caret + cpLen(ins) }));
    }
  }

  // T66 — detail della task: due zone (testo scrollabile + barra azioni) e una
  // selezione per ognuna. Il modo cattura TUTTO, acceleratori `^K`/`^P`/`^R`
  // compresi: chi è già nel detail ha i bottoni. L'unica deroga è `^F`, che qui
  // apre la ricerca nel testo invece di quella sulle conversazioni.
  function onKey(input: string, key: Key) {
    if (find?.open) {
      onFindKey(input, key);
      return;
    }

    if (key.ctrl && input === 'f') {
      // Fuori dal detail `^F` è la ricerca conversazioni; qui è la ricerca nel
      // testo. La query sopravvive a una chiusura con `⏎`, quindi riaprire
      // riprende da dov'era invece di ricominciare.
      setFind((f) => (f ? { ...f, open: true } : { q: '', caret: 0, open: true }));
      return;
    }

    if (key.escape) {
      // Uno strato alla volta: se resta un'evidenziazione congelata, `esc`
      // smonta quella; il detail lo chiude il secondo.
      // Nessun reset di `sel`: la selezione della lista non è mai stata
      // toccata, quindi si ritrova esattamente dov'era.
      if (find) setFind(null);
      else close();
    } else if (key.return) {
      // `⏎` esegue SEMPRE l'azione selezionata, mai "scrolla" o "chiudi": il
      // testo non è un campo attivo (si scorre, non si edita), quindi nessuna
      // competizione sul tasto.
      const act = DETAIL_ACTIONS[action]!;
      const id = sheet?.id;
      close();
      if (id) onAction(id, act.kind, `⏎ ${act.label}`);
    } else if (key.leftArrow || key.rightArrow) {
      // Scorrimento CICLICO come le righe di scelta del modale edit: cinque
      // voci, arrivare in fondo e ripartire costa meno che invertire direzione.
      const d = key.leftArrow ? -1 : 1;
      setAction((i) => (i + d + DETAIL_ACTIONS.length) % DETAIL_ACTIONS.length);
    } else if (key.upArrow) {
      scroll(-1);
    } else if (key.downArrow) {
      scroll(1);
    } else if (key.pageUp) {
      scroll(-capacity);
    } else if (key.pageDown) {
      scroll(capacity);
    } else if (input === 'g') {
      // Estremi su lettera per lo stesso motivo del reader: Ink riconosce
      // `Home`/`End` ma non le espone, e qui non c'è input di testo che
      // contenda le lettere.
      setTop(0);
    } else if (input === 'G') {
      setTop(maxTop);
    }
  }

  return {
    sheet,
    doc,
    top,
    action,
    find,
    lines,
    capacity,
    maxTop,
    findRes,
    occCur,
    open,
    onKey,
  };
}
