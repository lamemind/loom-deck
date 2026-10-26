// T189 — il MODO DLV del detail della task: la lista dei deliverable,
// selezionabile, al posto dell'area di compilazione.
//
// È una variante dell'azione `run` del detail, non un'azione nuova (D3): stesso
// spawn, stesso modello, stesso titolo, override di progetto compreso. Cambia
// solo il prompt — il perimetro scelto in coda (`/loom-works:run-task T189 2,4`),
// oppure `cosa fare ora [R0]` senza selezione (D4).
//
// Vive fuori da `sheet.ts` (D5) e non lo importa: il detail possiede il modo,
// questo modulo ne possiede lo stato. Le regole del plugin che decide di
// rispettare — numerazione e gate di `run-task` — stanno in `deliverables.ts`.
import { useState } from 'react';
import type { Key } from 'ink';
import {
  dlvGate,
  dlvLaunchable,
  parseDeliverables,
  type Deliverable,
  type DlvGate,
} from '../deliverables.js';
import type { ModelKind } from '../spawn-catalog.js';
import type { ResolvedSpawn } from '../spawn-config.js';

/** D4 — il prompt di `⏎` senza nessun DLV selezionato. */
export const DLV_IDLE_PROMPT = 'cosa fare ora [R0]';

/**
 * D3/D4 — il prompt che parte da `⏎` nel modo DLV.
 *
 * Con una selezione: il prompt dell'azione `run` GIÀ RISOLTO (default del deck ←
 * override di progetto, buchi riempiti) con `DLV` e il perimetro in coda, in
 * ordine crescente — `run-task T99 DLV 2,5,7`. La parola `DLV` dice alla skill
 * che i numeri sono deliverable e non un'altra cosa; l'ordine crescente serve a
 * chi legge la riga di stato prima di premere, `run-task` normalizza da sé.
 * Lista semplice e non range: la grammatica `1,3-5` di `run-task` la accetta, e
 * compattare non toglie ambiguità.
 *
 * Senza selezione: `cosa fare ora [R0]`, nella stessa sessione bound di `run`.
 */
export function dlvPrompt(runPrompt: string | null, selected: Iterable<number>): string {
  const scope = [...selected].sort((a, b) => a - b);
  if (scope.length === 0) return DLV_IDLE_PROMPT;
  return `${(runPrompt ?? '').trim()} DLV ${scope.join(',')}`.trim();
}

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

/** Ciò che serve all'apertura: la task fotografata dal detail, più la terna
 *  dell'azione `run` già risolta su questa task. */
export interface DlvOpenInput {
  id: string;
  text: string | null;
  /** La task è ✔️ in `tasks.md`. */
  done: boolean;
  run: ResolvedSpawn;
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

  /**
   * Azzera tutto a ogni apertura del detail, come gli altri campi: una selezione
   * che sopravvive alla chiusura farebbe partire un perimetro che a schermo non
   * si vede più.
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
    setCursor(dlvLaunchable(g) ? stepOpen(list, 0, 1) : 0);
    setSelected(NONE);
    setActive(dlvLaunchable(g));
  }

  function toggle() {
    setActive((a) => !a);
  }

  const prompt = dlvPrompt(run?.prompt ?? null, selected);

  /** Lo spawn di `⏎`, o `null` se non c'è niente da lanciare: la ragione è già
   *  a schermo nella riga di stato della lista, quindi il tasto resta inerte. */
  function launch(): DlvLaunch | null {
    if (!dlvLaunchable(gate) || !run) return null;
    return { model: run.model, title: (run.title ?? '').trim(), prompt };
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
    model: run?.model ?? null,
    open,
    toggle,
    launch,
    onKey,
  };
}
