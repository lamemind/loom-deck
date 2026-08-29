// Il MODELLO del deck: ciò che si sta guardando e come lo si naviga.
//
// Tiene insieme le fonti (task, conversazioni, archiviabili, dettaglio), lo
// stato di navigazione (focus, selezione dei due pane, vista attiva di ognuno) e
// le derivazioni che la schermata consuma. Non spawna, non scrive su disco, non
// legge la tastiera: chi agisce è `actions.ts`, chi dispaccia è `input.ts`.
//
// T131 — la superficie di ritorno è larga (~35 campi), e va dichiarato invece
// che nascosto. La ragione per cui va bene qui e non altrove è che questo È il
// modello: l'insieme di ciò che la vista consuma, e un modello con trenta campi
// resta tale che sia scritto in un `return` o sparso nel corpo di un
// componente. Quello che non va fatto è passarlo PEZZO PER PEZZO ai
// consumatori — gli attuatori e il dispatch ne ricevono l'oggetto intero, ed è
// la ragione per cui i loro conti di parametri restano leggibili.
import { useEffect, useMemo, useState } from 'react';
import { loadArchivableDays, loadIdentity, loadLaunch } from './config.js';
import {
  useArchivable,
  useDirtyFolders,
  useSessions,
  useTaskDetail,
  useTasks,
} from './hooks.js';
import { isDone } from './layout.js';
import { TASK_EMPTY, relTime } from './glyphs.js';
import {
  assembleSessionList,
  firstSelectableId,
  rowIndexOf,
  selectedSession,
  type SessionRow,
} from './session-list.js';
import {
  cycleSessionView,
  cycleTaskView,
  selectSessionRows,
  selectTasks,
  sessionView,
  taskView,
  type SessionViewCounts,
  type SessionViewId,
  type TaskViewCounts,
  type TaskViewId,
} from './pane-views.js';
import {
  ALL,
  MAX_SESSIONS,
  MAX_SESSIONS_ALL,
  META_ROWS,
  ROW_ALL,
  ROW_SPOT,
  SPOT,
  type Focus,
  type Parent,
} from './model.js';
import { applyView, taskColumns, type TaskRowData, type ViewState } from './view.js';
import { loadView } from './view-store.js';
import { termWidth } from './width.js';
import type { TaskLive } from './live-sessions.js';
import type { Session } from './sessions.js';

/**
 * Conteggio dei figli per task, più il rollup delle VIVE e le conversazioni
 * senza binding.
 *
 * T124 — il rollup delle vive si deriva NELLO STESSO CICLO del conteggio, non
 * da un secondo passaggio sul registry dei processi: quel registry conosce una
 * conversazione PRIMA che abbia scritto il suo primo record di transcript,
 * quindi due derivazioni indipendenti renderebbero producibile `1/0` — una viva
 * senza totale — che non è un caso limite teorico ma la finestra normale fra lo
 * spawn e il primo turno. Intersecando qui, **`vive ≤ totali` è garantito per
 * costruzione**: la conversazione appena nata resta invisibile a entrambi i
 * numeri finché non scrive, e il segnale arriva in ritardo di un turno invece
 * che sbagliato.
 */
export function rollupChildren(
  sessions: Session[],
  bindings: Map<string, string>,
  live: Map<string, { status: 'idle' | 'busy' }>,
): { childCount: Map<string, number>; taskLive: Map<string, TaskLive>; spotCount: number } {
  const childCount = new Map<string, number>();
  const taskLive = new Map<string, TaskLive>();
  let spotCount = 0;
  for (const s of sessions) {
    const bound = bindings.get(s.sessionId);
    if (!bound) {
      spotCount++;
      continue;
    }
    childCount.set(bound, (childCount.get(bound) ?? 0) + 1);
    const entry = live.get(s.sessionId);
    if (!entry) continue;
    const prev = taskLive.get(bound);
    // Rollup a stato misto: vince `busy`. Fra N vive, quella che sta lavorando è
    // la ragione per cui si guarda la riga.
    taskLive.set(bound, {
      count: (prev?.count ?? 0) + 1,
      status: prev?.status === 'busy' || entry.status === 'busy' ? 'busy' : 'idle',
    });
  }
  return { childCount, taskLive, spotCount };
}

