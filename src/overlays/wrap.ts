// T134 — la lista hard-wrap: settima schermata sostitutiva, apri-e-chiudi.
//
// Non è un pane e non è un catalogo: è un elenco di sola LETTURA più un campo
// che nomina il perimetro dello srotolamento. Nessuna selezione di riga, e non
// è una mancanza — l'azione non ha per oggetto un file ma un PATH, che può
// essere una cartella intera; una selezione prometterebbe un'azione per riga
// che non esiste. Da qui anche la rotella, che qui scorre il testo perché non
// c'è nessuna selezione da muovere (D5 di T21 vale al contrario).
//
// Lo spawn NON sta qui: arriva come callback `onApply`, per lo stesso confine
// degli altri overlay.
import { useState } from 'react';
import type { Key } from 'ink';
import { useWrapScan } from '../hooks.js';
import { pageStep, wrapListCapacity } from '../viewport.js';
import { cpLen, insertAt, removeAt } from '../layout.js';
import { sanitizeTyped } from '../glyphs.js';
import { WRAP_DEFAULT_PATH, wrapPrompt, type WrapFile } from '../wrap-scan.js';
import type { Mode } from '../model.js';

export interface WrapOverlayDeps {
  cwd: string;
  rows: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
  /** Apre la sessione sonnet che srotola il path. Il PROMPT viaggia già
   *  composto: chi esegue lo spawn non deve conoscere il testo cablato. */
  onApply: (path: string, prompt: string) => void;
}

export function useWrapOverlay(deps: WrapOverlayDeps) {
  const { cwd, rows, setMode, setNote, onApply } = deps;

  // Lo stato dello scan vive QUI e non nel modello, sul precedente di
  // `useProjectStatus`: non è solo il contenuto di una schermata — i suoi
  // numeri si leggono in testata a schermata chiusa, e la lista è una delle sue
  // superfici invece che il suo contenuto. Tenerli in due posti significherebbe
  // che l'indicatore e la lista possono dire cose diverse dello stesso scan.
  const measure = useWrapScan(cwd);

  /** Le righe FOTOGRAFATE all'apertura: uno scan che finisse mentre la lista è
   *  a schermo la riscriverebbe sotto gli occhi, e la posizione di scroll non
   *  avrebbe più un riferimento. Stessa regola del viewer del project status. */
  const [files, setFiles] = useState<WrapFile[] | null>(null);
  const [top, setTop] = useState(0);
  const [path, setPath] = useState(WRAP_DEFAULT_PATH);
  const [caret, setCaret] = useState(cpLen(WRAP_DEFAULT_PATH));

  const capacity = wrapListCapacity(rows);
  const maxTop = Math.max(0, (files?.length ?? 0) - capacity);

  /**
   * Apre la lista, o dichiara perché non si apre.
   *
   * Rifiuta di aprirsi su una lista vuota, e i due modi di esserlo si dicono
   * distinti: «non ho ancora misurato» e «ho misurato e non c'è niente» sono
   * due stati del progetto diversi, e una schermata vuota li confonderebbe in
   * uno solo. È la stessa forma di `^O` senza cache.
   */
  function open() {
    if (measure.files.length === 0) {
      setNote(
        measure.mtime === null
          ? '^W → hard-wrap non ancora misurato · ^E per lo scan'
          : '^W → nessun file con l\'a-capo rientrato: niente da srotolare',
      );
      return;
    }
    setFiles([...measure.files]);
    setTop(0);
    setPath(WRAP_DEFAULT_PATH);
    setCaret(cpLen(WRAP_DEFAULT_PATH));
    setNote('');
    setMode('wrap');
  }

  function close() {
    setMode('normal');
    setFiles(null);
  }

  function scroll(delta: number) {
    setTop((t) => Math.max(0, Math.min(maxTop, t + delta)));
  }

  function onKey(input: string, key: Key) {
    if (key.escape) {
      close();
      return;
    }
    if (key.return) {
      const target = path.trim() || WRAP_DEFAULT_PATH;
      close();
      onApply(target, wrapPrompt(target));
      return;
    }
    if (key.upArrow) {
      scroll(-1);
    } else if (key.downArrow) {
      scroll(1);
    } else if (key.pageUp) {
      scroll(-pageStep(capacity));
    } else if (key.pageDown) {
      scroll(pageStep(capacity));
    } else if (key.leftArrow || key.rightArrow) {
      const d = key.leftArrow ? -1 : 1;
      setCaret((c) => Math.max(0, Math.min(cpLen(path), c + d)));
    } else if (key.backspace || key.delete) {
      if (caret > 0) {
        setPath((p) => removeAt(p, caret - 1));
        setCaret((c) => c - 1);
      }
    } else if (key.ctrl) {
      // `^U` svuota, come il campo di ricerca e il filtro dell'assegnazione.
      // Ogni altra combo è no-op: dentro un modo capturing gli acceleratori
      // globali restano inerti.
      if (input === 'u') {
        setPath('');
        setCaret(0);
      }
    } else if (input && !key.meta) {
      // `↑↓` sono già state consumate sopra: qui arrivano solo i caratteri, che
      // vanno nel campo. Il testo si sanifica al confine come ogni altro campo
      // del deck — un incollaggio porta byte di controllo che Ink conterebbe
      // nella larghezza della riga.
      const ins = sanitizeTyped(input);
      setPath((p) => insertAt(p, caret, ins));
      setCaret((c) => c + cpLen(ins));
    }
  }

  /** Lo scan a richiesta, con la nota che dice cosa sta succedendo: cammina
   *  l'albero del progetto intero, quindi dura, e un tasto che non desse segno
   *  si leggerebbe come inerte. */
  function scan() {
    if (measure.scanning) {
      setNote('^E → scan hard-wrap già in corso');
      return;
    }
    setNote('⏳ scan hard-wrap sul progetto intero…');
    measure.scan();
  }

  return {
    files,
    top,
    capacity,
    maxTop,
    path,
    caret,
    count: measure.count,
    mixed: measure.mixed,
    mtime: measure.mtime,
    ok: measure.ok,
    scanning: measure.scanning,
    open,
    scan,
    onKey,
    scroll,
  };
}
