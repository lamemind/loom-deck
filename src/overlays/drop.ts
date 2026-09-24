// L'overlay di conferma dell'eliminazione di una CONVERSAZIONE (`CANC` sul pane
// sessioni). Gemello di `purge.ts` nella forma — un modo in `CAPTURING_MODES`,
// una bozza, un handler binario ⏎/esc — e separato da lui nell'oggetto: la
// task si pota via skill del plugin con commit, la conversazione si rimuove
// dal disco e basta, e una conferma sola per i due bersagli direbbe l'effetto
// di uno mentre esegue l'altro.
//
// La deroga di T104 vale anche qui: l'hook non esce dal deck. La bozza arriva
// da `draftFor`, l'esecuzione parte da `onSubmit`, entrambe in `actions.ts`.
import { useState } from 'react';
import type { Key } from 'ink';
import type { DropDraft, Mode } from '../model.js';

export function useDropOverlay({
  setMode,
  setNote,
  draftFor,
  onSubmit,
}: {
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Compone la bozza, o `null` se non c'è nulla da confermare (lo dice la nota). */
  draftFor: () => DropDraft | null;
  onSubmit: (draft: DropDraft) => void;
}) {
  const [draft, setDraft] = useState<DropDraft | null>(null);

  function open() {
    const next = draftFor();
    if (!next) return;
    setDraft(next);
    setNote('');
    setMode('drop');
  }

  function onKey(_input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setDraft(null);
      setNote('CANC → eliminazione annullata');
    } else if (key.return) {
      const current = draft;
      setMode('normal');
      setDraft(null);
      if (current) onSubmit(current);
    }
  }

  return { draft, open, onKey };
}