/**
 * T60 — larghezze delle colonne fisse della lista sessioni, misurate sulla
 * lista INTERA e non sulla finestra visibile: derivarle dalle sole righe a
 * schermo le farebbe cambiare a ogni scroll, cioè l'opposto di una tabella.
 *
 * La colonna task esiste solo nella vista "tutte" (altrove il binding è lo
 * stesso su ogni riga e sta già nell'header del pane), e `0` la spegne.
 */
export function sessionColumns(
  rows: SessionRow[],
  bindings: Map<string, string>,
  isAll: boolean,
): { task: number; age: number } {
  let task = 0;
  let age = 2;
  for (const r of rows) {
    // T133 D10 — la colonna serve dove l'appartenenza NON è già scritta
    // altrove sullo schermo, cioè nella sola vista "tutte": ogni altra lista
    // contiene le figlie del parent selezionato, che l'header nomina.
    if (isAll) {
      const b = bindings.get(r.sessionId);
      if (b) task = Math.max(task, termWidth(b));
    }
    if (r.kind === 'session') age = Math.max(age, termWidth(relTime(r.session.ts)));
  }
  // La cella vuota deve poter entrare nella colonna, o le righe spot
  // perderebbero il segnaposto e con lui l'allineamento.
  return { task: task > 0 ? Math.max(task, termWidth(TASK_EMPTY)) : 0, age };
}

/**
 * Le conversazioni figlie della selezione: tutte quelle del progetto (`≡
 * tutte`), quelle bound alla task selezionata, oppure (spot) quelle senza
 * binding. `sessions` è già ts desc → l'ordine si eredita in tutti e tre i rami.
 */
export function childSessionsOf(
  sessions: Session[],
  bindings: Map<string, string>,
  selectedTaskId: string | null,
  isAll: boolean,
): Session[] {
  if (isAll) return sessions;
  return sessions.filter((s) => {
    const bound = bindings.get(s.sessionId);
    return selectedTaskId ? bound === selectedTaskId : !bound;
  });
}

