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
import { detailCapacity, pageStep } from '../viewport.js';
import { wrapWithOffsets } from '../width.js';
import { scanText, topForOffset, type Occurrence } from '../text-search.js';
import { parseMarkdown } from '../markdown.js';
import { cpLen, insertAt, removeAt } from '../layout.js';
import { sanitizeTyped } from '../glyphs.js';
import {
  ACTION_HOTKEYS,
  DETAIL_ACTIONS,
  MODELS,
  MODEL_DEFAULT,
  specializeRecap,
  type ModelKind,
  type PromptKind,
} from '../spawn.js';
import { taskIsEpic } from '../tasks.js';
import { fieldsKey, type FieldSpec, type FieldsCursor, type FieldsIO } from '../fields.js';
import { loadPromptCatalog, promptFor } from '../prompt-catalog.js';
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
  /** Spawn dall'area di compilazione: effetto esterno, non nostro. Il `prompt`
   *  è il TESTO che parte davvero — dopo una modifica a mano nessun kind lo
   *  descrive più, quindi il kind non basta a dire cosa riceverà la sessione. */
  onAction: (
    taskId: string,
    kind: PromptKind,
    model: ModelKind,
    spawnNote: string,
    prompt: string,
  ) => void;
}

// T117 — le quattro righe dell'area di compilazione del detail, nell'ordine in
// cui si leggono dall'alto. Gli indici sono nominati perché li usano insieme
// l'handler dei tasti e la resa, e un `2` nudo in due file diversi è la
// coordinata che scade appena una riga si sposta.
export const DROW = { action: 0, prompt: 1, model: 2, title: 3 } as const;

export const DETAIL_FIELDS: readonly FieldSpec[] = [
  { kind: 'choice', count: DETAIL_ACTIONS.length, hotkeys: ACTION_HOTKEYS },
  { kind: 'text' },
  { kind: 'choice', count: MODELS.length },
  { kind: 'text' },
];

