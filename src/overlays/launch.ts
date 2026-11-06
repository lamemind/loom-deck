// T168 — la PAGINA DELLE VOCI LAUNCH (`^L`) e il motore che le lancia:
// startup, scadenza, esito, guardia, notifica.
//
// Come il project status e l'hard-wrap non è solo un overlay: lo stato che
// tiene — quale voce gira, com'è finita l'ultima — si legge in testata a
// schermata chiusa (🔄 / 🚨, P23), e la pagina è una delle sue superfici. Qui
// vivono anche startup e scadenza, perché è l'unico posto che conosce i record
// di esito: un lancio automatico e uno da tasto passano dalla stessa funzione,
// e un secondo motore in `hooks.ts` divergerebbe al primo attributo aggiunto.
//
// La pagina (P20): due righe per voce, tutte le voci del progetto, non solo
// quelle con esito. `⏎` lancia, `l` apre il log, `tab` scorre gli input della
// voce selezionata, spazio e `←→` alternano, `w` scrive gli attributi nel file
// di progetto (P21). La BOZZA vive in memoria fino a `w`, come nella pagina di
// spawn: il file è committato, e scriverci a ogni tasto sporcherebbe il working
// tree per una prova.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'ink';
import type { ChildProcess } from 'node:child_process';
import { assignDigits, launchEnabled, parseEvery, type LaunchEntry } from '../config.js';
import {
  launchDue,
  launchRunning,
  readLaunchLog,
  runCaptured,
  settleLaunchRecord,
  type LaunchOrigin,
  type LaunchRecord,
} from '../launch-run.js';
import { notifyDone, runLaunch } from '../spawn.js';
import { isAvailable, offNote, refuse } from '../platform.js';
import { launchListCapacity, launchLogCapacity, pageStep } from '../viewport.js';
import { cut, wrapWithOffsets } from '../width.js';
import { fmtTime } from '../glyphs.js';
import type { Mode } from '../model.js';

/**
 * Il tick della scadenza. Trenta secondi e non il poll a 1,5 s del deck: ogni
 * giro costa uno `stat` per voce tracciata, e una scadenza si esprime in minuti.
 * È anche il ritardo massimo con cui si vede finire un giro lanciato da un
 * ALTRO deck; i giri di questo deck arrivano dall'evento `exit`.
 */
export const LAUNCH_TICK_MS = 30_000;

/** Gli input della voce, nell'ordine in cui `tab` li percorre. */
export type LaunchField = 'header' | 'capture' | 'startup' | 'every';
export const LAUNCH_FIELDS: readonly LaunchField[] = ['header', 'capture', 'startup', 'every'];

/** Ciò che la testata mostra (P23): 🚨 vince su 🔄, e il verde non compare. */
export interface LaunchIndicator {
  kind: 'running' | 'red';
  label: string;
  count: number;
}

export interface LaunchPageDeps {
  cwd: string;
  /** Nome del progetto, per le note e per il corpo delle notifiche. */
  name: string;
  /** Le voci VIVE del progetto (`useLaunchConfig`): cifre, startup e scadenza
   *  leggono queste, la pagina lavora su una copia. */
  entries: LaunchEntry[];
  save: (entries: readonly LaunchEntry[]) => void;
  rows: number;
  columns: number;
  hasNote: boolean;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}

/** Una voce ha un record da guardare: ha esito, o una scadenza da misurare. */
function tracked(e: LaunchEntry): boolean {
  return Boolean(e.capture || e.intervalMs);
}

