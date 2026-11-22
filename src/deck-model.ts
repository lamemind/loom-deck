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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadArchivableDays, loadIdentity, type LaunchEntry } from './config.js';
import {
  useArchivable,
  useCommitTimes,
  useDirtyFolders,
  useEpicHierarchy,
  useSessions,
  useTaskDetail,
  useTasks,
} from './hooks.js';
import { aliveIds, restoreSet } from './live-marks.js';
import { isDone } from './layout.js';
import { TASK_EMPTY, modelAlias, relTime } from './glyphs.js';
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
import {
  applyView,
  epicRollup,
  isVisible,
  mandateRollup,
  taskColumns,
  type TaskRowData,
  type ViewState,
} from './view.js';
import { loadView } from './view-store.js';
import { termWidth } from './width.js';
import { MODELS, MODEL_DEFAULT, type ModelKind } from './spawn-catalog.js';
import type { TaskLive } from './live-sessions.js';
import type { Session } from './sessions.js';
import { projectBaseName } from './project-path.js';

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
  headless: ReadonlyMap<string, unknown> = new Map(),
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
    // T206 — un turno headless in corso conta fra le vive del contatore
    // (`(vive/totali`): la domanda della colonna è «qui sta succedendo qualcosa
    // adesso?», e un `claude -p` che lavora sulla task è proprio quello. Non
    // tocca `status`, che è lo stato di una TAB; la riga lo sa da `tabs`.
    if (!entry && !headless.has(s.sessionId)) continue;
    const prev = taskLive.get(bound);
    // Rollup a stato misto: vince `busy`. Fra N vive, quella che sta lavorando è
    // la ragione per cui si guarda la riga.
    taskLive.set(bound, {
      count: (prev?.count ?? 0) + 1,
      status: prev?.status === 'busy' || entry?.status === 'busy' ? 'busy' : 'idle',
      tabs: (prev?.tabs ?? 0) + (entry ? 1 : 0),
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
 * binding. `sessions` è già nell'ordine di `compareSessions` → l'ordine si eredita in tutti e tre i rami.
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
  bareModel: bareModelDefault,
  launch,
  setNote,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  /** T161 — il modello con cui il selettore della sessione nuda APRE, dalla riga
   *  `bare` del catalogo delle azioni. Vale al mount e basta (P4 preflight): la
   *  pagina configura il valore iniziale dei selettori vivi, non li vincola, e
   *  un valore che si riallineasse a metà sessione sposterebbe il bottone sotto
   *  le dita di chi l'ha appena ciclato con `m`. */
  bareModel: ModelKind;
  /** T168 — le voci launch del progetto arrivano da `useLaunchConfig`
   *  (`cli.tsx`), non da una lettura qui: la pagina `^L` le riscrive, e la riga
   *  launch deve vedere subito quello che il file dice. */
  launch: LaunchEntry[];
  setNote: (s: string) => void;
}) {
  const { tasks, loadError } = useTasks(tasksPath);
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
  // T162 — sta SOPRA `useSessions` perché ora è anche un suo ingresso: il deck
  // scrive nel sidecar il residuo del titolo, e quel residuo si ottiene
  // togliendo questo stesso core (§Riempimento dei buchi in `hooks.ts`).
  const projectCore = identity ? identity.name : null;
  // T175 — `projectBaseName` e non uno split su `/`: su Windows restituiva il
  // path intero.
  const projectName = projectBaseName(cwd);
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
    priority: sessionPriority,
    live,
    headless,
    liveMarks,
    restoring,
    holdLive,
    reload: reloadSessions,
  } = useSessions(cwd, projectCore);

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
  // T148/P8 — il modello con cui la riga selezionata riprenderà (resume/fork).
  // UN SOLO valore, non una mappa sessionId → scelta: si ri-inizializza a ogni
  // cambio di riga (l'effect qui sotto, keyed su `selSessionId`), quindi
  // tornare su una riga già visitata NON ricorda la scelta fatta lì — è lo
  // stesso costo che T108 ha già accettato per il selettore del detail.
  const [resumeModel, setResumeModel] = useState<ModelKind>(MODEL_DEFAULT);
  // T154 — il modello con cui la sessione NUDA (`c`) apre. Stato PROPRIO,
  // indipendente da `resumeModel`: non segue nessuna riga selezionata (`c` non
  // ha una riga, è un'azione sulla surface del cappello) e quindi non si
  // azzera mai — resta quello scelto finché non si sceglie altro, per tutta la
  // vita del deck.
  const [bareModel, setBareModel] = useState<ModelKind>(bareModelDefault);
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

  // T136 — data dell'ultimo commit di ogni task file, per la chiave `commit`
  // della chain di sort.
  const commitAt = useCommitTimes(tasksDir, cwd);
  // T67 — cappello/figlie (`**Parent Task**`, `Size: Epic`) per il grouping
  // gerarchico del Tasks pane, sullo stesso poll di `commitAt`.
  const epicHierarchy = useEpicHierarchy(tasksDir);
  // T67/P9 — rollup {chiuse/totali} di ogni cappello: sulla lista GREZZA come
  // `doneSig` più sotto, cieco a filtri e viste — altrimenti il numero
  // cambierebbe filtrando senza che nessuna figlia sia davvero comparsa o
  // sparita.
  const epicRollupMap = useMemo(
    () => epicRollup(tasks, epicHierarchy.epicOf),
    [tasks, epicHierarchy],
  );
  // T212/P1 — gemello del precedente per i mandati: membri di `## Membri` con
  // una riga in `tasks.md`, sulla lista GREZZA per la stessa ragione.
  const mandateRollupMap = useMemo(
    () => mandateRollup(tasks, epicHierarchy.membersOf),
    [tasks, epicHierarchy],
  );

  // La vista è una trasformazione DERIVATA, applicata a valle del load: il
  // polling di tasks.md continua a funzionare senza saperne nulla.
  const {
    visible: viewTasks,
    hidden: hiddenTasks,
    blockMark: viewBlockMark,
  } = useMemo(
    () =>
      applyView(tasks, view, {
        commitAt,
        epicOf: epicHierarchy.epicOf,
        epics: epicHierarchy.epics,
      }),
    [tasks, view, commitAt, epicHierarchy],
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
  // T67 — la vista `tasks` riusa `viewTasks`/`viewBlockMark` già calcolati
  // sopra (nessun ricalcolo sul cammino di default); le altre due passano da
  // `selectTasks`, che raggruppa con lo STESSO livello gerarchico (un sito
  // solo per il sort, come già per la sola chain prima di T67).
  const { paneTasks, paneBlockMark } = useMemo(() => {
    if (taskViewId === 'tasks') return { paneTasks: viewTasks, paneBlockMark: viewBlockMark };
    const selected = selectTasks(tasks, taskViewId, {
      view,
      archivable,
      commitAt,
      epicOf: epicHierarchy.epicOf,
      epics: epicHierarchy.epics,
    });
    return { paneTasks: selected.tasks, paneBlockMark: selected.blockMark };
  }, [taskViewId, viewTasks, viewBlockMark, tasks, view, archivable, commitAt, epicHierarchy]);

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

  const { childCount, taskLive, spotCount } = rollupChildren(sessions, bindings, live, headless);
  const taskRowData: TaskRowData = {
    childCount,
    live: taskLive,
    dirty: dirtyFolders,
    epics: epicHierarchy.epics,
    epicRollup: epicRollupMap,
    mandates: epicHierarchy.mandates,
    mandateRollup: mandateRollupMap,
  };

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
  // T133 — lista unica: le figlie del parent, ordine di `compareSessions`, cap su tutte. Le
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
  // T206/P5 — la vista «vive» risponde a «cosa gira adesso»: un turno headless
  // in corso ci sta, col suo glifo. Un predicato solo per contatore e righe.
  const isRunning = useCallback((id: string) => live.has(id) || headless.has(id), [live, headless]);
  const liveCount = useMemo(
    () => assembled.rows.filter((r) => isRunning(r.sessionId)).length,
    [assembled, isRunning],
  );
  // T181 — le conversazioni che il bottone di restore riapre, nell'ordine di
  // riapertura. L'insieme vivo è lo stesso incrocio `live ∩ sessions` che la
  // convergenza usa per scrivere la marca (`aliveIds`): due definizioni
  // diverse farebbero comparire il bottone accanto a una conversazione che per
  // la marca è viva, o il contrario.
  const restorable = useMemo(
    () => restoreSet({ marked: liveMarks, sessions, alive: aliveIds(live, sessions), restoring, headless }),
    [liveMarks, sessions, live, restoring, headless],
  );
  const sessionCounts: SessionViewCounts = {
    total: assembled.contextTotal,
    live: liveCount,
    pinned: assembled.pinnedRows.length,
    older: assembled.overflowRows.length,
  };
  // T100 — le righe a schermo sono quelle della vista attiva.
  const sessionRows = useMemo(
    () => selectSessionRows(sessionViewId, { assembled, isLive: isRunning }),
    [sessionViewId, assembled, isRunning],
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
  // T148/P8 — reset del selettore modello all'evento «la riga selezionata è
  // cambiata». Il selettore del detail (T108) si azzera all'APERTURA
  // dell'overlay; questo blocco non apre e non chiude mai, quindi il suo
  // evento equivalente è il cambio di `selSessionId`. Keyed SOLO su quello (non
  // su `selSessionObj`, che cambia identità a ogni poll delle sessioni anche
  // quando la riga selezionata resta la stessa): un'altra dipendenza
  // resetterebbe la scelta dell'utente sotto un timer invece che sotto un
  // movimento del cursore.
  useEffect(() => {
    setResumeModel(modelAlias(selSessionObj?.model ?? '') ?? MODEL_DEFAULT);
  }, [selSessionId]);

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

  /** T148 — `m` scorre il selettore modello della riga sessione selezionata al
   *  valore SUCCESSIVO del catalogo (ciclico), gemella di `cycleView` ma su un
   *  asse diverso: qui non c'è una vista da cambiare, solo un valore da far
   *  avanzare. Il guard (nessuna sessione, focus altrove) sta nell'attuatore
   *  `actions.ts`, come per `f`/`p`: qui c'è solo la meccanica dello stato.
   *  T154/P2 — ritorna il valore NUOVO: il chiamante lo scrive nella nota di
   *  conferma prima che il render con lo stato aggiornato arrivi. */
  function cycleResumeModel(): ModelKind {
    const next = MODELS[(MODELS.indexOf(resumeModel) + 1) % MODELS.length]!;
    setResumeModel(next);
    return next;
  }

  /** T154 — gemella di `cycleResumeModel`, sullo stato della sessione NUDA:
   *  `m` ci finisce quando il focus non è su una riga sessione vera (P2, D4/D5
   *  degli AC). Nessun guard qui: il bersaglio non è mai inerte — il selettore
   *  che governa è sempre a schermo sulla riga launch. */
  function cycleBareModel(): ModelKind {
    const next = MODELS[(MODELS.indexOf(bareModel) + 1) % MODELS.length]!;
    setBareModel(next);
    return next;
  }

  /**
   * T169/P7 — il salto dal finder: la task `id` selezionata nel pane task e il
   * fuoco sul pane conversazioni, dove `⏎` apre una conversazione come sempre.
   *
   * Un mutatore solo, e non `selectTaskView` più `setSel` dal chiamante:
   * `selectTaskView` azzera la selezione su `≡ tutte`, e il cambio di vista, la
   * selezione e il fuoco devono arrivare nello STESSO handler — è il batch di
   * React a far sì che il render dopo trovi la task già nella vista nuova,
   * invece dell'effect di validità che la farebbe cadere sulla prima riga.
   *
   * La vista resta quella attiva se la task ci sta; altrimenti passa a quella
   * che la contiene, e `Tasks` e `nascoste` sono complementari esatte
   * (`isVisible` e il suo contrario), quindi una delle due la contiene sempre.
   * I filtri non si toccano: il salto mostra la task, non riscrive la vista
   * salvata.
   *
   * La vista del pane conversazioni torna a quella del parent (`context`): le
   * altre mostrano un sottoinsieme (`vive`, `+più vecchie`) o un insieme di
   * tutt'altro parent (`📌`, le pinnate dell'intero progetto), e il salto esiste
   * per vedere le conversazioni di QUELLA task.
   */
  function jumpToTask(id: string) {
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      setNote(`→ ${id}: non è più in tasks.md`);
      return;
    }
    const parts = [`→ ${id}`];
    if (!paneTasks.some((t) => t.id === id)) {
      const target: TaskViewId = isVisible(task, view) ? 'tasks' : 'hidden';
      setTaskViewId(target);
      parts.push(`vista ${taskView(target).label(taskCounts)}`);
    }
    if (sessionViewId !== 'context') {
      setSessionViewId('context');
      setSelSessionId(null);
    }
    setSel(id);
    setFocus('sessions');
    setNote(`${parts.join(' · ')} · conversazioni`);
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
    sessionPriority,
    live,
    headless,
    reloadSessions,
    detail,
    // T181 — restore delle conversazioni dell'ultimo insieme vivo
    restorable,
    restoring,
    holdLive,
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
    blockMark: paneBlockMark,
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
    resumeModel,
    cycleResumeModel,
    bareModel,
    cycleBareModel,
    // mutatori di navigazione
    selectTaskRow,
    moveTaskSel,
    selectTaskView,
    selectSessionView,
    cycleView,
    jumpToTask,
  };
}

export type DeckModel = ReturnType<typeof useDeckModel>;
