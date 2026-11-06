// T194 — il modale delle combo: undicesima schermata sostitutiva, apri-e-chiudi.
//
// Elenca le voci di `deckLegend` per il pane che aveva il fuoco quando `H` è
// stato premuto. Sola lettura e nessuna selezione: la rotella e `↑↓` muovono una
// posizione di lettura, come nel viewer del project status (D5 di T21).
//
// Le voci arrivano come argomento di `open` e non si ricalcolano a modale aperto:
// un tick del poll che togliesse la conversazione selezionata riscriverebbe
// l'elenco sotto gli occhi, e lo scroll non avrebbe più un riferimento. È la
// stessa regola della lista hard-wrap.
import { useState } from 'react';
import type { Key } from 'ink';
import { comboRows, type ComboRow } from '../frame.js';
import { comboListCapacity, pageStep } from '../viewport.js';
import { termWidth } from '../width.js';
import type { Mode } from '../model.js';

export interface ComboOverlayDeps {
  rows: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}

export function useComboOverlay(deps: ComboOverlayDeps) {
  const { rows, setMode, setNote } = deps;

  const [list, setList] = useState<ComboRow[] | null>(null);
  const [top, setTop] = useState(0);

  const capacity = comboListCapacity(rows);
  const total = list?.length ?? 0;
  const maxTop = Math.max(0, total - capacity);
  // La colonna dei tasti si misura sulla lista INTERA, non sulla finestra: una
  // misura sulle sole righe visibili farebbe saltare le etichette a ogni scroll.
  const keyW = Math.max(0, ...(list ?? []).map((r) => termWidth(r.key)));

  function open(legend: readonly string[]) {
    setList(comboRows(legend));
    setTop(0);
    setNote('');
    setMode('combo');
  }

  function close() {
    setMode('normal');
    setList(null);
  }

  function scroll(delta: number) {
    setTop((t) => Math.max(0, Math.min(maxTop, t + delta)));
  }

  function onKey(input: string, key: Key) {
    if (key.escape) {
      close();
    } else if (key.upArrow) {
      scroll(-1);
    } else if (key.downArrow) {
      scroll(1);
    } else if (key.pageUp) {
      scroll(-pageStep(capacity));
    } else if (key.pageDown) {
      scroll(pageStep(capacity));
    } else if (input === 'g') {
      setTop(0);
    } else if (input === 'G') {
      setTop(maxTop);
    }
  }

  return { list, top, capacity, maxTop, keyW, open, onKey, scroll };
}
