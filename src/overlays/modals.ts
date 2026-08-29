// I modali IN FLUSSO: quelli che si disegnano in un box dentro la cornice
// invece di sostituirla. Sono due famiglie e stanno nello stesso file perché
// hanno lo stesso mestiere — tenere una bozza mentre si digita — e perché il
// loro gemello di vista esiste già e si chiama `ui/modals.tsx`. La simmetria
// `ui/modals.tsx` (vista) ↔ `overlays/modals.ts` (stato e input) è essa stessa
// un'informazione: chi cerca l'uno trova l'altro.
//
// `useViewModals` governa sort e filtri, che compongono la VISTA. Lo stato
// `view` non è loro e vive nel modello (`deck-model.ts`): è ciò che `applyView`
// consuma, è persistito su disco e lo rilegge il tasto `w`. Qui resta ciò che è
// davvero del modale — la fotografia per l'annullamento e la posizione nella
// griglia dei filtri.
//
// `useTextModals` governa create, nota ed edit, cioè i tre campi di testo. Le
// scritture che ne conseguono escono come callback (deroga T104: un hook di
// overlay non esce dal deck).
import { useState } from 'react';
import type { Key } from 'ink';
import { caretAtEnd, fieldsKey, type FieldsCursor, type FieldsIO } from '../fields.js';
import { sanitizeTyped } from '../glyphs.js';
import {
  EDIT_FIELDS,
  EDIT_PRI,
  EDIT_PROG,
  editTextField,
  SORT_TASTI,
  type EditDraft,
  type FilterCursor,
  type Mode,
} from '../model.js';
import {
  cycleSort,
  describeSort,
  toggleHidden,
  PRI_ENTRIES,
  PROG_ENTRIES,
  type PriName,
  type ProgName,
  type ViewState,
} from '../view.js';
import type { Task } from '../tasks.js';

export function useViewModals({
  view,
  setView,
  hiddenTasks,
  setMode,
  setNote,
}: {
  view: ViewState;
  setView: (f: (v: ViewState) => ViewState) => void;
  hiddenTasks: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}) {
  // T39 — fotografia della vista all'apertura di un modale: la lista si
  // aggiorna dal vivo, quindi `esc` deve poter ripristinare.
  const [backup, setBackup] = useState<ViewState | null>(null);
  const [filterCursor, setFilterCursor] = useState<FilterCursor>({ row: 0, col: 0 });

  /** Chiusura: `restore` rimette la fotografia (esc = annulla), altrimenti tiene ciò che si è composto (⏎). */
  function close(restore: boolean) {
    if (restore && backup) {
      const snapshot = backup;
      setView(() => snapshot);
    }
    setBackup(null);
    setMode('normal');
  }

  function openSort() {
    setBackup(view);
    setNote('');
    setMode('sort');
  }

  function openFilter() {
    setBackup(view);
    setNote('');
    setMode('filter');
  }

  function onSortKey(input: string, key: Key) {
    if (key.escape) {
      close(true);
      setNote('S → sort annullato');
    } else if (key.return) {
      close(false);
      setNote(`S → sort: ${describeSort(view.sort)}`);
    } else if (input) {
      // useInput consegna il CHUNK letto da stdin, non un tasto: digitando
      // veloce (o incollando) `ppi` arriva come stringa unica. Si cicla su
      // ogni carattere, così la chain esce identica a battitura lenta.
      const keys = [...input].map((ch) => SORT_TASTI[ch]).filter(Boolean);
      if (keys.length > 0) {
        setView((v) => ({ ...v, sort: keys.reduce(cycleSort, v.sort) }));
      }
    }
  }

  function onFilterKey(input: string, key: Key) {
    const rowLen = (r: 0 | 1) => (r === 0 ? PRI_ENTRIES.length : PROG_ENTRIES.length);
    if (key.escape) {
      close(true);
      setNote('F → filtri annullati');
    } else if (key.return) {
      close(false);
      setNote(hiddenTasks > 0 ? `F → ${hiddenTasks} task nascoste` : 'F → nessun filtro attivo');
    } else if (key.upArrow || key.downArrow) {
      setFilterCursor((c) => {
        const row: 0 | 1 = c.row === 0 ? 1 : 0;
        return { row, col: Math.min(c.col, rowLen(row) - 1) };
      });
    } else if (key.leftArrow) {
      setFilterCursor((c) => ({ ...c, col: Math.max(0, c.col - 1) }));
    } else if (key.rightArrow) {
      setFilterCursor((c) => ({ ...c, col: Math.min(rowLen(c.row) - 1, c.col + 1) }));
    } else if (input === ' ') {
      const { row, col } = filterCursor;
      setView((v) =>
        row === 0
          ? { ...v, hiddenPri: toggleHidden<PriName>(v.hiddenPri, PRI_ENTRIES[col]!.name) }
          : { ...v, hiddenProg: toggleHidden<ProgName>(v.hiddenProg, PROG_ENTRIES[col]!.name) },
      );
    }
  }

  return { filterCursor, openSort, openFilter, onSortKey, onFilterKey };
}

