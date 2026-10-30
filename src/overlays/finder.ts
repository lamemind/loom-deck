// Overlay FINDER delle task (T169): stato, lista filtrata e input.
//
// Il finder cerca su TUTTE le righe di `tasks.md`, viste e filtri del pane
// ignorati: le task chiuse che il filtro salvato nasconde sono proprio quelle
// che obbligavano a cambiare vista prima di trovarle. Il motore è puro e sta in
// `finder.ts`; qui c'è solo ciò che il campo e la lista ricordano fra un tasto
// e l'altro.
//
// La selezione SEGUE la query finché non la si muove: a ogni carattere torna su
// `initialSelection` (l'id esatto, o la prima riga), ed è ciò che rende sicuro
// il gesto `T` `142` `⏎` — la riga sotto il cursore è quella digitata, non una
// rimasta da prima. Una freccia la fissa su un id, che resta finché la query non
// cambia o la riga non esce dalla lista.
//
// Le due uscite verso il deck — il detail su `⏎` e il salto al pane
// conversazioni su `→` — arrivano come callback: un overlay chiede gli effetti
// fuori da sé, non li esegue (stesso confine della ricerca e dell'assegnazione).
import { useMemo, useState } from 'react';
import type { Key } from 'ink';
import { findTasks, initialSelection } from '../finder.js';
import { finderLayout } from '../viewport.js';
import { sanitizeTyped } from '../glyphs.js';
import { useTaskDetail } from '../hooks.js';
import type { Mode } from '../model.js';
import type { Task, TaskDetail } from '../tasks.js';

export interface FinderOverlayDeps {
  /** Le righe di `tasks.md` così come le carica il poll: nessuna vista, nessun filtro. */
  tasks: Task[];
  tasksDir: string;
  rows: number;
  hasNote: boolean;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** `⏎` — il detail della task. Riceve il task file già letto per la preview,
   *  quando c'è: il titolo lungo viene da lì. Il detail imposta il proprio modo. */
  onOpen: (task: Task, detail: TaskDetail | null) => void;
  /** `→` — la task selezionata nel pane task e il fuoco sulle conversazioni. */
  onJump: (id: string) => void;
}

export function useFinderOverlay(deps: FinderOverlayDeps) {
  const { tasks, tasksDir, rows, hasNote, setMode, setNote, onOpen, onJump } = deps;

  // Lo stato è APERTO/CHIUSO e non solo il modo: il task file della preview si
  // legge solo a finder aperto, e il modo vive nel deck, non qui.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // L'id fissato da una freccia; `null` = la selezione segue la query.
  const [moved, setMoved] = useState<string | null>(null);

  const result = useMemo(() => findTasks(tasks, query), [tasks, query]);
  const sel = moved && result.tasks.some((t) => t.id === moved) ? moved : initialSelection(result);
  const selTask = sel ? result.tasks.find((t) => t.id === sel) ?? null : null;
  // Un task file letto per selezione, lo stesso hook del blocco preview sotto
  // i pane: navigando con le frecce si rilegge solo quando cambia l'id.
  const detail = useTaskDetail(tasksDir, open && sel ? sel : undefined);
  const layout = finderLayout(rows, hasNote);

  /** Testo da evidenziare nelle righe: solo una query di testo. Un id non si
   *  evidenzia — sta nella sua colonna, e la selezione è già sopra. */
  const mark = result.query.kind === 'text' ? result.query.text : '';

  // T169/P10 — `T` apre sempre a campo vuoto: una query rimasta da prima
  // trasformerebbe `T` `142` `⏎` in `T` `<vecchia>142` `⏎`, cioè nella riga
  // sbagliata o in nessuna.
  function openFinder() {
    setQuery('');
    setMoved(null);
    setOpen(true);
    setNote('');
    setMode('finder');
  }

  function close() {
    setOpen(false);
    setMode('normal');
  }

  /**
   * `⏎` e `→`: si agisce sulla riga che il finder ha sotto il cursore. `typed`
   * è il testo arrivato nello STESSO chunk del tasto — una battitura veloce
   * consegna `142⏎` in una lettura sola (`useInput` dà il chunk, non il tasto) —
   * e la selezione si ricalcola sulla query che lo include: lo stato aggiornato
   * da `setQuery` arriverebbe al render dopo, cioè sulla riga di prima.
   *
   * T169/P1 — `⏎` apre il detail e basta: la selezione del pane resta dov'era,
   * e `esc` dal detail torna al deck (P10). `→` è il gesto che sposta il pane.
   */
  function exit(how: 'open' | 'jump', typed: string) {
    const target = typed ? initialSelection(findTasks(tasks, query + typed)) : sel;
    const task = target ? tasks.find((t) => t.id === target) ?? null : null;
    if (!task) {
      if (typed) edit((q) => q + typed);
      setNote(`${how === 'open' ? '⏎' : '→'} → nessuna task selezionata`);
      return;
    }
    setOpen(false);
    if (how === 'open') {
      // Il task file della preview vale solo se è quello della riga su cui si
      // agisce: con del testo appena digitato la riga è cambiata, e il detail
      // ripiega sulla riga di tasks.md per il titolo.
      onOpen(task, !typed && detail?.id === task.id ? detail : null);
    } else {
      setMode('normal');
      onJump(task.id);
    }
  }

  function edit(fn: (q: string) => string) {
    setQuery(fn);
    setMoved(null);
    // La nota racconta l'esito di un'azione su una lista che si ricostruisce a
    // ogni carattere: appena la query cambia è già scaduta (stessa ragione della
    // ricerca, `overlays/search.ts`).
    setNote('');
  }

  function move(delta: number) {
    const list = result.tasks;
    if (list.length === 0) return;
    const at = list.findIndex((t) => t.id === sel);
    const next = Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at) + delta));
    setMoved(list[next]!.id);
  }

  // Un campo più una lista, come l'assegnazione: il campo mangia ogni lettera
  // nuda, quindi `^U` lo svuota e la navigazione passa dalle frecce.
  function onKey(input: string, key: Key) {
    // Un `⏎` incollato al testo che lo precede (vedi `exit`): ciò che sta prima
    // va nel campo, poi si agisce. Ciò che segue nello stesso chunk si perde —
    // dopo `⏎` il finder è già chiuso, e nessun tasto battuto lì era per lui.
    const cr = key.return ? -1 : input.indexOf('\r');
    if (cr >= 0) {
      exit('open', sanitizeTyped(input.slice(0, cr)));
      return;
    }
    if (key.escape) {
      close();
      setNote('');
    } else if (key.return) {
      exit('open', '');
    } else if (key.rightArrow) {
      exit('jump', '');
    } else if (key.upArrow) {
      move(-1);
    } else if (key.downArrow) {
      move(1);
    } else if (key.pageUp) {
      move(-Math.max(1, layout.list));
    } else if (key.pageDown) {
      move(Math.max(1, layout.list));
    } else if (key.ctrl) {
      if (input === 'u') edit(() => '');
    } else if (key.backspace || key.delete) {
      edit((q) => q.slice(0, -1));
    } else if (input && !key.meta && !key.return && !key.tab) {
      edit((q) => q + sanitizeTyped(input));
    }
  }

  return {
    query,
    result,
    sel,
    selTask,
    detail,
    layout,
    mark,
    open: openFinder,
    onKey,
  };
}
