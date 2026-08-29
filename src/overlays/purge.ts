// T112 — l'overlay di conferma dell'eliminazione (`CANC`).
//
// T131 — è nato dentro `cli.tsx` e ci è rimasto per centosessantacinque righe,
// pur avendo da subito la forma esatta degli altri overlay: un modo dichiarato
// in `CAPTURING_MODES`, uno stato proprio, un handler proprio, un'apertura con
// precondizioni. È la prova che `MODE_KEYS` non basta come custode — quel
// `Record` obbliga un modo nuovo ad avere un handler, non a tenerlo fuori dal
// componente. Il gate che lo pretende è `test/input-wiring.test.ts`.
//
// La deroga di T104 vale anche qui: l'hook non esce dal deck. Costruire la
// bozza e ordinarne l'esecuzione sono due cose diverse — la prima arriva come
// `draftFor`, la seconda parte come `onSubmit`, ed entrambe vivono in
// `actions.ts`. Quello che resta qui è lo stato del modale e i suoi tasti.
import { useState } from 'react';
import type { Key } from 'ink';
import type { Mode, PurgeDraft } from '../model.js';

export function usePurgeOverlay({
  setMode,
  setNote,
  draftFor,
  onSubmit,
}: {
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Compone la bozza, o `null` se non c'è nulla da confermare (lo dice la nota). */
  draftFor: () => PurgeDraft | null;
  onSubmit: (draft: PurgeDraft) => void;
}) {
  // La bozza della conferma (null fuori dal modale).
  const [draft, setDraft] = useState<PurgeDraft | null>(null);

  function open() {
    const next = draftFor();
    if (!next) return;
    setDraft(next);
    setNote('');
    setMode('purge');
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
    } else if ((key.leftArrow || key.rightArrow) && draft?.ignored) {
      setDraft((p) => (p ? { ...p, ignored: p.ignored === 'keep' ? 'purge' : 'keep' } : p));
    }
  }

  return { draft, open, onKey };
}