export function useSheetOverlay(deps: SheetOverlayDeps) {
  const { rows, columns, setMode, setNote, onAction } = deps;

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [top, setTop] = useState(0);
  const [action, setAction] = useState(0);
  // T108 — il modello con cui partirà la sessione. Stato del DETAIL e non del
  // deck: si azzera a ogni apertura come scroll e azione, quindi non esiste una
  // selezione invisibile che cambi il comportamento dei tasti della lista.
  const [model, setModel] = useState<ModelKind>(MODEL_DEFAULT);
  // T111 — il titolo con cui nascerà la conversazione (nel sidecar e in
  // `deck-run` il dato si chiama ancora `note`: il rename è di sola etichetta).
  // Si azzera a ogni apertura come scroll, azione e modello: un titolo armato
  // che sopravvive alla chiusura sarebbe uno stato invisibile che cambia il
  // titolo dello spawn successivo.
  const [spawnNote, setSpawnNote] = useState('');
  // T117 — il prompt iniziale, EDITABILE. Quello che si legge nel campo è quello
  // che parte: non un'anteprima di qualcos'altro.
  const [prompt, setPrompt] = useState('');
  /** La task aperta è un cappello (`Size: Epic`)? Deciso UNA VOLTA all'apertura,
   *  dal testo che il detail ha già in mano: rifarlo a ogni cambio di azione
   *  riparserebbe l'intero task file per un campo dell'header. */
  const [epic, setEpic] = useState(false);
  const [cursor, setCursor] = useState<FieldsCursor>({ row: DROW.action, caret: 0 });

  // Il catalogo si legge una volta per vita del deck: è un file di quattro righe
  // accanto al codice, non un dato che cambia sotto i piedi.
  const catalog = useMemo(() => loadPromptCatalog(), []);

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

  /** Apre il detail su una task, azzerando scroll, area di compilazione e ricerca. */
  function open(next: Sheet) {
    // Calcolato qui e usato subito: `setEpic` non ha ancora aggiornato lo stato
    // quando `setPrompt` gira, quindi il valore locale è l'unico leggibile ora.
    const isEpic = taskIsEpic(next.id, next.text);
    setSheet(next);
    setTop(0);
    setAction(0);
    setEpic(isEpic);
    setModel(MODEL_DEFAULT);
    setSpawnNote('');
    setPrompt(promptFor(catalog, specializeRecap(DETAIL_ACTIONS[0]!.kind, isEpic), next.id));
    setCursor({ row: DROW.action, caret: 0 });
    setFind(null);
    setOccIdx(0);
    setNote('');
    setMode('detail');
  }

  /** Cambia l'azione e RISCRIVE il prompt col default del nuovo kind (D2).
   *
   *  Nessuna preservazione del testo modificato a mano, e non è una svista: la
   *  regola `initialDetail` del modale edit protegge da un cambio di sorgente
   *  ACCIDENTALE, e col fuoco per riga quel caso non esiste — `←→` cambiano
   *  azione solo dalla riga azione, mentre sul campo prompt muovono il caret.
   *  Senza il cambio accidentale la preservazione difenderebbe da nulla, e
   *  costerebbe un campo che non torna più al default. */
  function selectAction(index: number) {
    setAction(index);
    const id = sheet?.id;
    if (id) setPrompt(promptFor(catalog, specializeRecap(DETAIL_ACTIONS[index]!.kind, epic), id));
  }

  // Il ponte fra le quattro righe e i quattro stati. Le righe restano
  // TIPIZZATE dove vivono (`ModelKind`, indice dell'azione) invece di finire in
  // un record generico: `fields.ts` governa la grammatica, non il modello dati.
  const fieldsIO: FieldsIO = {
    text: (row) => (row === DROW.prompt ? prompt : spawnNote),
    setText: (row, next) => (row === DROW.prompt ? setPrompt(next) : setSpawnNote(next)),
    choice: (row) => (row === DROW.action ? action : Math.max(0, MODELS.indexOf(model))),
    setChoice: (row, index) =>
      row === DROW.action ? selectAction(index) : setModel(MODELS[index]!),
  };

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

  // T66 — detail della task: due zone (testo scrollabile + area di compilazione)
  // e una posizione per ognuna. Il modo cattura TUTTO, acceleratori
  // `^K`/`^P`/`^R` compresi: chi è già nel detail ha i bottoni. L'unica deroga è
  // `^F`, che qui apre la ricerca nel testo invece di quella sulle conversazioni.
  //
  // T117 — le quattro righe si scorrono con `↑↓`, che quindi NON scrollano più il
  // testo: la lettura del task file resta su `PgUp`/`PgDn`, cioè una granularità
  // sola invece di due. È un costo reale su un task file lungo, ed è il prezzo di
  // avere `↑↓` nel loro significato di sempre (muovere il fuoco) su una schermata
  // che ospita insieme un documento e dei campi.
  function onKey(input: string, key: Key) {
    if (find?.open) {
      onFindKey(input, key);
      return;
    }

    if (key.ctrl && input === 'f') {
      // Deroga dichiarata (`CTRL_DEROGATIONS.detail`): fuori dal detail `^F` è
      // la ricerca conversazioni, qui la ricerca nel testo. La query sopravvive
      // a una chiusura con `⏎`, quindi riaprire riprende da dov'era.
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
      return;
    }
    if (key.return) {
      // `⏎` esegue SEMPRE l'azione selezionata, da qualunque riga: i campi sono
      // di una riga sola, quindi nessuno di loro ha da farci un a-capo.
      // Il kind viaggia specializzato quanto il prompt che lo accompagna: se il
      // campo è stato svuotato a mano il testo non parte e resta lui a dire cosa
      // ricevera' la sessione, quindi i due non possono divergere.
      const act = DETAIL_ACTIONS[action]!;
      const id = sheet?.id;
      const note = spawnNote.trim();
      const text = prompt.trim();
      close();
      if (id) onAction(id, specializeRecap(act.kind, epic), model, note, text);
      return;
    }
    if (key.pageUp) {
      scroll(-pageStep(capacity));
      return;
    }
    if (key.pageDown) {
      scroll(pageStep(capacity));
      return;
    }

    // Tutto il resto è dell'area di compilazione. Ciò che non consuma resta
    // inerte — dentro un modo capturing è la scelta giusta: gli acceleratori
    // globali non devono riattivarsi, e su una riga a scelta una lettera che
    // non è la sua non deve finire in nessun campo.
    fieldsKey(input, key, DETAIL_FIELDS, cursor, setCursor, fieldsIO);
  }

  return {
    sheet,
    doc,
    top,
    action,
    model,
    spawnNote,
    prompt,
    cursor,
    find,
    lines,
    capacity,
    maxTop,
    findRes,
    occCur,
    open,
    onKey,
    scroll,
  };
}