export function useDeckModel({
  cwd,
  tasksPath,
  tasksDir,
  setNote,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  setNote: (s: string) => void;
}) {
  const { tasks, loadError } = useTasks(tasksPath);
  // `notes` esce dall'indice come `sessionNotes`: nel deck `note` è già la riga
  // di STATO in fondo al frame (il feedback di un'azione). Due concetti diversi
  // a una lettera di distanza sarebbero una trappola di lettura — e di
  // scrittura, visto che `setNote` compare in quasi ogni ramo.
  const {
    sessions,
    bindings,
    forkOf,
    pinned,
    notes: sessionNotes,
    live,
    reload: reloadSessions,
  } = useSessions(cwd);

  const [focus, setFocus] = useState<Focus>('tasks');
  // T39 — selezione KEYED SU ID, non su indice. Con una vista trasformata
  // (filtro/sort) l'indice non identifica più la stessa task: leggere l'array
  // grezzo per posizione spawnerebbe la task sbagliata, in silenzio.
  // T59 — e le righe meta sono sentinelle, non `null`: gli stati sono tre.
  // D4 — si apre su `≡ tutte`: la vista più ampia in cima, poi si scende verso
  // i sottoinsiemi. La selezione non è persistita (a differenza di `view`, T39),
  // quindi questo atterraggio vale a ogni avvio.
  const [sel, setSel] = useState<Parent>(ALL);
  // T50 — selezione del pane sessioni KEYED SU sessionId (non indice): la lista
  // a due gruppi + separatore è una vista trasformata, un indice grezzo punterebbe
  // alla riga sbagliata dopo un pin o un cambio di contesto (stesso trap T39).
  const [selSessionId, setSelSessionId] = useState<string | null>(null);
  // T39 — vista corrente (filtri + sort). Vive nel modello e non nell'hook dei
  // modali che la editano: è ciò che `applyView` consuma per produrre la lista,
  // è persistita su disco e la rilegge il tasto `w`. È stato del modello che due
  // overlay scrivono, non stato di un overlay.
  const [view, setView] = useState<ViewState>(() => loadView(cwd));
  // T100 — vista attiva di ciascun pane, navigata con `tab`. VOLATILE per
  // decisione (D3 create): non entra in `deck-view.json`, il deck riapre sempre
  // su `Tasks` e su `{parent}`. Il criterio è il rischio di leggere una lista
  // parziale credendola completa — un filtro salvato lo si è scelto, una vista
  // riaperta a freddo si legge come la lista intera.
  const [taskViewId, setTaskViewId] = useState<TaskViewId>('tasks');
  const [sessionViewId, setSessionViewId] = useState<SessionViewId>('context');

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
  // Identità (T37): titolo delle tab terminale spawnate col tasto `t`.
  const identity = useMemo(() => loadIdentity(cwd), [cwd]);
  // T53 — il core che ogni titolo di tab porta, quindi la colonna costante da
  // togliere quando serve spazio. Hoistato perché lo consumano DUE schermate
  // (lista e ricerca): calcolarlo su ogni call site è il modo in cui le due
  // smettono di togliere la stessa cosa.
  // T58 — il core è il solo `name`, non `<emoji> <name>` come la chiave di match
  // di compass: qui non serve entropia (è un taglio cosmetico, non un matcher) e
  // il nome nudo ripulisce anche i titoli storici, scritti quando la formula
  // includeva l'owner.
  const projectCore = identity ? identity.name : null;
  const projectName = cwd.split('/').pop() || cwd;

  // La vista è una trasformazione DERIVATA, applicata a valle del load: il
  // polling di tasks.md continua a funzionare senza saperne nulla.
  const { visible: viewTasks, hidden: hiddenTasks } = useMemo(
    () => applyView(tasks, view),
    [tasks, view],
  );

  // T61 — il conteggio guarda la lista GREZZA, non `viewTasks`: le Done fuori
  // dai filtri della vista restano archiviabili, e un contatore che cambiasse
  // filtrando direbbe qualcosa sulla vista invece che sulla task list.
  const doneSig = useMemo(
    () => tasks.filter((t) => isDone(t.prog)).map((t) => t.id).join(','),
    [tasks],
  );
  const archivableDays = useMemo(() => loadArchivableDays(cwd), [cwd]);
  const archivable = useArchivable(doneSig, tasksDir, cwd, archivableDays);
  // T112 — secondo asse di stato della vista `archiviabili`: quali fra le
  // eliminabili hanno una folder che `git rm` non svuoterebbe. Si misura solo
  // su quelle, non su tutta la lista: fuori da quella vista `CANC` agisce su
  // una task sola e il dato lo ricalcola al momento.
  const archivableSig = useMemo(() => [...archivable].sort().join(','), [archivable]);
  const dirtyFolders = useDirtyFolders(archivableSig, tasksDir, cwd);

  // T100 — le task effettivamente a schermo: la vista principale coincide con
  // `viewTasks` (nessun ricalcolo sul cammino di default), le altre due passano
  // dal predicato del catalogo. I CONTATORI restano misurati sulla vista di
  // default, o navigare cambierebbe i numeri che si sta navigando.
  const taskCounts: TaskViewCounts = {
    filtered: viewTasks.length,
    total: tasks.length,
    hidden: hiddenTasks,
    archivable: archivable.size,
  };
  const paneTasks = useMemo(
    () =>
      taskViewId === 'tasks' ? viewTasks : selectTasks(tasks, taskViewId, { view, archivable }),
    [taskViewId, viewTasks, tasks, view, archivable],
  );

  const isSpot = sel === SPOT;
  const isAll = sel === ALL;
  // T112 — quando `CANC` pota in BLOCCO invece della sola task selezionata.
  //
  // La SELEZIONE batte la vista, non il contrario: con una riga task sotto il
  // caret il tasto tocca quella task e basta, in ogni vista. Il bulk vive solo
  // sulle righe meta della vista `archiviabili`, cioè richiede di essere usciti
  // da ogni riga task — così l'azione di massa non è mai a un tasto di distanza
  // da quella singola, e non si preme guardando una task evidenziata credendo
  // che il bersaglio sia lei.
  //
  // Derivato una volta e letto sia dal ramo di apertura sia dalla legenda: due
  // condizioni scritte due volte direbbero due cose diverse sullo stesso tasto
  // alla prima modifica.
  const purgeBulk = taskViewId === 'archivable' && (isAll || isSpot);
  // Unica fonte della selezione: si legge SEMPRE dalla vista, mai dall'array
  // grezzo — è l'invariante che tiene allineati dettaglio mostrato e spawn.
  const selTask = typeof sel === 'string' ? paneTasks.find((t) => t.id === sel) ?? null : null;
  const selectedTaskId = selTask?.id ?? null;
  const selIndex = selTask ? paneTasks.indexOf(selTask) + META_ROWS : isAll ? ROW_ALL : ROW_SPOT;
  const detail = useTaskDetail(tasksDir, selectedTaskId ?? undefined);
  // Il parent delle conversazioni: l'asse che sceglie il pane task, ortogonale
  // alla vista che sceglie l'header (D2 create).
  const parentLabel = isAll ? 'tutte' : isSpot ? 'spot' : selectedTaskId ?? '—';

  const { childCount, taskLive, spotCount } = rollupChildren(sessions, bindings, live);
  const taskRowData: TaskRowData = { childCount, live: taskLive, dirty: dirtyFolders };

  // T118 — colonne fisse della lista task, misurate su `paneTasks` (la vista
  // attiva INTERA) e non sulla finestra visibile: gemelle di `sessionCols` e
  // per la stessa ragione, che una larghezza derivata dallo schermo si muove a
  // ogni scroll.
  const taskCols = taskColumns(paneTasks, taskRowData);

  // Memoizzato così `sessionRows` resta stabile fra render che non cambiano gli
  // input: l'effect di validità della selezione non rigira a vuoto.
  const childSessions = useMemo(
    () => childSessionsOf(sessions, bindings, selectedTaskId, isAll),
    [sessions, bindings, selectedTaskId, isAll],
  );
  // T133 — lista unica: le figlie del parent, `ts desc`, cap su tutte. Le
  // pinnate del progetto escono a parte (`pinnedRows`), per la sola vista `📌`.
  // Core PURO in session-list.ts (testabile senza Ink).
  const assembled = useMemo(
    () =>
      assembleSessionList(
        childSessions,
        sessions,
        pinned,
        isAll ? MAX_SESSIONS_ALL : MAX_SESSIONS,
      ),
    [childSessions, sessions, pinned, isAll],
  );
  // T62 — contato sulla lista INTERA (stessa ragione delle larghezze di colonna
  // qui sotto): derivarlo dalla finestra visibile lo farebbe cambiare a ogni
  // scroll, cioè un contatore che conta lo schermo invece della lista.
  // T100 — «intera» ora vuol dire la lista della vista di DEFAULT (`assembled`),
  // non quella a schermo: il contatore di una voce del catalogo non può
  // dipendere da quale voce è selezionata, o navigare muoverebbe i numeri.
  const liveCount = useMemo(
    () => assembled.rows.filter((r) => live.has(r.sessionId)).length,
    [assembled, live],
  );
  const sessionCounts: SessionViewCounts = {
    total: assembled.contextTotal,
    live: liveCount,
    pinned: assembled.pinnedRows.length,
    older: assembled.overflowRows.length,
  };
  // T100 — le righe a schermo sono quelle della vista attiva.
  const sessionRows = useMemo(
    () => selectSessionRows(sessionViewId, { assembled, isLive: (id) => live.has(id) }),
    [sessionViewId, assembled, live],
  );
  const selSessionObj = selectedSession(sessionRows, selSessionId);
  const sessionCols = useMemo(
    () => sessionColumns(sessionRows, bindings, isAll),
    [sessionRows, bindings, isAll],
  );

  // T39 — selezione stabile sotto trasformazione. Se la task selezionata esce
  // dalla vista (filtro appena attivato, oppure sparita da tasks.md), si cade
  // sulla prima visibile — fallback deterministico, mai una posizione a caso.
  useEffect(() => {
    if (typeof sel === 'string' && !paneTasks.some((t) => t.id === sel)) {
      setSel(paneTasks[0]?.id ?? ALL);
    }
  }, [paneTasks, sel]);
  // T50 — la selezione (id) resta valida sotto la vista a due gruppi: se l'id
  // non è più una riga selezionabile (cambio parent, lista mutata, pin rimosso,
  // sessione sparita) cade sulla prima riga — fallback deterministico, mai una
  // posizione a caso. Sostituisce il reset-a-0 e il clamp index-based.
  useEffect(() => {
    if (rowIndexOf(sessionRows, selSessionId) < 0) {
      setSelSessionId(firstSelectableId(sessionRows));
    }
  }, [sessionRows, selSessionId]);

  /** Selezione per INDICE nella vista, riconvertita subito in sentinella o id.
   *  T21 — la chiama anche il click su una riga del pane task. */
  function selectTaskRow(index: number) {
    if (index === ROW_ALL) setSel(ALL);
    else if (index === ROW_SPOT) setSel(SPOT);
    else setSel(paneTasks[index - META_ROWS]?.id ?? SPOT);
  }

  // Sposta la selezione di `delta` righe nella VISTA (0 = tutte, 1 = spot,
  // 2..N+1 = task visibili) e la riconverte subito in sentinella o id: l'indice
  // non sopravvive a un cambio di filtro, l'id sì.
  function moveTaskSel(delta: number) {
    selectTaskRow(Math.max(0, Math.min(paneTasks.length + META_ROWS - 1, selIndex + delta)));
  }

  // T21 — per VISTA e non per passo: il click sull'header nomina una voce, e
  // `tab` la raggiunge ciclando. Sulla vista già attiva non si fa niente — un
  // click che azzerasse la selezione alla riga in alto sarebbe un effetto che
  // la tastiera non ha mai avuto, perché `tab` non può restare ferma.
  function selectTaskView(next: TaskViewId) {
    if (next === taskViewId) return;
    setTaskViewId(next);
    setSel(ALL);
    setNote(`vista task: ${taskView(next).label(taskCounts)}`);
  }

  function selectSessionView(next: SessionViewId) {
    if (next === sessionViewId) return;
    setSessionViewId(next);
    setSelSessionId(null);
    setNote(`vista sessioni: ${sessionView(next).label(sessionCounts, parentLabel)}`);
  }

  // T100 — `tab` naviga il catalogo viste del pane in focus. Il reset della
  // selezione è la regola letterale «prima riga in alto», senza eccezioni: sul
  // pane task è `ROW_ALL` (D2 preflight — le righe meta non si saltano, e il
  // parent delle sessioni che torna a `tutte` è un effetto accettato); sul pane
  // sessioni basta invalidare l'id, e l'effect di validità atterra sulla prima
  // riga selezionabile della vista nuova.
  function cycleView(delta: number) {
    if (focus === 'tasks') selectTaskView(cycleTaskView(taskViewId, delta));
    else selectSessionView(cycleSessionView(sessionViewId, delta));
  }

  return {
    // fonti
    tasks,
    loadError,
    sessions,
    bindings,
    forkOf,
    pinned,
    sessionNotes,
    live,
    reloadSessions,
    detail,
    // progetto
    launch,
    identity,
    projectCore,
    projectName,
    // stato di navigazione
    focus,
    setFocus,
    sel,
    selSessionId,
    setSelSessionId,
    view,
    setView,
    taskViewId,
    sessionViewId,
    // derivazioni del pane task
    viewTasks,
    hiddenTasks,
    taskCounts,
    paneTasks,
    isSpot,
    isAll,
    purgeBulk,
    selTask,
    selectedTaskId,
    selIndex,
    parentLabel,
    taskRowData,
    taskCols,
    spotCount,
    // derivazioni del pane sessioni
    sessionRows,
    sessionCounts,
    selSessionObj,
    sessionCols,
    // mutatori di navigazione
    selectTaskRow,
    moveTaskSel,
    selectTaskView,
    selectSessionView,
    cycleView,
  };
}

export type DeckModel = ReturnType<typeof useDeckModel>;