export function useLaunchPage(deps: LaunchPageDeps) {
  const { cwd, name, entries, save, rows, columns, hasNote, setMode, setNote } = deps;
  const available = isAvailable('launch');

  const [records, setRecords] = useState<Map<string, LaunchRecord | null>>(() => new Map());
  const [draft, setDraft] = useState<LaunchEntry[] | null>(null);
  const [sel, setSel] = useState(0);
  const [top, setTop] = useState(0);
  const [field, setField] = useState<LaunchField | null>(null);
  const [dirty, setDirty] = useState(false);
  const [log, setLog] = useState<{ entry: LaunchEntry; text: string } | null>(null);
  const [logTop, setLogTop] = useState(0);

  // I figli di QUESTO deck, per l'evento `exit`; le corse degli altri deck si
  // vedono dal disco, al tick.
  const children = useRef(new Map<string, ChildProcess>());
  // L'exit PRIMA del giro, per la notifica al cambio (P14).
  const prevExit = useRef(new Map<string, number | null>());
  // Lo startup corre una volta per vita del deck, non a ogni ricarica delle
  // voci: dopo `w` l'effect riparte, e un secondo startup rilancerebbe il pull.
  const startedOnce = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const digits = useMemo(() => assignDigits(entries), [entries]);
  const warnedDigits = useRef(false);
  useEffect(() => {
    if (warnedDigits.current || digits.warnings.length === 0) return;
    warnedDigits.current = true;
    setNote(`⚠ ${digits.warnings[0]}`);
  }, [digits, setNote]);

  /** Rilegge da disco i record delle voci tracciate, fondendo gli exit arrivati. */
  const refresh = useCallback((): Map<string, LaunchRecord | null> => {
    const next = new Map<string, LaunchRecord | null>();
    for (const e of entries) {
      if (tracked(e) && e.slug) next.set(e.slug, settleLaunchRecord(cwd, e.slug));
    }
    setRecords(next);
    return next;
  }, [cwd, entries]);

  function notify(entry: LaunchEntry, rec: LaunchRecord, origin: LaunchOrigin) {
    const exit = rec.exit ?? 1;
    const prev = prevExit.current.get(entry.slug ?? '') ?? null;
    // Al primo giro di sempre il solo rosso vale un cambio: un verde dal nulla
    // non è una notizia.
    const changed = prev === null ? exit !== 0 : prev === 0 !== (exit === 0);
    if (origin !== 'tasto' && !changed) return;
    notifyDone(`loom-deck · ${entry.label}`, `${name}: ${exit === 0 ? 'ok' : `fallito (exit ${exit})`}`);
  }

  /**
   * Il lancio, da qualunque origine. Una voce senza esito né scadenza resta il
   * launcher di sempre (`runLaunch`); le altre passano dal record su disco, con
   * la guardia davanti (P4).
   */
  function launch(entry: LaunchEntry, origin: LaunchOrigin, keyLabel: string) {
    if (!launchEnabled(entry)) {
      if (origin === 'tasto') setNote(`${keyLabel} → «${entry.label}» è spenta`);
      return;
    }
    if (refuse('launch', keyLabel, setNote)) return;
    if (!tracked(entry) || !entry.slug) {
      const child = runLaunch(entry, cwd);
      child.on('error', () => setNote(`⚠ ${entry.label}: '${entry.command}' non lanciabile`));
      if (origin === 'tasto') setNote(`${keyLabel} → ${entry.label} su ${name}`);
      return;
    }
    const slug = entry.slug;
    const current = settleLaunchRecord(cwd, slug);
    if (launchRunning(current)) {
      if (origin === 'tasto') {
        setNote(`${keyLabel} → ${entry.label} in corso da ${fmtTime(current!.startedAt)}`);
      }
      return;
    }
    prevExit.current.set(slug, current?.exit ?? null);
    const { child, record } = runCaptured(entry, cwd, origin);
    children.current.set(slug, child);
    setRecords((m) => new Map(m).set(slug, record));
    child.on('error', () => {
      children.current.delete(slug);
      setNote(`⚠ ${entry.label}: bash non lanciabile`);
    });
    child.on('exit', () => {
      children.current.delete(slug);
      if (!alive.current) return;
      const settled = settleLaunchRecord(cwd, slug);
      setRecords((m) => new Map(m).set(slug, settled));
      if (settled && entry.capture) notify(entry, settled, origin);
    });
    if (origin === 'tasto') {
      setNote(`${keyLabel} → ${entry.label} avviato${entry.capture ? ' · ^L per l\'esito' : ''}`);
    }
  }

  // Startup e scadenza. L'effect riparte quando le voci cambiano (dopo `w`):
  // lo startup è protetto da `startedOnce`, il tick ricomincia da zero — che è
  // innocuo, perché la scadenza si legge dal disco e non dal timer.
  useEffect(() => {
    if (!available) {
      if (!startedOnce.current && entries.some((e) => launchEnabled(e) && (e.startup || e.intervalMs))) {
        setNote(offNote('startup/every', 'launch', 'voci launch all\'avvio e a scadenza'));
      }
      startedOnce.current = true;
      return;
    }
    const first = !startedOnce.current;
    startedOnce.current = true;
    refresh();
    if (first) {
      for (const e of entries) if (launchEnabled(e) && e.startup) launch(e, 'startup', 'startup');
    }
    const tick = () => {
      const now = Date.now();
      const recs = refresh();
      for (const e of entries) {
        if (!launchEnabled(e) || !e.intervalMs || !e.slug) continue;
        if (launchDue(recs.get(e.slug) ?? null, e.intervalMs, now)) launch(e, 'every', 'every');
      }
    };
    // Una scadenza già passata al mount scatta adesso, non fra un tick: è il
    // «primo momento utile» di P24.
    tick();
    const id = setInterval(tick, LAUNCH_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, available]);

  // ── La testata ────────────────────────────────────────────────────────────
  const indicator = useMemo<LaunchIndicator | null>(() => {
    const running: LaunchEntry[] = [];
    const red: LaunchEntry[] = [];
    for (const e of entries) {
      if (!e.capture || !e.slug || !launchEnabled(e)) continue;
      const r = records.get(e.slug) ?? null;
      if (launchRunning(r)) running.push(e);
      else if (r && r.exit !== null && r.exit !== 0) red.push(e);
    }
    if (red.length > 0) return { kind: 'red', label: red[0]!.label, count: red.length };
    if (running.length > 0) return { kind: 'running', label: running[0]!.label, count: running.length };
    return null;
  }, [entries, records]);

  // ── La pagina ─────────────────────────────────────────────────────────────
  const open = draft !== null;
  const table = draft ?? entries;
  const capacity = launchListCapacity(rows, hasNote);
  const maxTop = Math.max(0, table.length - capacity);

  function openPage() {
    setDraft(entries.map((e) => ({ ...e })));
    setSel(0);
    setTop(0);
    setField(null);
    setDirty(false);
    setLog(null);
    refresh();
    setNote('');
    setMode('launch');
  }

  function close() {
    setMode('normal');
    setDraft(null);
    setLog(null);
    setField(null);
  }

  function move(delta: number) {
    if (table.length === 0) return;
    const next = Math.max(0, Math.min(table.length - 1, sel + delta));
    setSel(next);
    setTop(Math.max(0, Math.min(next, Math.max(Math.min(top, maxTop), next - capacity + 1))));
  }

  function update(patch: Partial<LaunchEntry>) {
    setDraft((d) => (d ? d.map((e, i) => (i === sel ? { ...e, ...patch } : e)) : d));
    setDirty(true);
  }

  function toggle(f: LaunchField) {
    const e = table[sel];
    if (!e) return;
    if (f === 'header') update({ header: e.header === false });
    else if (f === 'capture') update({ capture: !e.capture });
    else if (f === 'startup') update({ startup: !e.startup });
  }

  function typeEvery(ch: string) {
    const e = table[sel];
    if (!e) return;
    const next = (e.every ?? '') + ch;
    update({ every: next, intervalMs: parseEvery(next) });
  }

  function eraseEvery() {
    const e = table[sel];
    if (!e || !e.every) return;
    const next = e.every.slice(0, -1) || null;
    update({ every: next, intervalMs: next ? parseEvery(next) : null });
  }

  function write() {
    const bad = table.find((e) => e.every && e.intervalMs === null);
    if (bad) {
      setNote(`w → every «${bad.every}» di ${bad.label} non è una durata (30m, 6h, 1d)`);
      return;
    }
    try {
      save(table);
    } catch (e) {
      // Il file non è del deck: se non si parsa il saver rifiuta invece di
      // rigenerarlo. La bozza resta viva per ripremere `w` dopo la riparazione.
      setNote(`⚠ ${cut((e as Error).message, 70)}`);
      return;
    }
    setDirty(false);
    setDraft(null);
    setNote(`w → attributi di ${table.length} voc${table.length === 1 ? 'e' : 'i'} scritti nel file di progetto`);
  }

  function openLog() {
    const e = table[sel];
    if (!e) return;
    if (!e.capture) {
      setNote(`l → «${e.label}» non ha esito: accendi capture`);
      return;
    }
    const text = e.slug ? readLaunchLog(cwd, e.slug) : null;
    if (text === null) {
      setNote(`l → «${e.label}» non è mai partita: nessun log`);
      return;
    }
    setLog({ entry: e, text });
    setLogTop(0);
  }

  // Cornici da scalare, come il viewer del project status: box esterno + box
  // testo = 8 colonne.
  const logWidth = Math.max(20, (columns || 80) - 8);
  const logLines = useMemo(() => (log ? wrapWithOffsets(log.text, logWidth) : []), [log, logWidth]);
  const logCapacity = launchLogCapacity(rows);
  const logMaxTop = Math.max(0, logLines.length - logCapacity);

  function scroll(delta: number) {
    if (!log) return;
    setLogTop((t) => Math.max(0, Math.min(logMaxTop, t + delta)));
  }

  function onKey(input: string, key: Key) {
    if (!open) return;
    if (log) {
      if (key.escape) setLog(null);
      else if (key.upArrow) scroll(-1);
      else if (key.downArrow) scroll(1);
      else if (key.pageUp) scroll(-pageStep(logCapacity));
      else if (key.pageDown) scroll(pageStep(logCapacity));
      else if (input === 'g') setLogTop(0);
      else if (input === 'G') setLogTop(logMaxTop);
      return;
    }
    if (key.escape) {
      if (field !== null) {
        setField(null);
        return;
      }
      if (dirty) setNote('modifiche non salvate perse · w salva prima di uscire');
      close();
      return;
    }
    if (key.return) {
      const e = table[sel];
      if (e) launch(e, 'tasto', '⏎');
      return;
    }
    if (key.tab) {
      // Ciclo null → header → capture → startup → every → null: l'ultimo tab
      // riporta sulla riga, così ↑↓ e ⏎ restano a un gesto di distanza.
      const at = field === null ? -1 : LAUNCH_FIELDS.indexOf(field);
      setField(at + 1 < LAUNCH_FIELDS.length ? LAUNCH_FIELDS[at + 1]! : null);
      return;
    }
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-pageStep(capacity));
    else if (key.pageDown) move(pageStep(capacity));
    else if (key.ctrl) {
      // `^U` svuota la durata, come ogni campo di testo del deck. Le altre combo
      // sono inerti: dentro un modo capturing gli acceleratori non valgono.
      if (input === 'u' && field === 'every') update({ every: null, intervalMs: null });
    } else if (field === 'every' && (key.backspace || key.delete)) eraseEvery();
    else if (field === 'every' && input && /^[0-9mhd]$/.test(input)) typeEvery(input);
    else if (field !== null && field !== 'every' && (input === ' ' || key.leftArrow || key.rightArrow)) toggle(field);
    else if (input === 'l') openLog();
    else if (input === 'w') write();
  }

  /** Il tasto-cifra della riga launch e il click sulla voce: lancia la voce che
   *  ha quella cifra (`assignDigits`), o dice perché non c'è. */
  function runDigit(digit: string) {
    const slot = digits.slots.find((s) => s.digit === digit);
    if (!slot) {
      setNote(`${digit} → nessuna voce launch (${digits.slots.length} in riga)`);
      return;
    }
    launch(slot.entry, 'tasto', digit);
  }

  return {
    open,
    table,
    records,
    slots: digits.slots,
    sel,
    top,
    capacity,
    maxTop,
    field,
    dirty,
    log,
    logLines,
    logTop,
    logCapacity,
    logMaxTop,
    indicator,
    available,
    openPage,
    runDigit,
    onKey,
    scroll,
  };
}
