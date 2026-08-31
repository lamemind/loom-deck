// Fase ACQUISIZIONE DATI: i cinque hook che portano dentro il componente ciò
// che sta fuori — dimensioni del terminale, tasks.md, sessioni del progetto,
// task archiviabili, task file selezionato. Ognuno possiede la propria cadenza
// di refresh e non sa nulla della vista che li consuma.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStdout } from 'ink';
import { statSync } from 'node:fs';
import { loadTasks, loadTaskDetail, type Task, type TaskDetail } from './tasks.js';
import { discoverProjectSessions, type Session } from './sessions.js';
import { discoverLiveSessions, liveSig, type LiveSession } from './live-sessions.js';
import { loadSessionIndex, type SessionIndex } from './task-index.js';
import { archivableIds, SCAN_INTERVAL_MS } from './archivable.js';
import { scanInbox, INBOX_SCAN_INTERVAL_MS, type InboxFile } from './inbox.js';
import {
  mixedCount,
  readWrapCache,
  runWrapScan,
  wrapCacheFile,
  wrapCount,
  type WrapCache,
  type WrapFile,
} from './wrap-scan.js';
import { purgeTargets } from './purge.js';
import { POLL_MS } from './model.js';

// Dimensioni del terminale, live sul resize.
//
// Non è una comodità di layout: senza `rows` il frame non ha tetto, e un frame
// più alto del terminale fa cadere Ink nel ramo `clearTerminal` (ink.js:121)
// che su VTE/Ptyxis riversa ogni redraw nello scrollback.
//
// Il valore iniziale conta quanto il resize: una tab Ptyxis appena aperta parte
// spesso a 24 righe e riceve il SIGWINCH subito dopo. Nella finestra fra i due
// il deck disegnava già a piena altezza — motivo per cui lo scrollback risultava
// sporco fin dall'avvio, prima ancora di toccare un tasto.
export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
    stdout.on('resize', onResize);
    onResize(); // allinea se il resize è arrivato prima del mount
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

// Carica tasks.md e lo ri-legge quando cambia sotto (poll su mtime). Poll
// (non fs.watch) perché i writer di tasks.md — checkpoint-task/create-task —
// riscrivono il file (probabile replace atomico), che rompe il watch sull'inode
// originale; statSync(path) segue sempre il file corrente al path.
export function useTasks(tasksPath: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let lastMtime = -1;
    const reload = () => {
      try {
        const mtime = statSync(tasksPath).mtimeMs;
        if (mtime === lastMtime) return; // invariato → niente re-read
        lastMtime = mtime;
        setTasks(loadTasks(tasksPath));
        setLoadError('');
      } catch {
        lastMtime = -1; // così quando il file riappare viene ri-letto
        setTasks([]);
        setLoadError(`tasks.md non leggibile: ${tasksPath}`);
      }
    };
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [tasksPath]);

  return { tasks, loadError };
}

// Poll delle sessioni del progetto + binding sidecar. discoverProjectSessions
// ha cache mtime-keyed interna → il poll è economico; qui si evita comunque il
// re-render inutile con una signature (sessionId:ts + binding entries): setState
// solo quando cambia davvero qualcosa.
export function useSessions(projectRoot: string) {
  const [state, setState] = useState<{
    sessions: Session[];
    bindings: Map<string, string>;
    forkOf: Map<string, string>;
    pinned: Map<string, number>;
    notes: Map<string, string>;
    live: Map<string, LiveSession>;
  }>({
    sessions: [],
    bindings: new Map(),
    forkOf: new Map(),
    pinned: new Map(),
    notes: new Map(),
    live: new Map(),
  });
  // T50 — pin/unpin scrive il sidecar e vuole feedback IMMEDIATO, non al
  // prossimo tick del poll (1.5s): la reload è esposta via ref così il toggle la
  // richiama senza risottoscrivere l'intervallo.
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let lastSig = '';
    const reload = () => {
      let sessions: Session[];
      let index: SessionIndex;
      try {
        sessions = discoverProjectSessions(projectRoot);
        index = loadSessionIndex(projectRoot);
      } catch {
        sessions = [];
        index = { bindings: new Map(), forkOf: new Map(), pinned: new Map(), notes: new Map() };
      }
      // T62 — le vive stanno sullo STESSO tick delle altre fonti, non su una
      // scala propria come `useArchivable`: `status` cambia a ogni turno, quindi
      // un refresh più lento mostrerebbe `idle` su una sessione che lavora.
      // Il try è separato perché il registry è una fonte indipendente: se manca
      // (versione del CLI che non lo scrive) la lista deve restare, senza vive.
      let live: Map<string, LiveSession>;
      try {
        live = discoverLiveSessions(projectRoot);
      } catch {
        live = new Map();
      }
      const { bindings, forkOf, pinned, notes } = index;
      // La signature copre anche fork, pin e note: un record di lineage, un
      // toggle di pin o una nota appena scritta cambiano la lista renderizzata,
      // quindi devono forzare il re-render come farebbe un binding nuovo.
      const sig =
        sessions.map((s) => `${s.sessionId}:${s.ts}`).join('|') +
        '#' +
        [...bindings.entries()].map(([k, v]) => `${k}=${v}`).sort().join(',') +
        '#' +
        [...forkOf.entries()].map(([k, v]) => `${k}<${v}`).sort().join(',') +
        '#' +
        [...pinned.entries()].map(([k, v]) => `${k}@${v}`).sort().join(',') +
        '#' +
        [...notes.entries()].map(([k, v]) => `${k}"${v}`).sort().join(',') +
        '#' +
        liveSig(live);
      if (sig === lastSig) return;
      lastSig = sig;
      setState({ sessions, bindings, forkOf, pinned, notes, live });
    };
    reloadRef.current = reload;
    reload();
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [projectRoot]);

  return { ...state, reload: () => reloadRef.current() };
}

