// T189 — il MODO DLV del detail della task: la lista dei deliverable,
// selezionabile, al posto dell'area di compilazione.
//
// Con una selezione è una variante dell'azione `run` del detail, non un'azione
// nuova (D3): stesso spawn, stesso modello, stesso titolo, override di progetto
// compreso, col perimetro eseguibile scelto in coda al prompt
// (`/loom-works:run-task T189 DLV 2,4`). Senza selezione è l'azione `open` dei
// campi: la task si apre a mani nude, senza nessun prompt.
//
// Vive fuori da `sheet.ts` (D5) e non lo importa: il detail possiede il modo,
// questo modulo ne possiede lo stato. Le regole del plugin che decide di
// rispettare — numerazione e gate di `run-task` — stanno in `deliverables.ts`.
import { useState } from 'react';
import type { Key } from 'ink';
import {
  dlvGate,
  dlvLaunchable,
  dlvPrompt,
  parseDeliverables,
  type Deliverable,
  type DlvGate,
} from '../deliverables.js';

// T205 — `dlvPrompt` vive in `deliverables.ts`, senza React: lo usano anche
// l'endpoint del deck e `loom-deck-headless`, che non montano nessuna vista.
// Riesportato qui per chi lo importava dal modo DLV.
export { dlvPrompt };
import type { ModelKind } from '../spawn-catalog.js';
import type { ResolvedSpawn } from '../spawn-config.js';

/**
 * Il DLV aperto dopo (o prima di) `from`, in giro come le righe dell'area di
 * compilazione: `↑↓` si fermano solo sui DLV da fare. `from` è un NUMERO di DLV
 * e non un indice — resta valido comunque la lista venga finestrata a schermo.
 * `from` fuori dagli aperti → il primo aperto; nessun DLV aperto → 0.
 */
export function stepOpen(dlvs: readonly Deliverable[], from: number, delta: number): number {
  const open = dlvs.filter((d) => !d.done).map((d) => d.n);
  if (open.length === 0) return 0;
  const at = open.indexOf(from);
  if (at < 0) return open[0]!;
  return open[(((at + delta) % open.length) + open.length) % open.length]!;
}

/** `spazio` sul DLV `n`: lo mette nella selezione o lo toglie. */
export function toggleIn(selected: ReadonlySet<number>, n: number): ReadonlySet<number> {
  const next = new Set(selected);
  if (next.has(n)) next.delete(n);
  else next.add(n);
  return next;
}

/** Ciò che serve all'apertura: la task fotografata dal detail, più le terne
 *  delle azioni `run` e `open` già risolte su questa task. */
export interface DlvOpenInput {
  id: string;
  text: string | null;
  /** La task è ✔️ in `tasks.md`. */
  done: boolean;
  run: ResolvedSpawn;
  open: ResolvedSpawn;
}

/** Lo spawn che `⏎` farebbe partire: gli stessi argomenti di `onAction`. */
export interface DlvLaunch {
  model: ModelKind;
  title: string;
  prompt: string;
}

const NONE: ReadonlySet<number> = new Set();
const CLOSED: DlvGate = { kind: 'off', reason: '' };

export function useDlvMode() {
  /** Il detail mostra la lista DLV (`true`) o l'area di compilazione. */
  const [active, setActive] = useState(false);
  const [dlvs, setDlvs] = useState<readonly Deliverable[]>([]);
  const [gate, setGate] = useState<DlvGate>(CLOSED);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(NONE);
  const [run, setRun] = useState<ResolvedSpawn | null>(null);
  const [openAction, setOpenAction] = useState<ResolvedSpawn | null>(null);

  /**
   * Azzera tutto a ogni apertura del detail, come gli altri campi: una selezione
   * che sopravvive alla chiusura farebbe partire un perimetro eseguibile che a
   * schermo non si vede più.
   *
   * Il modo di apertura è il gate: si apre sui DLV quando `⏎` lì lancia
   * qualcosa, avviso compreso — su una task chiusa o senza DLV aperti l'area di
   * compilazione resta quella di sempre, e la lista si raggiunge con `tab`.
   */
  function open(input: DlvOpenInput) {
    const list = parseDeliverables(input.text);
    const g = dlvGate(input.id, input.text, list, input.done);
    setDlvs(list);
    setGate(g);
    setRun(input.run);
    setOpenAction(input.open);
    setCursor(dlvLaunchable(g) ? stepOpen(list, 0, 1) : 0);
    setSelected(NONE);
    setActive(dlvLaunchable(g));
  }

  function toggle() {
    setActive((a) => !a);
  }

  const prompt = dlvPrompt(run?.prompt ?? null, selected);
  /** L'azione che `⏎` replica: `run` col perimetro eseguibile, `open` senza selezione. */
  const action = selected.size > 0 ? run : openAction;

  /** Lo spawn di `⏎`. Vale su ogni gate: in `off` nessun DLV è selezionabile,
   *  quindi `⏎` apre la task a mani nude come l'azione `open` dei campi. */
  function launch(): DlvLaunch | null {
    if (!action) return null;
    return { model: action.model, title: (action.title ?? '').trim(), prompt };
  }

  /** I tasti della lista. Il chiamante gestisce prima i suoi (`tab`, `⏎`, `esc`,
   *  `^F`, `PgUp`/`PgDn`); qui resta ciò che muove cursore e selezione. In `off`
   *  nessun DLV è selezionabile, quindi ogni tasto è inerte. */
  function onKey(input: string, key: Key) {
    if (!dlvLaunchable(gate)) return;
    if (key.upArrow || key.downArrow) {
      setCursor((c) => stepOpen(dlvs, c, key.upArrow ? -1 : 1));
    } else if (input === ' ' && !key.ctrl && !key.meta && cursor > 0) {
      setSelected((s) => toggleIn(s, cursor));
    }
  }

  return {
    active,
    dlvs,
    gate,
    cursor,
    selected,
    prompt,
    model: action?.model ?? null,
    open,
    toggle,
    launch,
    onKey,
  };
}
