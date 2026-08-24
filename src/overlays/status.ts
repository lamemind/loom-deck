// T121 — il PROJECT STATUS del deck: generazione headless, cache su disco,
// indicatore in testata e viewer fullscreen.
//
// Non è solo un overlay come `sheet` o `search`: lo stato che tiene (cosa c'è
// in cache, se una generazione è in corso, com'è andato l'ultimo tentativo) è
// visibile in testata a schermata chiusa. Il viewer è una delle sue superfici,
// non il suo contenuto.
//
// Le due attivazioni sono DISTINTE per costruzione (D2): generare costa minuti
// di sessione Claude, aprire costa una lettura di file — legarle allo stesso
// tasto renderebbe il gesto economico un effetto collaterale di quello caro.
import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'ink';
import { randomUUID } from 'node:crypto';
import { pageStep, statusCapacity } from '../viewport.js';
import { cut, wrapWithOffsets } from '../width.js';
import { parseMarkdown } from '../markdown.js';
import { CLAUDE_CMD, notifyDone, spawnProjectStatus } from '../spawn.js';
import {
  readStatusCache,
  statusFilePath,
  statusLabel,
  writeStatusCache,
  type StatusCache,
} from '../project-status.js';
import type { Mode } from '../model.js';

export interface StatusOverlayDeps {
  cwd: string;
  /** Nome del progetto, per la testata e per il corpo della notifica. */
  name: string;
  rows: number;
  columns: number;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}

/** Il recap FOTOGRAFATO all'apertura del viewer. Non si aggiorna da sé quando
 *  una generazione finisce (D3): sostituire il testo sotto gli occhi vorrebbe
 *  anche riconciliare la posizione di scroll, costo che il caso non giustifica. */
export interface StatusView {
  text: string;
  mtime: number;
  /** Aperto mentre una generazione è in corso: quello che si legge è la
   *  versione precedente, e il viewer deve dirlo. */
  stale: boolean;
}

export function useProjectStatus(deps: StatusOverlayDeps) {
  const { cwd, name, rows, columns, setMode, setNote } = deps;

  const path = useMemo(() => statusFilePath(cwd), [cwd]);
  // Letta al mount e basta: è ciò che fa ripartire un deck riaperto dall'ora di
  // prima invece che da `missing`.
  const [cache, setCache] = useState<StatusCache | null>(() => readStatusCache(path));
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<StatusView | null>(null);
  const [top, setTop] = useState(0);

  // Il contatore dei secondi ha un tick PROPRIO, acceso solo mentre serve. Il
  // poll del deck è a 1500ms: appeso a quello l'elapsed avanzerebbe a scatti
  // irregolari. Un intervallo permanente, all'opposto, ridisegnerebbe il deck
  // ogni secondo per sempre — costo invisibile in sviluppo, non su una macchina
  // carica.
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const label = statusLabel({ mtime: cache?.mtime ?? null, startedAt, now, failed });

  function finish(ok: boolean, detail: string) {
    setStartedAt(null);
    const text = detail.trim();
    if (!ok || !text) {
      // Nessuna riscrittura della cache: il recap precedente resta leggibile e
      // `^O` continua ad aprirlo. Il marker in testata è l'unica traccia che
      // sopravvive alla riga di stato, che sparisce al primo tasto premuto.
      setFailed(true);
      setNote(`⚠ project status fallito · ${cut(detail || `${CLAUDE_CMD} -p`, 56)}`);
      notifyDone('loom-deck · project status', `${name}: generazione fallita`);
      return;
    }
    try {
      writeStatusCache(path, text);
    } catch (e) {
      setFailed(true);
      setNote(`⚠ project status: cache non scrivibile (${(e as Error).message})`);
      notifyDone('loom-deck · project status', `${name}: cache non scrivibile`);
      return;
    }
    // Ri-letta da disco invece di comporre `{text, mtime: Date.now()}`: l'ora
    // che l'indicatore mostra deve essere quella del file, o testata e viewer
    // finirebbero a dire due orari diversi dello stesso recap.
    setCache(readStatusCache(path));
    setFailed(false);
    setNote('✔ project status aggiornato · ^O per aprirlo');
    notifyDone('loom-deck · project status', `${name}: recap pronto`);
  }

  function generate() {
    if (startedAt !== null) {
      setNote(`^G → generazione già in corso (${label})`);
      return;
    }
    const sid = randomUUID();
    setFailed(false);
    setStartedAt(Date.now());
    setNote(`⏳ project status di ${name}… (sid ${sid.slice(0, 8)})`);
    const child = spawnProjectStatus(cwd, sid, finish);
    child.on('error', () => {
      setStartedAt(null);
      setFailed(true);
      setNote(`⚠ project status: '${CLAUDE_CMD}' non lanciabile`);
    });
  }

  function open() {
    if (!cache) {
      // Un viewer vuoto direbbe «il recap è questo, ed è nulla»: la cache
      // assente è uno stato del progetto, non un documento da mostrare.
      setNote(
        startedAt !== null
          ? '^O → nessun recap in cache · la prima generazione è in corso'
          : '^O → nessun recap in cache · ^G per generarlo',
      );
      return;
    }
    setView({ text: cache.text, mtime: cache.mtime, stale: startedAt !== null });
    setTop(0);
    setNote('');
    setMode('status');
  }

  function close() {
    setMode('normal');
    setView(null);
  }

  // Cornici da scalare: box esterno (2 bordi + 2 padding) + box testo (2 bordi
  // + 2 padding) = 8, come il detail.
  const width = Math.max(20, (columns || 80) - 8);
  // Il markdown si rende PRIMA del wrap: `**foo**` occupa 3 colonne rese e 7
  // grezze, quindi wrappare sui marker manderebbe a capo su un conteggio che il
  // terminale non disegna.
  const doc = useMemo(() => (view ? parseMarkdown(view.text) : null), [view]);
  const lines = useMemo(() => (doc ? wrapWithOffsets(doc.text, width) : []), [doc, width]);
  const capacity = statusCapacity(rows);
  const maxTop = Math.max(0, lines.length - capacity);

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
      // `g`/`G` sugli estremi, come nel reader e nel detail: anche questa
      // schermata scorre testo grezzo, quindi eredita lo stesso alfabeto invece
      // di inventarne un secondo.
      setTop(0);
    } else if (input === 'G') {
      setTop(maxTop);
    }
  }

  return {
    label,
    building: startedAt !== null,
    failed,
    view,
    doc,
    lines,
    top,
    capacity,
    maxTop,
    generate,
    open,
    onKey,
    scroll,
  };
}