// T61 — conteggio delle Done oltre soglia, su una scala di refresh TUTTA SUA.
//
// Non è appeso a POLL_MS (1,5s) come tasks.md e le sessioni: l'età di una task
// cambia una volta al giorno, e ogni giro costa la lettura di N task file più
// qualche spawn di git. Due trigger:
//
//   · quando cambia l'INSIEME delle task Done (`doneSig`) — copre l'avvio, dove
//     il primo render ha `tasks` ancora vuoto, e la chiusura di una task, dove
//     il numero deve muoversi senza aspettare ore;
//   · ogni SCAN_INTERVAL_MS — copre il caso opposto, in cui non cambia nulla
//     sul disco ed è il calendario a far scattare una task oltre soglia.
//
// `doneSig` è una stringa, non l'array: `tasks` cambia identità a ogni re-read
// di tasks.md, e usarlo come dipendenza rimetterebbe lo scan sul tick da 1,5s
// per la via di dietro.
//
// T100 — tiene gli ID e non più il conteggio: `archiviabili` è una vista del
// pane, quindi servono le righe. Il contatore dell'header è `.size` dello stesso
// insieme che disegna la lista — un numero e una lista che non possono divergere.
export function useArchivable(doneSig: string, tasksDir: string, projectRoot: string, days: number) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    const done = doneSig ? doneSig.split(',') : [];
    const scan = () => {
      archivableIds(done, { tasksDir, projectRoot, days })
        .then((found) => {
          if (alive) setIds(new Set(found));
        })
        // Scan fallito (task file illeggibili, git muto) → insieme vuoto, cioè
        // voce a 0. Un contatore informativo non merita un errore a schermo.
        .catch(() => {
          if (alive) setIds(new Set());
        });
    };
    scan();
    const id = setInterval(scan, SCAN_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [doneSig, tasksDir, projectRoot, days]);
  return ids;
}

// T112 — quali fra le task passate hanno una folder che `git rm` non
// svuoterebbe (file ignorati o mai tracciati). È il SECONDO asse di stato della
// vista `archiviabili`: eliminabile · dirty.
//
// Non viene dalla fonte della lista. Le righe arrivano da `tasks.md` (poll
// 1,5s), la dirtiness dal filesystem via git su questa cadenza — mount, cambio
// dell'insieme, poi ogni SCAN_INTERVAL_MS, gemella di `useArchivable` e per la
// stessa ragione: una folder non si sporca al ritmo di un poll.
//
// Ne discende che il dato è CAMPIONATO e può essere stale nell'istante in cui
// si preme il tasto — perciò il momento dell'azione lo ricalcola da sé
// (`purgeTargets`), e questo hook serve solo a mostrarlo in lista.
export function useDirtyFolders(idsSig: string, tasksDir: string, projectRoot: string) {
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const ids = idsSig ? idsSig.split(',') : [];
    const scan = () => {
      try {
        const found = purgeTargets(ids, tasksDir, projectRoot)
          .filter((t) => t.survivors > 0)
          .map((t) => t.id);
        setDirty(new Set(found));
      } catch {
        // git muto o task file illeggibili → nessun marker. Il gate del plugin
        // resta la rete: un marker mancante non autorizza niente, fa solo
        // arrivare il rifiuto più tardi.
        setDirty(new Set());
      }
    };
    scan();
    const id = setInterval(scan, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [idsSig, tasksDir, projectRoot]);
  return dirty;
}

/**
 * T134 — la coda inbox, terzo membro della famiglia degli scan periodici
 * (`useArchivable`, `useDirtyFolders`): scan read-only su una scala tutta sua,
 * un contatore sempre a schermo, una funzione che quel contatore abilita.
 *
 * Fuori dal poll da 1,5s come i due gemelli, per la stessa ragione: ogni giro
 * costa uno spawn di `doc-metrics.sh` che a sua volta invoca `inbox.sh parse`
 * una volta per file. Ma su una cadenza PROPRIA e più stretta dei loro 6h
 * (`INBOX_SCAN_INTERVAL_MS`, 30 minuti): la coda si riempie a ogni checkpoint,
 * non una volta al giorno come l'età di una task.
 *
 * A differenza dello scan del wrap (D4) questo PARTE ALL'AVVIO: legge una
 * cartella di pochi file, non cammina l'albero del progetto.
 */
