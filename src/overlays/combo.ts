// T194 — il modale delle combo: undicesima schermata sostitutiva, apri-e-chiudi.
//
// Mostra le tre liste di `deckLegend` a prescindere dal pane a fuoco. Sola lettura
// e nessuna selezione: la rotella e `↑↓` muovono una posizione di lettura, come nel
// viewer del project status (D5 di T21).
//
// Le liste arrivano come argomento di `open` e non si ricalcolano a modale aperto:
// un tick del poll che togliesse il bottone di restore toglierebbe anche la sua voce,
// e lo scroll non avrebbe più un riferimento. È la stessa regola della lista
// hard-wrap. Le RIGHE invece si ricompongono a ogni render, perché dipendono dalla
// larghezza e un resize deve poter rifare gli a capo.
import { useState } from 'react';
import type { Key } from 'ink';
import { comboLines, type DeckLegend } from '../combo-catalog.js';
import { comboListCapacity, comboTextWidth, pageStep } from '../viewport.js';
import type { Mode } from '../model.js';

export interface ComboOverlayDeps {
  rows: number;
  columns: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}

export function useComboOverlay(deps: ComboOverlayDeps) {
  const { rows, columns, setMode, setNote } = deps;

  const [legend, setLegend] = useState<DeckLegend | null>(null);
  const [top, setTop] = useState(0);

  const capacity = comboListCapacity(rows);
  const lines = legend ? comboLines(legend, comboTextWidth(columns)) : null;
  const total = lines?.length ?? 0;
  const maxTop = Math.max(0, total - capacity);

  function open(next: DeckLegend) {
    setLegend(next);
    setTop(0);
    setNote('');
    setMode('combo');
  }

  function close() {
    setMode('normal');
    setLegend(null);
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

  return { lines, top, capacity, maxTop, open, onKey, scroll };
}
