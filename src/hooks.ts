// Fase ACQUISIZIONE DATI: i cinque hook che portano dentro il componente ciò
// che sta fuori — dimensioni del terminale, tasks.md, sessioni del progetto,
// task archiviabili, task file selezionato. Ognuno possiede la propria cadenza
// di refresh e non sa nulla della vista che li consuma.
import { useState, useEffect, useRef } from 'react';
import { useStdout } from 'ink';
import { statSync } from 'node:fs';
import { loadTasks, loadTaskDetail, type Task, type TaskDetail } from './tasks.js';
import { discoverProjectSessions, type Session } from './sessions.js';
import { discoverLiveSessions, liveSig, type LiveSession } from './live-sessions.js';
import { loadSessionIndex, type SessionIndex } from './task-index.js';
import { archivableIds, SCAN_INTERVAL_MS } from './archivable.js';
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
