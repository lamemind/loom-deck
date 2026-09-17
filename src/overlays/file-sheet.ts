// Il DETAIL di un file: testo scorrevole più la riga che dichiara cosa partirà
// su `⏎`.
//
// T134 nasce come `useInboxOverlay`, un hook per la sola coda inbox. T160/P11 lo
// rende PARAMETRICO su cosa sta guardando, e lo instanzia due volte: una per il
// file inbox, una per il bersaglio doc (file o cartella). Le due istanze restano
// due voci distinte nei tre cataloghi dei modi (`CAPTURING_MODES`,
// `SCROLLING_MODES`, `MODAL_HEIGHT`), perché sono due schermate diverse anche se
// condividono la meccanica: `esc` da una torna al pane inbox, dall'altra al pane
// doc, e un modo solo per entrambe obbligherebbe a ricordare da dove si era
// entrati.
//
// Cosa è parametrico e cosa no. Parametrico: l'OGGETTO fotografato (`T`), il
// testo, il prompt e la callback. Non parametrico: lo scorrimento, la capienza,
// la chiusura prima dello spawn — cioè tutto ciò che è la meccanica dello sheet,
// ed è la parte che non aveva senso duplicare.
//
// L'oggetto è FOTOGRAFATO all'apertura e non è una vista sulla selezione
// corrente: l'overlay copre la lista, quindi il bersaglio dell'azione deve
// restare quello che si è scelto anche se un tick dello scan spostasse la
// selezione sotto.
//
// Lo spawn NON sta qui: arriva come callback, per lo stesso confine di
// `useSheetOverlay` e `useSearchOverlay` — un hook di overlay non esce dal deck.
import { useMemo, useState } from 'react';
import type { Key } from 'ink';
import { fileSheetCapacity, pageStep } from '../viewport.js';
import { wrapWithOffsets } from '../width.js';
import { parseMarkdown } from '../markdown.js';
import type { Mode } from '../model.js';

/** I due modi che questo hook può occupare. Un'unione chiusa e non `Mode`
 *  intero: instanziarlo su `search` o `edit` non avrebbe senso, e il tipo lo
 *  vieta invece di lasciarlo alla disciplina del chiamante. */
export type FileSheetMode = 'inbox' | 'doc';

export interface FileSheet<T> {
  /** L'oggetto su cui si è premuto `⏎`, fotografato. */
  item: T;
  /** Il testo da scorrere; `null` = non leggibile. L'azione resta attiva lo
   *  stesso: la skill risolve il bersaglio per nome, non per il testo che il
   *  deck è riuscito a leggere. */
  text: string | null;
  /** Il comando che partirà su `⏎`, già composto dal chiamante. Stringa VUOTA =
   *  nessuna azione su questo bersaglio, e `hint` dice perché. */
  prompt: string;
  /** Il testo della riga azione quando `prompt` è vuoto. Una riga muta si
   *  leggerebbe come un comando che non si è riusciti a comporre. */
  hint?: string;
}

export interface FileSheetDeps<T> {
  mode: FileSheetMode;
  rows: number;
  columns: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /**
   * Apre la sessione sul bersaglio. Il PROMPT viaggia già composto: chi esegue
   * lo spawn non deve ri-derivarlo, o esisterebbero due copie della regola che
   * decide quale skill parte.
   *
   * Non viene chiamata su `prompt` vuoto: lì `⏎` è inerte e lo dice.
   */
  onEnter: (item: T, prompt: string) => void;
}

export function useFileSheet<T>(deps: FileSheetDeps<T>) {
  const { mode, rows, columns, setMode, setNote, onEnter } = deps;

  const [sheet, setSheet] = useState<FileSheet<T> | null>(null);
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
  const capacity = fileSheetCapacity(rows);
  const maxTop = Math.max(0, lines.length - capacity);

  const prompt = sheet?.prompt ?? '';
  const hint = sheet?.hint ?? '';

  function open(next: FileSheet<T>) {
    setSheet(next);
    setTop(0);
    setNote('');
    setMode(mode);
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
      if (s && !s.prompt) {
        // Bersaglio senza azione: la schermata resta aperta e lo dice. Chiuderla
        // senza fare niente sarebbe indistinguibile da uno spawn riuscito.
        setNote(s.hint || '⏎ → nessuna azione su questo bersaglio');
        return;
      }
      close();
      if (s) onEnter(s.item, s.prompt);
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

  return { sheet, doc, lines, top, capacity, maxTop, prompt, hint, open, onKey, scroll };
}
