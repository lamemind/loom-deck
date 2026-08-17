// Overlay ASSEGNAZIONE conversazione → task (T57): stato, lista filtrata e input.
//
// `sid` è la conversazione in assegnazione, FOTOGRAFATA all'apertura e non
// riletta dalla selezione corrente: il modale è fullscreen (D3), quindi il pane
// sessioni non è più a schermo e l'oggetto dell'azione deve restare quello che
// si è scelto — anche se un tick del poll rimescolasse la lista sotto.
//
// `sel` è la task di destinazione: `null` è la riga `detach` (D2), che sta
// sempre in testa e scrive un binding vuoto.
//
// La scrittura del sidecar NON sta qui: arriva come callback `onSubmit`.
import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'ink';
import { assignListCapacity } from '../viewport.js';
import { sanitizeTyped } from '../glyphs.js';
import type { Mode } from '../model.js';
import type { Task } from '../tasks.js';

export interface AssignOverlayDeps {
  /** Le task fra cui scegliere: la vista corrente, filtri compresi. */
  viewTasks: Task[];
  rows: number;
  hasNote: boolean;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Scrittura del binding: effetto esterno, non nostro. `target` null = detach. */
  onSubmit: (sid: string, target: string | null) => void;
}

export function useAssignOverlay(deps: AssignOverlayDeps) {
  const { viewTasks, rows, hasNote, setMode, setNote, onSubmit } = deps;

  const [sid, setSid] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  // Il filtro è un substring case-insensitive su id + titolo grezzo (D5): un
  // restringimento veloce, non una ricerca — quella è `^F` e ha il suo motore.
  // Il solo id non basterebbe, perché il caso d'uso nasce proprio dal «ho
  // capito ora che questa conversazione è la task del titolo X».
  //
  // `detach` NON si filtra: è l'azione di svuotamento, non una task, e sparire
  // digitando la renderebbe raggiungibile solo a campo vuoto.
  const list = useMemo<Array<Task | null>>(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? viewTasks.filter(
          (t) => t.id.toLowerCase().includes(q) || t.rawDesc.toLowerCase().includes(q),
        )
      : viewTasks;
    return [null, ...matched];
  }, [viewTasks, filter]);
  const capacity = assignListCapacity(rows, hasNote);

  // T57 — la lista del modale si restringe a ogni carattere digitato: quando la
  // task selezionata esce dal filtro si cade sulla PRIMA TASK, non su `detach`.
  // Cadere su detach significherebbe che un `⏎` battuto di slancio dopo aver
  // digitato staccherebbe la sessione invece di assegnarla — l'esatto opposto
  // dell'intenzione. Senza match la selezione resta detach: è l'unica riga viva.
  useEffect(() => {
    if (sel !== null && !list.some((t) => t?.id === sel)) {
      setSel(list[1]?.id ?? null);
    }
  }, [list, sel]);

  // T57 — apertura. La preselezione è la task a cui la sessione è GIÀ legata
  // (riassegnare è quasi sempre correggere, e vedere da dove si parte è metà
  // dell'informazione), altrimenti la prima della vista. Mai `detach`: è
  // l'azione distruttiva della lista, e preselezionarla metterebbe un `⏎`
  // battuto di slancio a un tasto dal cancellare un binding.
  function open(sessionId: string, bound: string | undefined) {
    setSid(sessionId);
    setFilter('');
    setSel(bound && viewTasks.some((t) => t.id === bound) ? bound : viewTasks[0]?.id ?? null);
    setNote('');
    setMode('assign');
  }

  /** Sposta la selezione sulle righe (0 = detach, 1..N = task filtrate). */
  function move(delta: number) {
    const at = list.findIndex((t) => (t?.id ?? null) === sel);
    const next = Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at) + delta));
    setSel(list[next]?.id ?? null);
  }

  function submit() {
    const sessionId = sid;
    const target = sel;
    setMode('normal');
    setFilter('');
    if (!sessionId) return;
    onSubmit(sessionId, target);
  }

  // T57 — un campo di filtro più una lista. Come ricerca e nota, il campo mangia
  // ogni lettera nuda → `^U` (kill-line delle shell) per svuotarlo, e la
  // navigazione passa dalle frecce.
  function onKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setFilter('');
      setNote('A → assegnazione annullata');
    } else if (key.return) {
      submit();
    } else if (key.upArrow) {
      move(-1);
    } else if (key.downArrow) {
      move(1);
    } else if (key.pageUp) {
      move(-Math.max(1, capacity));
    } else if (key.pageDown) {
      move(Math.max(1, capacity));
    } else if (key.ctrl) {
      // `^U` svuota; ogni altra combo è no-op. Il backspace tenuto premuto
      // cancella un carattere per CHUNK letto da stdin, non per pressione
      // (T53): senza `^U` ripulire un filtro digitato di getto sarebbe lento
      // quanto riaprire il modale.
      if (input === 'u') setFilter('');
    } else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
    } else if (input && !key.meta) {
      setFilter((f) => f + sanitizeTyped(input));
    }
  }

  return { sid, filter, sel, list, capacity, open, onKey };
}