export function useTextModals({
  setMode,
  setNote,
  onCreate,
  onNote,
  onEdit,
  editDraftFor,
  currentNote,
}: {
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  onCreate: (text: string) => void;
  onNote: (sid: string, text: string) => void;
  onEdit: (task: Task, draft: EditDraft) => void;
  /** La bozza dell'edit seminata dai valori attuali della task. */
  editDraftFor: (task: Task) => EditDraft;
  /** La nota già scritta su una conversazione, per precaricare il campo. */
  currentNote: (sid: string) => string;
}) {
  const [draft, setDraft] = useState('');
  // T53 — bozza della nota sulla conversazione selezionata. Si apre PRECARICATA
  // con la nota esistente: annotare due volte è quasi sempre correggere, non
  // riscrivere da zero, e un campo vuoto costringerebbe a ridigitare tutto per
  // cambiare una parola. Confermare il campo vuoto cancella la nota.
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSid, setNoteSid] = useState<string | null>(null);
  // T41 — bozza dell'edit (null fuori dal modale) e posizione nell'area di
  // compilazione: riga in fuoco + caret dentro la riga di testo attiva.
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [editCursor, setEditCursor] = useState<FieldsCursor>({ row: 0, caret: 0 });

  function openCreate() {
    setNote('');
    setMode('create');
  }

  function openNote(sid: string) {
    setNoteSid(sid);
    setNoteDraft(currentNote(sid));
    setNote('');
    setMode('note');
  }

  function openEdit(task: Task) {
    setEditTask(task);
    setEdit(editDraftFor(task));
    // Si apre sulla riga 0 (priorità), che non è un campo di testo: il caret
    // prende la sua posizione entrando in una riga di testo con ↑↓.
    setEditCursor({ row: 0, caret: 0 });
    setNote('');
    setMode('edit');
  }

  function onCreateKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setDraft('');
      setNote('C → create annullato');
    } else if (key.return) {
      const text = draft.trim();
      setMode('normal');
      setDraft('');
      onCreate(text);
    } else if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setDraft((d) => d + input);
    }
  }

  function onNoteKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setNoteDraft('');
      setNote('N → titolo annullato');
    } else if (key.return) {
      const sid = noteSid;
      const text = noteDraft.trim();
      setMode('normal');
      setNoteDraft('');
      if (sid) onNote(sid, text);
    } else if (key.ctrl && input === 'u') {
      // Svuota il campo in un colpo. NON è una scorciatoia di comodo: il
      // backspace tenuto premuto cancella UN carattere per CHUNK letto da
      // stdin, non per pressione (`useInput` consegna il chunk, e per una
      // raffica di DEL Ink alza `key.backspace` una volta sola) — misurato,
      // 30 pressioni → 2 caratteri. Siccome «campo vuoto» qui è l'unico modo
      // di CANCELLARE una nota, dipendere dal backspace renderebbe
      // l'operazione praticamente non eseguibile. `^U` è il kill-line delle
      // shell, quindi il gesto è già nelle dita di chi usa un terminale.
      setNoteDraft('');
    } else if (key.backspace || key.delete) {
      setNoteDraft((d) => d.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      // Sanificazione dei byte di controllo, come `typeIntoField` della
      // ricerca: `useInput` consegna il CHUNK letto da stdin, quindi un
      // incollaggio porta dentro newline e control char. Invisibili a schermo
      // ma contati da Ink nella larghezza della riga — e qui finirebbero
      // scritti su disco, dove resterebbero a sporcare la riga per sempre.
      // Le newline diventano spazio: incollare due righe deve separare le
      // parole, non fonderle.
      setNoteDraft((d) => d + sanitizeTyped(input));
    }
  }

  // Il ponte fra le quattro righe del modale e la bozza. I valori restano
  // tipizzati (`PriName`, `ProgName`) invece di finire in un record generico:
  // `fields.ts` governa la grammatica dei tasti, non il modello dati.
  const editIO: FieldsIO = {
    text: (row) => edit?.[editTextField(row)] ?? '',
    setText: (row, next) => setEdit((e) => (e ? { ...e, [editTextField(row)]: next } : e)),
    choice: (row) =>
      row === 0
        ? Math.max(0, EDIT_PRI.indexOf(edit?.pri ?? 'med'))
        : Math.max(0, EDIT_PROG.indexOf(edit?.prog ?? 'todo')),
    setChoice: (row, index) =>
      setEdit((e) =>
        e ? (row === 0 ? { ...e, pri: EDIT_PRI[index]! } : { ...e, prog: EDIT_PROG[index]! }) : e,
      ),
  };

  function onEditKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setEdit(null);
      setNote('E → edit annullato');
      return;
    }
    if (key.return) {
      const task = editTask;
      const current = edit;
      setMode('normal');
      setEdit(null);
      if (task && current) onEdit(task, current);
      return;
    }
    // Tutto il resto è dell'area di compilazione, che è la STESSA del detail
    // (T117): una grammatica sola, non due copie da tenere allineate a mano.
    fieldsKey(input, key, EDIT_FIELDS, editCursor, setEditCursor, editIO);
  }

  return {
    draft,
    noteDraft,
    edit,
    editTask,
    editCursor,
    openCreate,
    openNote,
    openEdit,
    onCreateKey,
    onNoteKey,
    onEditKey,
  };
}

export { caretAtEnd };
