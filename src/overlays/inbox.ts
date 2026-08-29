// T134 — il DETAIL di un file inbox: sesta schermata sostitutiva.
//
// Stessa forma dello `sheet` della task e per la stessa ragione: il file è
// FOTOGRAFATO all'apertura — nome, natura, testo — e non è una vista sulla
// selezione corrente. L'overlay copre la lista, quindi l'oggetto dell'azione
// deve restare quello che si è scelto anche se un tick dello scan spostasse la
// selezione sotto.
//
// Molto più magro dello sheet: nessuna area di compilazione. Lo sheet ha
// quattro righe perché quattro parametri dello spawn sono una scelta (azione,
// prompt, modello, titolo); qui non ce n'è nessuna — la skill la decide la
// natura (D8), il modello è `opus` per tutte e tre (D11 preflight), la sessione
// nasce nuda (D10 preflight). Restano la lettura e un tasto.
//
// Lo spawn NON sta qui: arriva come callback `onDrain`, per lo stesso confine
// di `useSheetOverlay` e `useSearchOverlay` — un hook di overlay non esce dal
// deck.
import { useMemo, useState } from 'react';
import type { Key } from 'ink';
import { inboxDetailCapacity, pageStep } from '../viewport.js';
import { wrapWithOffsets } from '../width.js';
import { parseMarkdown } from '../markdown.js';
import { inboxPrompt, type InboxFile } from '../inbox.js';
import type { Mode } from '../model.js';

export interface InboxSheet {
  file: InboxFile;
  /** `null` = file illeggibile. L'azione resta attiva lo stesso: la skill
   *  risolve il file per nome, non per il testo che il deck ha letto. */
  text: string | null;
}

export interface InboxOverlayDeps {
  rows: number;
  columns: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Apre la sessione presidiata sul file. Il PROMPT viaggia già composto: chi
   *  esegue lo spawn non deve ri-derivarlo dalla natura, o esisterebbero due
   *  copie della mappa natura → skill. */
  onDrain: (file: InboxFile, prompt: string) => void;
}

export function useInboxOverlay(deps: InboxOverlayDeps) {
  const { rows, columns, setMode, setNote, onDrain } = deps;

  const [sheet, setSheet] = useState<InboxSheet | null>(null);
  const [top, setTop] = useState(0);

  // Cornici da scalare: box esterno (2 bordi + 2 padding) + box testo (2 bordi
  // + 2 padding) = 8, come il detail della task.
  const width = Math.max(20, (columns || 80) - 8);
  // Il markdown si rende PRIMA del wrap: `**foo**` occupa 3 colonne rese e 7
  // grezze, quindi wrappare sui marker manderebbe a capo su un conteggio che il
  // terminale non disegna. Memo separato dal wrap perché il parse dipende solo
  // dal testo: un resize ri-wrappa, non ri-parsa.
  const doc = useMemo(() => (sheet?.text ? parseMarkdown(sheet.text) : null), [sheet]);
  const lines = useMemo(() => (doc ? wrapWithOffsets(doc.text, width) : []), [doc, width]);
  const capacity = inboxDetailCapacity(rows);
  const maxTop = Math.max(0, lines.length - capacity);

  /** Il prompt che partirà: derivato una volta e mostrato in fondo alla
   *  schermata, così `⏎` non è mai un salto nel buio. */
  const prompt = sheet ? inboxPrompt(sheet.file) : '';

  function open(next: InboxSheet) {
    setSheet(next);
    setTop(0);
    setNote('');
    setMode('inbox');
  }

  function close() {
    setMode('normal');
    setSheet(null);
  }

  function scroll(delta: number) {
    setTop((t) => Math.max(0, Math.min(maxTop, t + delta)));
  }

  function onKey(input: string, key: Key) {
    if (key.escape) {
      close();
    } else if (key.return) {
      // Si chiude PRIMA di spawnare, come lo sheet della task: la schermata ha
      // finito il suo lavoro, e lasciarla aperta sopra una tab appena nata
      // farebbe credere che ci sia dell'altro da decidere.
      const s = sheet;
      close();
      if (s) onDrain(s.file, inboxPrompt(s.file));
    } else if (key.upArrow) {
      scroll(-1);
    } else if (key.downArrow) {
      scroll(1);
    } else if (key.pageUp) {
      scroll(-pageStep(capacity));
    } else if (key.pageDown) {
      scroll(pageStep(capacity));
    } else if (input === 'g') {
      // `g`/`G` sugli estremi, come reader, detail e project status: anche
      // questa schermata scorre testo, quindi eredita lo stesso alfabeto invece
      // di inventarne un secondo.
      setTop(0);
    } else if (input === 'G') {
      setTop(maxTop);
    }
  }

  return { sheet, doc, lines, top, capacity, maxTop, prompt, open, onKey, scroll };
}