export interface InboxState {
  files: InboxFile[];
  /** L'ultimo tentativo è andato a buon fine. */
  ok: boolean;
  /** Almeno un tentativo è stato fatto: distingue «non l'ho ancora misurato»
   *  da «ho misurato e la coda è vuota», che a schermo sono due cose diverse
   *  (D2 preflight — `missing` non è un guasto, è lo stato di partenza). */
  scanned: boolean;
}

export function useInboxScan(projectRoot: string, docsRoot: string): InboxState {
  const [state, setState] = useState<InboxState>({ files: [], ok: true, scanned: false });
  useEffect(() => {
    let alive = true;
    const scan = () => {
      scanInbox(projectRoot, docsRoot).then((res) => {
        if (!alive) return;
        // Un tentativo fallito NON butta via l'esito dell'ultimo riuscito: la
        // lista precedente resta vera e ancora apribile, e il guasto si dice
        // col glifo di allerta accanto ai contatori. È la stessa regola già
        // scritta per il project status (`finish` non riscrive la cache).
        setState((prev) =>
          res.ok ? { files: res.files, ok: true, scanned: true } : { ...prev, ok: false, scanned: true },
        );
      });
    };
    scan();
    const id = setInterval(scan, INBOX_SCAN_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projectRoot, docsRoot]);
  return state;
}

/**
 * T134 — l'hard-wrap dei `.md`, quarto membro della famiglia degli scan.
 *
 * Due cose lo distinguono dagli altri tre, ed entrambe vengono da D4 preflight.
 *
 * NON PARTE ALL'AVVIO: il perimetro è la project root intera, submodule
 * compresi, e camminare quell'albero si fa pesante su un progetto grosso —
 * pagarlo all'apertura del deck rallenterebbe proprio il momento in cui si
 * vuole vedere qualcosa subito. Al mount si legge la sola cache su disco, che è
 * ciò che fa ripartire un deck riaperto dalla misura di prima invece che da
 * `missing`.
 *
 * LO SCAN A RICHIESTA RESETTA IL TIMER: senza, l'intervallo continuerebbe a
 * scorrere dall'ultimo tick automatico, e uno scan chiesto a mano potrebbe
 * essere seguito pochi minuti dopo da uno automatico che rimisura un dato
 * appena misurato — costo pieno, risultato identico. Il reset passa da `epoch`,
 * che rientra nelle dipendenze dell'effect e quindi ricrea l'intervallo.
 */
export interface WrapState {
  files: WrapFile[];
  /** Solo i `WRAP`: `misto` compare in lista e resta fuori dal contatore (D4). */
  count: number;
  mixed: number;
  /** Ora dell'ultimo scan riuscito; `null` = mai misurato. */
  mtime: number | null;
  ok: boolean;
  scanning: boolean;
  /** Lancia lo scan headless e resetta il timer del periodico. */
  scan: () => void;
}

export function useWrapScan(projectRoot: string): WrapState {
  const path = useMemo(() => wrapCacheFile(projectRoot), [projectRoot]);
  const [cache, setCache] = useState<WrapCache | null>(() => readWrapCache(path));
  const [ok, setOk] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [epoch, setEpoch] = useState(0);
  // Il flag di corsa sta in un ref e non in stato: il ramo che lo legge gira
  // NELLO STESSO tasto in cui potrebbe averlo scritto, e un valore di stato
  // React arriverebbe al render dopo — cioè troppo tardi per impedire il
  // secondo lancio.
  const busy = useRef(false);

  const run = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setScanning(true);
    runWrapScan(projectRoot).then((good) => {
      busy.current = false;
      setScanning(false);
      setOk(good);
      // La cache si rilegge SOLO su successo: un tentativo fallito lascia in
      // piedi l'esito dell'ultimo riuscito, che resta vero e ancora apribile.
      if (good) setCache(readWrapCache(path));
    });
  }, [projectRoot, path]);

  useEffect(() => {
    const id = setInterval(run, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [run, epoch]);

  const scan = useCallback(() => {
    setEpoch((e) => e + 1);
    run();
  }, [run]);

  const files = cache?.files ?? [];
  return {
    files,
    count: wrapCount(files),
    mixed: mixedCount(files),
    mtime: cache?.mtime ?? null,
    ok,
    scanning,
    scan,
  };
}

// Legge il task file della task selezionata (Q1+B T20). On-id-change: navigare
// con ↑↓ ricarica il dettaglio; leggere un singolo file 4-9KB è I/O triviale,
// niente debounce serve per la tastiera. Il refresh del contenuto a file fermo
// (es. checkpoint aggiorna Progress) è demandato al prossimo cambio selezione.
export function useTaskDetail(tasksDir: string, id: string | undefined) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  useEffect(() => {
    setDetail(id ? loadTaskDetail(tasksDir, id) : null);
  }, [tasksDir, id]);
  return detail;
}
