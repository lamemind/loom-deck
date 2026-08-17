#!/usr/bin/env node
import { render, Box, Text, useApp, useInput, type Key } from 'ink';
import { useState, useEffect, useMemo } from 'react';
import { randomUUID } from 'node:crypto';
import {
  resolveTasksPath,
  resolveTasksDir,
  loadTasks,
  loadTaskFileText,
  type Task,
} from './tasks.js';
import {
  rowIndexOfKey,
  selectedRow,
} from './search.js';
import {
  appendNote,
  appendPin,
  appendSessionRecord,
  appendTaskBinding,
} from './task-index.js';
import {
  assembleSessionList,
  firstSelectableId,
  moveSelection,
  neighborId,
  rowIndexOf,
  selectedSession,
  unpinLandingId,
} from './session-list.js';
import {
  cellWidth,
  launchLegend,
  loadArchivableDays,
  loadIdentity,
  loadLaunch,
} from './config.js';
import {
  cycleSessionView,
  cycleTaskView,
  selectSessionRows,
  selectTasks,
  sessionView,
  taskView,
  TASK_VIEWS,
  type SessionViewCounts,
  type SessionViewId,
  type TaskViewCounts,
  type TaskViewId,
} from './pane-views.js';
import {
  isCompact,
  layoutBudget,
  searchPreviewCapacity,
  windowRange,
  type Budget,
  type PreviewKind,
} from './viewport.js';
import { cut, sanitize, termWidth } from './width.js';
import {
  applyView,
  cycleSort,
  describeSort,
  priName,
  progName,
  toggleHidden,
  PRI_ENTRIES,
  PROG_ENTRIES,
  type PriName,
  type ProgName,
  type ViewState,
} from './view.js';
import { initialDetail, writeTaskEdit, PRI_GLYPH, PRI_LABEL } from './task-edit.js';
import {
  ALL,
  EDIT_PRI,
  EDIT_PROG,
  MAX_SESSIONS,
  MAX_SESSIONS_ALL,
  META_ROWS,
  ROW_ALL,
  ROW_SPOT,
  SORT_TASTI,
  SPOT,
  type EditDraft,
  type FilterCursor,
  type Focus,
  type Mode,
  type Parent,
} from './model.js';
import {
  conversationLabel,
  cpLen,
  editField,
  insertAt,
  isDone,
  isTextRow,
  removeAt,
  EDIT_ROWS,
  type EditRow,
} from './layout.js';
import { TASK_EMPTY, relTime, sanitizeTyped } from './glyphs.js';
import {
  commitTaskEdit,
  runLaunch,
  spawnClaudeEmpty,
  spawnCreateTask,
  spawnDeck,
  spawnDeckFork,
  spawnDeckResume,
  spawnTerminal,
  CLAUDE_CMD,
  DECK_RUN,
  type PromptKind,
} from './spawn.js';
import { EditModal, FilterModal, SortModal } from './ui/modals.js';
import { ReaderScreen, SearchScreen } from './ui/search-screen.js';
import { DetailScreen } from './ui/detail-screen.js';
import { AssignScreen } from './ui/assign-screen.js';
import { SessionsPane, TasksPane } from './ui/panes.js';
import { PreviewPane, detailMetaOf } from './ui/preview.js';
import { loadView, saveView, viewFilePath } from './view-store.js';
import { useArchivable, useSessions, useTaskDetail, useTasks, useTerminalSize } from './hooks.js';
import { useSearchOverlay } from './overlays/search.js';
import { useSheetOverlay } from './overlays/sheet.js';
import { useAssignOverlay } from './overlays/assign.js';
import { captures, type CapturingMode } from './input-modes.js';

function Deck({ cwd, tasksPath, tasksDir }: { cwd: string; tasksPath: string; tasksDir: string }) {
  const { exit } = useApp();
  const { tasks, loadError } = useTasks(tasksPath);
  // `notes` esce dall'indice come `sessionNotes`: in questo componente `note` è
  // già la riga di STATO in fondo al frame (il feedback di un'azione). Due
  // concetti diversi a una lettera di distanza sarebbero una trappola di
  // lettura — e di scrittura, visto che `setNote` compare in quasi ogni ramo.
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
  const [note, setNote] = useState('');
  // Modali: catturano i tasti e corto-circuitano la navigazione normale.
  // T30 create · T39 sort/filter.
  const [mode, setMode] = useState<Mode>('normal');
  const [draft, setDraft] = useState('');
  // T53 — bozza della nota sulla conversazione selezionata. Si apre PRECARICATA
  // con la nota esistente: annotare due volte è quasi sempre correggere, non
  // riscrivere da zero, e un campo vuoto costringerebbe a ridigitare tutto per
  // cambiare una parola. Confermare il campo vuoto cancella la nota.
  const [noteDraft, setNoteDraft] = useState('');
  // T39 — vista corrente (filtri + sort) e sua fotografia all'apertura di un
  // modale: la lista si aggiorna dal vivo, quindi `esc` deve poter ripristinare.
  const [view, setView] = useState<ViewState>(() => loadView(cwd));
  const [viewBackup, setViewBackup] = useState<ViewState | null>(null);
  // T100 — vista attiva di ciascun pane, navigata con `tab`. VOLATILE per
  // decisione (D3 create): non entra in `deck-view.json`, il deck riapre sempre
  // su `Tasks` e su `{parent}`. Il criterio è il rischio di leggere una lista
  // parziale credendola completa — un filtro salvato lo si è scelto, una vista
  // riaperta a freddo si legge come la lista intera.
  const [taskViewId, setTaskViewId] = useState<TaskViewId>('tasks');
  const [sessionViewId, setSessionViewId] = useState<SessionViewId>('context');
  const [filterCursor, setFilterCursor] = useState<FilterCursor>({ row: 0, col: 0 });
  // T41 — bozza dell'edit (null fuori dal modale) e riga attiva della griglia.
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [editRow, setEditRow] = useState<EditRow>(0);

  // Dimensioni vive del terminale: sono l'input del budget d'altezza sotto.
  const { rows, columns } = useTerminalSize();

  // Voci launch del progetto (T32): lette una volta, raggiunte per indice 1..9.
  const launch = useMemo(() => loadLaunch(cwd), [cwd]);
  // Identità (T37): titolo delle tab terminale spawnate col tasto `t`.
  const identity = useMemo(() => loadIdentity(cwd), [cwd]);
  // T53 — il core che ogni titolo di tab porta, quindi la colonna costante da
  // togliere quando serve spazio. Hoistato qui perché ora lo consumano DUE
  // schermate (lista e ricerca): calcolarlo su ogni call site è il modo in cui
  // le due smettono di togliere la stessa cosa.
  // T58 — il core è il solo `name`, non `<emoji> <name>` come la chiave di match
  // di compass: qui non serve entropia (è un taglio cosmetico, non un matcher) e
  // il nome nudo ripulisce anche i titoli storici, scritti quando la formula
  // includeva l'owner.
  const projectCore = identity ? identity.name : null;
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
      taskViewId === 'tasks'
        ? viewTasks
        : selectTasks(tasks, taskViewId, { view, archivable }),
    [taskViewId, viewTasks, tasks, view, archivable],
  );

  const isSpot = sel === SPOT;
  const isAll = sel === ALL;
  const projectName = cwd.split('/').pop() || cwd;
  // Unica fonte della selezione: si legge SEMPRE dalla vista, mai dall'array
  // grezzo — è l'invariante che tiene allineati dettaglio mostrato e spawn.
  const selTask = typeof sel === 'string' ? paneTasks.find((t) => t.id === sel) ?? null : null;
  const selectedTaskId = selTask?.id ?? null;
  const selIndex = selTask ? paneTasks.indexOf(selTask) + META_ROWS : isAll ? ROW_ALL : ROW_SPOT;
  const detail = useTaskDetail(tasksDir, selectedTaskId ?? undefined);
  // Il parent delle conversazioni: l'asse che sceglie il pane task, ortogonale
  // alla vista che sceglie l'header (D2 create).
  const parentLabel = isAll ? 'tutte' : isSpot ? 'spot' : selectedTaskId ?? '—';

  // Conteggio figli per task + spot (badge nel Tasks pane).
  const childCount = new Map<string, number>();
  let spotCount = 0;
  for (const s of sessions) {
    const bound = bindings.get(s.sessionId);
    if (bound) childCount.set(bound, (childCount.get(bound) ?? 0) + 1);
    else spotCount++;
  }

  // Figli della selezione: tutte le conversazioni del progetto (`≡ tutte`), le
  // sessioni bound alla task selezionata, oppure (spot) quelle senza binding.
  // sessions è già ts desc → l'ordine si eredita in tutti e tre i rami.
  // Memoizzato così `sessionRows` resta stabile fra render che non cambiano gli
  // input: l'effect di validità della selezione non rigira a vuoto.
  const childSessions = useMemo(
    () =>
      isAll
        ? sessions
        : sessions.filter((s) => {
            const bound = bindings.get(s.sessionId);
            return selectedTaskId ? bound === selectedTaskId : !bound;
          }),
    [sessions, bindings, selectedTaskId, isAll],
  );
  // T50 — lista a due gruppi: pinnate (sempre, in cima) + separatore +
  // contestuali. Dedup, cap solo sulle contestuali, righe stale per le pinnate
  // orfane. Core PURO in session-list.ts (testabile senza Ink).
  const assembled = useMemo(
    () => assembleSessionList(childSessions, sessions, pinned, isAll ? MAX_SESSIONS_ALL : MAX_SESSIONS),
    [childSessions, sessions, pinned, isAll],
  );
  // T62 — contato sulla lista INTERA (stessa ragione delle larghezze di colonna
  // qui sotto): derivarlo dalla finestra visibile lo farebbe cambiare a ogni
  // scroll, cioè un contatore che conta lo schermo invece della lista.
  // T100 — «intera» ora vuol dire la lista della vista di DEFAULT (`assembled`),
  // non quella a schermo: il contatore di una voce del catalogo non può
  // dipendere da quale voce è selezionata, o navigare muoverebbe i numeri.
  const liveCount = useMemo(
    () => assembled.rows.filter((r) => r.kind !== 'separator' && live.has(r.sessionId)).length,
    [assembled, live],
  );
  const sessionCounts: SessionViewCounts = {
    total: assembled.pinnedCount + assembled.contextTotal,
    live: liveCount,
    pinned: assembled.pinnedCount,
    older: assembled.contextHidden,
  };
  // T100 — le righe a schermo sono quelle della vista attiva. Fuori dalla vista
  // di default il separatore non c'è: segna il confine fra pinnate e
  // contestuali, e in un sottoinsieme quel confine non esiste più.
  const sessionRows = useMemo(
    () => selectSessionRows(sessionViewId, { assembled, isLive: (id) => live.has(id) }),
    [sessionViewId, assembled, live],
  );
  const selSessionObj = selectedSession(sessionRows, selSessionId);

  // T60 — larghezze delle colonne fisse della lista sessioni, misurate sulla
  // lista INTERA e non sulla finestra visibile: derivarle dalle sole righe a
  // schermo le farebbe cambiare a ogni scroll, cioè l'opposto di una tabella.
  // La colonna task esiste solo nella vista "tutte" (altrove il binding è lo
  // stesso su ogni riga e sta già nell'header del pane), e `0` la spegne.
  const sessionCols = useMemo(() => {
    let task = 0;
    let age = 2;
    for (const r of sessionRows) {
      if (r.kind === 'separator') continue;
      // La colonna serve dove l'appartenenza NON è già scritta altrove sullo
      // schermo: nella vista "tutte" (ogni riga ha un binding proprio) e su
      // OGNI riga pinnata, in qualunque vista — una pinnata è sganciata dal
      // parent selezionato, quindi l'header del pane non parla per lei.
      if (isAll || r.kind === 'pinned') {
        const b = bindings.get(r.sessionId);
        if (b) task = Math.max(task, termWidth(b));
      }
      if (r.session) age = Math.max(age, termWidth(relTime(r.session.ts)));
    }
    // La cella vuota deve poter entrare nella colonna, o le righe spot
    // perderebbero il segnaposto e con lui l'allineamento.
    return { task: task > 0 ? Math.max(task, termWidth(TASK_EMPTY)) : 0, age };
  }, [sessionRows, bindings, isAll]);

  // T66 — testo del task file wrappato per il detail. `wrapWithOffsets` e non
  // `wrapLines`: quest'ultimo appiattisce gli a-capo in un flusso unico, che per
  // una preview di 4 righe va bene e per un task file — titoli, bullet, tabelle,

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

  // T30: submit dell'input box. Il taskId nasce DOPO create-task (lo assegna la
  // skill scrivendo tasks.md) → non è noto allo spawn. Il sessionId invece è
  // pinnato qui: snapshot degli id PRIMA, poi al completamento re-leggo tasks.md
  // e il diff dà il nuovo id → appendTaskBinding lega la sessione (scoped).
  function submitCreate() {
    const text = draft.trim();
    setMode('normal');
    setDraft('');
    if (!text) {
      setNote('C → create annullato (vuoto)');
      return;
    }
    const sid = randomUUID();
    const beforeIds = new Set(tasks.map((t) => t.id));
    setNote(`⏳ creando task… "${cut(text, 40)}" (sid ${sid.slice(0, 8)})`);
    const child = spawnCreateTask(text, cwd, sid, (ok) => {
      if (!ok) {
        setNote(`⚠ create-task fallito (${CLAUDE_CMD} -p)`);
        return;
      }
      let newId: string | undefined;
      try {
        newId = loadTasks(tasksPath).find((t) => !beforeIds.has(t.id))?.id;
      } catch {
        // tasks.md illeggibile → id non rilevato, sotto
      }
      if (newId) {
        appendTaskBinding(cwd, sid, newId);
        setNote(`✔ ${newId} creata · sessione scoped (sid ${sid.slice(0, 8)})`);
      } else {
        setNote(`✔ task creata (id non rilevato) · sid ${sid.slice(0, 8)}`);
      }
    });
    child.on('error', () => setNote(`⚠ create-task: '${CLAUDE_CMD}' non lanciabile`));
  }

  // T56 — apre una sessione bound alla task selezionata. Punto UNICO dei quattro
  // tasti (⏎/^K/^P/^R): fra loro cambia solo il prompt iniziale, tutto il resto
  // è identico — uuid pinnato, binding scritto PRIMA dello spawn (la sessione
  // risulta figlia della task appena il JSONL compare), handler d'errore, nota.
  // Quattro copie sarebbero quattro posti dove dimenticare il `child.on('error')`,
  // e uno spawn fallito è async: senza handler diventa uncaughtException e
  // ucciderebbe il deck, che invece deve restare vivo.
  // La guardia di focus sta qui e non nei chiamanti perché l'oggetto dell'azione
  // è la task SELEZIONATA: senza il pane task a fuoco non ce n'è una. Per `⏎` il
  // ramo è irraggiungibile (ci arriva già dentro `focus === 'tasks'`); per i tre
  // CTRL, che il ramo `key.ctrl` intercetta globalmente, è l'unico posto.
  // T66 — la guardia, estratta perché ora ha due chiamanti: gli spawn dalla
  // lista e l'apertura del detail. Le tre uscite sono le stesse (pane sbagliato,
  // riga meta, task sparita), e duplicarle vorrebbe dire tenerne allineati i
  // messaggi a mano. `verb` è l'unica cosa che cambia fra i due usi.
  function selectedTaskOr(keyLabel: string, verb: string): Task | null {
    if (focus !== 'tasks') {
      setNote(`${keyLabel} → ${verb}: seleziona una task (← per il pane)`);
      return null;
    }
    // T59 — la guardia è "non è una task", non "è spot": le righe meta sono due
    // e nessuna delle due ha una task da aprire. Il messaggio dice quale delle
    // due, perché il motivo è diverso (vista di sola lettura vs sessioni libere).
    if (isAll || isSpot) {
      setNote(
        isAll
          ? `tutte: vista di sola lettura, nessuna task da ${verb}`
          : `spot: sessioni libere, nessuna task da ${verb}`,
      );
      return null;
    }
    return selTask;
  }

  // Lo spawn vero, su una task GIÀ risolta. Separato dalla guardia perché il
  // detail passa l'id fotografato all'apertura e non la selezione corrente: la
  // lista lì sotto non è più a schermo, quindi non è più la fonte dell'oggetto.
  function spawnForTask(id: string, kind: PromptKind, keyLabel: string) {
    const sid = randomUUID();
    appendTaskBinding(cwd, sid, id);
    const child = spawnDeck(id, cwd, sid, kind);
    child.on('error', () => setNote(`⚠ spawn ${id} fallito (${DECK_RUN})`));
    const what = kind === 'none' ? '' : ` · ${kind}`;
    setNote(`${keyLabel} spawn ${id}${what} → tab CC (sid ${sid.slice(0, 8)})`);
  }

  function spawnTaskSession(kind: PromptKind, keyLabel: string) {
    const task = selectedTaskOr(keyLabel, 'spawnare');
    if (task) spawnForTask(task.id, kind, keyLabel);
  }

  // T53 — apertura del modale nota sulla conversazione selezionata. Come
  // `openEdit`, la bozza parte dal valore ATTUALE: annotare una seconda volta è
  // quasi sempre correggere, e ripartire da vuoto costringerebbe a ridigitare
  // tutto per cambiare una parola.
  function openNote() {
    if (!selSessionId) return;
    setNoteDraft(sessionNotes.get(selSessionId) ?? '');
    setNote('');
    setMode('note');
  }

  // T53 — ⏎ nel modale nota: scrive il sidecar e ricarica subito, senza
  // attendere il tick del poll (stesso feedback immediato del pin).
  //
  // Il campo VUOTO non è un annullamento: è la CANCELLAZIONE della nota. Sono
  // due intenzioni diverse e hanno due tasti diversi — `esc` lascia tutto com'è,
  // `⏎` su campo svuotato toglie la nota. Trattare il vuoto come un no-op (come
  // fa `submitCreate`, dove però una task senza titolo non esiste) renderebbe
  // impossibile disannotare una conversazione se non con un editor sul JSONL.
  function submitNote() {
    const sid = selSessionId;
    const text = noteDraft.trim();
    setMode('normal');
    setNoteDraft('');
    if (!sid) return;
    appendNote(cwd, sid, text);
    reloadSessions();
    setNote(
      text
        ? `✎ nota su ${sid.slice(0, 8)}: "${cut(text, 40)}"`
        : `✎ nota rimossa da ${sid.slice(0, 8)}`,
    );
  }

  // T41 — apertura dell'edit: la bozza parte dai valori ATTUALI della task, non
  // da default. La priorità arriva dal glifo di tasks.md (già in `selTask`), lo
  // stato dal suo glifo Prog; il progresso arbitrario dal campo `Progress` del
  // task file — ma solo se è davvero custom (vedi `initialDetail`).
  //
  // Il titolo si semina dalla riga di tasks.md e non dall'H1 del task file per
  // due ragioni: è la fonte che esiste SEMPRE (un task file può mancare), ed è
  // il testo che l'utente sta guardando in lista quando preme `E`. Grezzo
  // (`rawDesc`), non sanificato: rimandare a disco la forma sanificata
  // riscriverebbe i glifi anche senza toccare il campo.
  function openEdit() {
    if (!selTask) return;
    const prog = progName(selTask.prog) ?? 'todo';
    setEdit({
      pri: priName(selTask.pri) ?? 'med',
      prog,
      detail: initialDetail(detail?.fields['Progress'] ?? '', prog),
      title: selTask.rawDesc,
      // Si apre sulla riga 0 (priorità), che non è un campo di testo: il caret
      // prende la sua posizione entrando in una riga di testo con ↑↓.
      caret: 0,
    });
    setEditRow(0);
    setNote('');
    setMode('edit');
  }

  // T41 — ⏎ nell'edit: scrive tasks.md + task file, poi committa. Il commit è
  // immediato e non confermato (scelta esplicita: l'edit è una micro-modifica,
  // la storia granulare vale più di un batch). Se nessuno dei due lati è stato
  // scritto non si committa nulla — `paths` vuoto renderebbe `git commit --`
  // un commit di TUTTO il working tree, che è l'opposto di ciò che vogliamo.
  function submitEdit() {
    const task = selTask;
    const draft = edit;
    setMode('normal');
    setEdit(null);
    if (!task || !draft) return;

    // Il titolo si scrive solo se è CAMBIATO davvero: rimandarlo identico
    // riscriverebbe comunque la cella (collassando spazi ed escape) e sporcherebbe
    // il diff di una riga per un edit di sola priorità. Vuoto → scartato: una
    // task senza descrizione in overview non è più riconoscibile.
    const title = draft.title.trim();
    const titleChanged = title.length > 0 && title !== task.rawDesc.trim();

    let res: ReturnType<typeof writeTaskEdit>;
    try {
      res = writeTaskEdit({
        tasksPath,
        tasksDir,
        id: task.id,
        pri: draft.pri,
        prog: draft.prog,
        detail: draft.detail,
        title: titleChanged ? title : undefined,
      });
    } catch (e) {
      setNote(`⚠ ${task.id}: scrittura fallita (${(e as Error).message})`);
      return;
    }
    if (res.paths.length === 0) {
      setNote(`⚠ ${task.id}: nessun campo aggiornabile (riga o task file assenti)`);
      return;
    }

    const summary = `${PRI_GLYPH[draft.pri]} ${PRI_LABEL[draft.pri]} · ${res.progress}${
      titleChanged ? ` · "${cut(sanitize(title), 32)}"` : ''
    }`;
    setNote(`⏳ ${task.id} → ${summary} · commit…`);
    commitTaskEdit(
      cwd,
      res.paths,
      `chore(${task.id}): pri ${PRI_LABEL[draft.pri]} · stato ${res.progress}${
        titleChanged ? ' · titolo' : ''
      }`,
      (ok, err) => {
        setNote(ok ? `✔ ${task.id} → ${summary} · committato` : `⚠ ${task.id} salvato, commit fallito: ${err}`);
      },
    );
  }

  // Chiusura di un modale di vista: `restore` rimette la fotografia scattata
  // all'apertura (esc = annulla), altrimenti tiene ciò che si è composto (⏎).
  function closeViewModal(restore: boolean) {
    if (restore && viewBackup) setView(viewBackup);
    setViewBackup(null);
    setMode('normal');
  }

  // Sposta la selezione di `delta` righe nella VISTA (0 = tutte, 1 = spot,
  // 2..N+1 = task visibili) e la riconverte subito in sentinella o id: l'indice
  // non sopravvive a un cambio di filtro, l'id sì.
  function moveTaskSel(delta: number) {
    const next = Math.max(0, Math.min(paneTasks.length + META_ROWS - 1, selIndex + delta));
    if (next === ROW_ALL) setSel(ALL);
    else if (next === ROW_SPOT) setSel(SPOT);
    else setSel(paneTasks[next - META_ROWS]?.id ?? SPOT);
  }

  // T100 — `tab` naviga il catalogo viste del pane in focus. Il reset della
  // selezione è la regola letterale «prima riga in alto», senza eccezioni: sul
  // pane task è `ROW_ALL` (D2 preflight — le righe meta non si saltano, e il
  // parent delle sessioni che torna a `tutte` è un effetto accettato); sul pane
  // sessioni basta invalidare l'id, e l'effect di validità atterra sulla prima
  // riga selezionabile della vista nuova.
  function cycleView(delta: number) {
    if (focus === 'tasks') {
      const next = cycleTaskView(taskViewId, delta);
      setTaskViewId(next);
      setSel(ALL);
      setNote(`vista task: ${taskView(next).label(taskCounts)}`);
    } else {
      const next = cycleSessionView(sessionViewId, delta);
      setSessionViewId(next);
      setSelSessionId(null);
      setNote(`vista sessioni: ${sessionView(next).label(sessionCounts, parentLabel)}`);
    }
  }

  // T49 — resume di una conversazione in una nuova tab. Unico punto: lo chiamano
  // il `⏎` della lista sessioni e quello sulla riga-sessione della ricerca, che
  // devono restare la stessa azione.
  function resumeSession(sessionId: string) {
    const bound = bindings.get(sessionId) ?? null;
    const child = spawnDeckResume(bound, cwd, sessionId, sessionNotes.get(sessionId));
    child.on('error', () => setNote(`⚠ resume fallito (${DECK_RUN})`));
    setNote(`⏎ resume ${sessionId.slice(0, 8)} → tab CC${bound ? ` (${bound})` : ' (spot)'}`);
  }

  // T57 — ⏎ nel modale: riscrive il binding nel sidecar e ricarica subito.
  //
  // Il binding retroattivo governa il FUTURO della conversazione, non il suo
  // passato: il titolo della tab è stato deciso allo spawn da `claude --name` e
  // vive nel transcript, la `LOOM_TASK` di un processo già partito non si
  // reinietta. Cambia cosa fa il prossimo `⏎ resume`, che rilegge il binding dal
  // sidecar. La nota lo dice: senza, la promessa implicita è «ho spostato la
  // conversazione» e il titolo che non cambia sembra un bug.
  //
  // Dove atterra la selezione (D6): il pane task non si muove, quindi la
  // sessione appena assegnata esce dal gruppo contestuale → si scende alla riga
  // SUCCESSIVA, catturata PRIMA della riscrittura (dopo, la riga non c'è più).
  // Due eccezioni in cui invece resta dov'è, perché non sparisce affatto: una
  // pinnata (esente dal contesto) e un'assegnazione al parent già selezionato.
  const assign = useAssignOverlay({
    viewTasks,
    rows,
    hasNote: Boolean(note),
    setMode,
    setNote,
    onSubmit: (sid, target) => {
      const stays = pinned.has(sid) || target === selectedTaskId;
      const next = stays ? sid : neighborId(sessionRows, sid);
      appendTaskBinding(cwd, sid, target ?? '');
      reloadSessions();
      setSelSessionId(next);
      setNote(
        target
          ? `A ${sid.slice(0, 8)} → ${target} · vale dal prossimo ⏎ resume (titolo tab invariato)`
          : `A ${sid.slice(0, 8)} → spot · binding rimosso`,
      );
    },
  });

  const sheet = useSheetOverlay({
    rows,
    columns,
    setMode,
    setNote,
    onAction: (id, kind, label) => spawnForTask(id, kind, label),
  });

  const search = useSearchOverlay({
    sessions,
    rows,
    columns,
    hasNote: Boolean(note),
    setMode,
    setNote,
    onResume: (row) => resumeSession(row.session.sessionId),
  });

  function onCreateKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setDraft('');
      setNote('C → create annullato');
    } else if (key.return) {
      submitCreate();
    } else if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setDraft((d) => d + input);
    }
  }

  function onNoteKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setNoteDraft('');
      setNote('N → nota annullata');
    } else if (key.return) {
      submitNote();
    } else if (key.ctrl && input === 'u') {
      // Svuota il campo in un colpo. NON è una scorciatoia di comodo: il
      // backspace tenuto premuto cancella UN carattere per CHUNK letto da
      // stdin, non per pressione (`useInput` consegna il chunk, e per una
      // raffica di DEL Ink alza `key.backspace` una volta sola) — misurato,
      // 30 pressioni → 2 caratteri. Siccome «campo vuoto» qui è l'unico modo
      // di CANCELLARE una nota, dipendere dal backspace renderebbe
      // l'operazione praticamente non eseguibile. `^U` è il kill-line delle
      // shell, quindi il gesto è già nelle dita di chi usa un terminale.
      setNoteDraft('');
    } else if (key.backspace || key.delete) {
      setNoteDraft((d) => d.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      // Sanificazione dei byte di controllo, come `typeIntoField` della
      // ricerca: `useInput` consegna il CHUNK letto da stdin, quindi un
      // incollaggio porta dentro newline e control char. Invisibili a schermo
      // ma contati da Ink nella larghezza della riga — e qui finirebbero
      // scritti su disco, dove resterebbero a sporcare la riga per sempre.
      // Le newline diventano spazio: incollare due righe deve separare le
      // parole, non fonderle.
      setNoteDraft((d) => d + sanitizeTyped(input));
    }
  }

  function onSortKey(input: string, key: Key) {
    if (key.escape) {
      closeViewModal(true);
      setNote('S → sort annullato');
    } else if (key.return) {
      closeViewModal(false);
      setNote(`S → sort: ${describeSort(view.sort)}`);
    } else if (input) {
      // useInput consegna il CHUNK letto da stdin, non un tasto: digitando
      // veloce (o incollando) `ppi` arriva come stringa unica. Si cicla su
      // ogni carattere, così la chain esce identica a battitura lenta.
      const keys = [...input].map((ch) => SORT_TASTI[ch]).filter(Boolean);
      if (keys.length > 0) {
        setView((v) => ({ ...v, sort: keys.reduce(cycleSort, v.sort) }));
      }
    }
  }

  function onFilterKey(input: string, key: Key) {
    const rowLen = (r: 0 | 1) => (r === 0 ? PRI_ENTRIES.length : PROG_ENTRIES.length);
    if (key.escape) {
      closeViewModal(true);
      setNote('F → filtri annullati');
    } else if (key.return) {
      closeViewModal(false);
      setNote(hiddenTasks > 0 ? `F → ${hiddenTasks} task nascoste` : 'F → nessun filtro attivo');
    } else if (key.upArrow || key.downArrow) {
      setFilterCursor((c) => {
        const row: 0 | 1 = c.row === 0 ? 1 : 0;
        return { row, col: Math.min(c.col, rowLen(row) - 1) };
      });
    } else if (key.leftArrow) {
      setFilterCursor((c) => ({ ...c, col: Math.max(0, c.col - 1) }));
    } else if (key.rightArrow) {
      setFilterCursor((c) => ({ ...c, col: Math.min(rowLen(c.row) - 1, c.col + 1) }));
    } else if (input === ' ') {
      const { row, col } = filterCursor;
      setView((v) =>
        row === 0
          ? { ...v, hiddenPri: toggleHidden<PriName>(v.hiddenPri, PRI_ENTRIES[col].name) }
          : { ...v, hiddenProg: toggleHidden<ProgName>(v.hiddenProg, PROG_ENTRIES[col].name) },
      );
    }
  }

  function onEditKey(input: string, key: Key) {
    if (key.escape) {
      setMode('normal');
      setEdit(null);
      setNote('E → edit annullato');
    } else if (key.return) {
      submitEdit();
    } else if (key.upArrow || key.downArrow) {
      const next = ((editRow + EDIT_ROWS + (key.upArrow ? -1 : 1)) % EDIT_ROWS) as EditRow;
      setEditRow(next);
      // Il caret segue la riga attiva e atterra in CODA al nuovo campo: è la
      // posizione da cui si continua a scrivere, ed è anche l'unica che non
      // dipende da dove stava il cursore nel campo precedente.
      setEdit((e) => (e && isTextRow(next) ? { ...e, caret: cpLen(e[editField(next)]) } : e));
    } else if ((key.leftArrow || key.rightArrow) && !isTextRow(editRow)) {
      const d = key.leftArrow ? -1 : 1;
      // Scorrimento CICLICO (wrap) e non clampato: le liste sono di 3-4 voci,
      // arrivare in fondo e ripartire costa meno di invertire direzione.
      if (editRow === 0) {
        setEdit((e) =>
          e ? { ...e, pri: EDIT_PRI[(EDIT_PRI.indexOf(e.pri) + d + EDIT_PRI.length) % EDIT_PRI.length] } : e,
        );
      } else if (editRow === 1) {
        setEdit((e) =>
          e
            ? { ...e, prog: EDIT_PROG[(EDIT_PROG.indexOf(e.prog) + d + EDIT_PROG.length) % EDIT_PROG.length] }
            : e,
        );
      }
    } else if (isTextRow(editRow)) {
      // Un solo ramo per i due campi di testo, la riga sceglie la chiave:
      // duplicarlo significherebbe tenere allineate a mano due copie della
      // stessa grammatica di input a ogni tasto aggiunto.
      const field = editField(editRow);
      if (key.ctrl) {
        // T54 — ramo CTRL ANTEPOSTO a quelli su carattere, come in modalità
        // normale: `^A` e `a` arrivano con lo stesso `input`, quindi senza
        // questa precedenza il `^A` finirebbe dentro il testo.
        //
        // `^A`/`^E` (convenzione readline) perché `Home`/`End` NON sono
        // esposte da `useInput`: arrivano come input vuoto, indistinguibili
        // da qualunque altro tasto senza nome.
        //
        // `^D` è il delete-forward, e anche qui il motivo è un limite di Ink:
        // il tasto Backspace fisico manda `\x7f` e il tasto Canc manda
        // `\x1b[3~`, ma `parseKeypress` li battezza ENTRAMBI `delete` e
        // svuota `input` — a valle sono lo stesso evento. `key.delete` va
        // quindi al backspace (il tasto che si usa davvero) e la
        // cancellazione in avanti prende il suo tasto readline.
        if (input === 'a') setEdit((e) => (e ? { ...e, caret: 0 } : e));
        else if (input === 'e') setEdit((e) => (e ? { ...e, caret: cpLen(e[field]) } : e));
        else if (input === 'd') setEdit((e) => (e ? { ...e, [field]: removeAt(e[field], e.caret) } : e));
      } else if (key.leftArrow || key.rightArrow) {
        // CLAMP agli estremi, non wrap: a inizio campo `←` non deve saltare in
        // fondo. Le liste di valori (righe 0/1) ciclano perché sono 3-4 voci;
        // un testo no — il salto sarebbe indistinguibile da uno sfarfallio.
        const d = key.leftArrow ? -1 : 1;
        setEdit((e) =>
          e ? { ...e, caret: Math.max(0, Math.min(cpLen(e[field]), e.caret + d)) } : e,
        );
      } else if (key.backspace || key.delete) {
        setEdit((e) =>
          e ? { ...e, [field]: removeAt(e[field], e.caret - 1), caret: Math.max(0, e.caret - 1) } : e,
        );
      } else if (input && !key.meta) {
        // `sanitizeTyped`: `useInput` consegna il CHUNK di stdin, quindi un
        // incollaggio porta dentro newline e byte di controllo — invisibili
        // nel campo ma contati da Ink nella larghezza della riga, e destinati
        // a finire tali e quali dentro tasks.md. Ed è per lo stesso motivo che
        // il caret avanza della LUNGHEZZA del chunk, non di uno: un incollaggio
        // entra tutto insieme.
        const ins = sanitizeTyped(input);
        setEdit((e) =>
          e ? { ...e, [field]: insertAt(e[field], e.caret, ins), caret: e.caret + cpLen(ins) } : e,
        );
      }
    }
  }

  // Il dispatch consulta il CATALOGO (`input-modes.ts`), non l'ordine di una
  // catena di `if`. `MODE_KEYS` è il custode: essendo un `Record` su
  // `CapturingMode`, un modo nuovo senza handler non compila.
  const MODE_KEYS: Record<CapturingMode, (input: string, key: Key) => void> = {
    detail: sheet.onKey,
    reader: search.onReaderKey,
    search: search.onSearchKey,
    assign: assign.onKey,
    create: onCreateKey,
    note: onNoteKey,
    sort: onSortKey,
    filter: onFilterKey,
    edit: onEditKey,
  };

  useInput((input, key) => {
    // Un modo capturing consuma TUTTO — acceleratori globali compresi — e le
    // deroghe se le gestisce da sé (`CTRL_DEROGATIONS`). Da qui in giù si è
    // quindi in `normal`, l'unico modo che cede ai `key.ctrl`.
    if (captures(mode)) {
      MODE_KEYS[mode](input, key);
      return;
    }

    // T52/D1 — il ramo CTRL sta PRIMA di quelli su lettera nuda e li chiude
    // tutti. `CTRL+F` e `f` nudo arrivano con lo STESSO `input` ('f'),
    // distinguibili solo da `key.ctrl`: senza questa precedenza `CTRL+F`
    // cadrebbe nel ramo fork e spawnerebbe una sessione invece di aprire la
    // ricerca. Non è un caso isolato della `f` — `^Q` finirebbe nel quit, `^T`
    // aprirebbe un terminale, `^C` … ogni lettera legata a un'azione ha la sua
    // combo omonima. Chiudere qui l'intera classe è più solido che ricordarsi
    // un `!key.ctrl` su ognuno dei rami, oggi e a ogni tasto aggiunto domani.
    if (key.ctrl) {
      if (input === 'f') {
        setNote('');
        setMode('search');
      } else if (input === 'k') {
        spawnTaskSession('recap', '^K');
      } else if (input === 'p') {
        spawnTaskSession('preflight', '^P');
      } else if (input === 'r') {
        spawnTaskSession('run', '^R');
      }
      return;
    }

    if (key.tab) {
      // `tab` cicla la VISTA del pane a fuoco, `←→` spostano il focus fra i due
      // pane: il criterio dell'assegnazione è spaziale. Una freccia orizzontale
      // porta con sé una direzione e i pane sono affiancati (task a sinistra,
      // sessioni a destra), quindi il tasto NOMINA il pane invece di limitarsi
      // a scambiarlo; un catalogo ciclico non ha un verso da rispettare, e un
      // tasto solo gli basta. `shift+tab` (backtab, `[Z`) scorre a rovescio — il
      // verso che un tasto singolo non esprime sta nel modificatore, e su cinque
      // voci risparmia quattro pressioni.
      cycleView(key.shift ? -1 : 1);
    } else if (key.leftArrow || key.rightArrow) {
      // Binding ASSOLUTO, non toggle: `←` porta sempre sui task e `→` sempre
      // sulle sessioni, quindi ripremere lo stesso tasto non riporta indietro.
      // È ciò che lo rende spaziale — la direzione indica una destinazione, e
      // con due soli pane un toggle sarebbe indistinguibile solo per caso.
      setFocus(key.leftArrow ? 'tasks' : 'sessions');
    } else if (key.upArrow) {
      if (focus === 'tasks') moveTaskSel(-1);
      else setSelSessionId((id) => moveSelection(sessionRows, id, -1));
    } else if (key.downArrow) {
      if (focus === 'tasks') moveTaskSel(1);
      else setSelSessionId((id) => moveSelection(sessionRows, id, 1));
    } else if (key.return) {
      if (focus === 'tasks') {
        // T66 — ⏎ apre il DETAIL, non più una sessione. Secondo rimappaggio in
        // due task (T56 lo spostò da recap a sessione a mani nude), e la
        // direzione è una sola: da azione singola a punto d'ingresso. Il tasto
        // più battuto non è il posto dove inchiodare una scelta di prompt — le
        // shortcut CTRL restano per chi sa già cosa vuole, `⏎` apre il ventaglio.
        // Lo spawn a mani nude di prima è `open`, cioè `⏎ ⏎` (è il focus iniziale).
        {
          const task = selectedTaskOr('⏎', 'aprire');
          if (task) {
            sheet.open({
              id: task.id,
              // Il titolo del task file quando c'è (è l'H1, cioè la forma
              // lunga), la riga di tasks.md altrimenti: il detail non deve
              // restare senza intestazione solo perché il file manca.
              title: detail?.title || task.desc,
              text: loadTaskFileText(tasksDir, task.id),
            });
          }
        }
      } else {
        // T49 — ⏎ su una sessione = resume in nuova tab. Il binding si rilegge
        // dal sidecar (non dal padre selezionato): vale anche per le spot.
        const s = selSessionObj;
        if (!s) {
          setNote(selSessionId ? 'pin stale: transcript non più presente' : 'nessuna sessione da riprendere');
        } else {
          resumeSession(s.sessionId);
        }
      }
    } else if (input === 'C') {
      setNote('');
      setMode('create');
    } else if (input === 'E') {
      // L'edit ha senso solo su una task reale: le righe meta non ne sono.
      if (!selTask) setNote('E → nessuna task selezionata');
      else openEdit();
    } else if (input === 'S') {
      setViewBackup(view);
      setNote('');
      setMode('sort');
    } else if (input === 'F') {
      // T100/D3 — i filtri valgono SOLO sulla vista principale: su `nascoste`
      // riapplicarli non ha senso (quella vista È il loro complemento), su
      // `archiviabili` non li si vuole (è cieca ai filtri per decisione). Stessa
      // forma dell'inerzia di ^K/^P/^R dentro il detail, ma keyed sulla vista
      // invece che sul modo — e come là, l'inerzia lo DICE invece di non fare
      // niente in silenzio.
      if (taskViewId !== 'tasks') {
        setNote(
          `F → filtri: solo sulla vista ${TASK_VIEWS[0]!.label(taskCounts)} (ora: ${taskView(taskViewId).label(taskCounts)})`,
        );
      } else {
        setViewBackup(view);
        setNote('');
        setMode('filter');
      }
    } else if (input === 'f') {
      // T28 — fork della sessione selezionata. Minuscola come `t`/`c` (T39):
      // azione immediata, nessun modale — la `F` maiuscola resta ai filtri.
      // Vive solo sul pane sessioni: il fork ha per oggetto una conversazione,
      // e senza focus lì non ce n'è una selezionata su cui agire.
      if (focus !== 'sessions') {
        setNote('f → fork: seleziona una sessione (→ per il pane)');
      } else {
        const s = selSessionObj;
        if (!s) {
          setNote(selSessionId ? 'f → pin stale: niente da forkare' : 'f → nessuna sessione da forkare');
        } else {
          // L'id del ramo nasce qui, prima dello spawn: pinnandolo posso
          // scrivere subito binding e lineage. Il binding task si eredita
          // dall'origine (un ramo appartiene alla stessa task), il lineage
          // registra la provenienza che il transcript non porta.
          const newId = randomUUID();
          const bound = bindings.get(s.sessionId) ?? null;
          appendSessionRecord(cwd, {
            sessionId: newId,
            ...(bound ? { taskId: bound } : {}),
            forkOf: s.sessionId,
          });
          const child = spawnDeckFork(bound, cwd, s.sessionId, newId);
          child.on('error', () => setNote(`⚠ fork fallito (${DECK_RUN})`));
          setNote(
            `⑂ fork ${s.sessionId.slice(0, 8)} → ${newId.slice(0, 8)}${bound ? ` (${bound})` : ' (spot)'}`,
          );
        }
      }
    } else if (input === 'p') {
      // T50 — pin/unpin della conversazione selezionata. Minuscola = azione
      // immediata (convenzione T39), gemella di `f`: opera sulla riga
      // selezionata del pane sessioni, quindi vive solo lì. Vale anche su una
      // pinnata STALE (l'unico modo di spinnarla). Scrive il sidecar e ricarica
      // subito, senza attendere il tick del poll.
      if (focus !== 'sessions') {
        setNote('p → pin: seleziona una sessione (→ per il pane)');
      } else if (!selSessionId) {
        setNote('p → nessuna sessione da pinnare');
      } else {
        const isPinned = pinned.has(selSessionId);
        // Dove atterra la selezione: sul pin resta sulla sessione (sale in cima
        // con lei, il caret la segue perché è l'oggetto dell'azione); sull'unpin
        // resta IN PLACE nel gruppo pinnate — successiva, precedente, o prima
        // contestuale se il gruppo si svuota. Calcolato PRIMA della riscrittura
        // del sidecar, quando la riga pinnata esiste ancora.
        const landing = isPinned ? unpinLandingId(sessionRows, selSessionId) : null;
        appendPin(cwd, selSessionId, !isPinned);
        reloadSessions();
        if (landing) setSelSessionId(landing);
        setNote(`${isPinned ? 'unpin' : '📌 pin'} ${selSessionId.slice(0, 8)}`);
      }
    } else if (input === 'N') {
      // T53 — nota sulla conversazione selezionata. MAIUSCOLA perché apre un
      // modale: nel deck le minuscole sono azioni immediate (`f` fork, `p` pin,
      // `t` term, `c` claude) e le maiuscole aprono un box (`C` create, `E`
      // edit, `S` sort, `F` filtri). Vincolo di focus identico a `p`: vale anche
      // su una pinnata STALE, perché annotare «questa non c'è più, era X» è
      // proprio il caso in cui una nota serve.
      if (focus !== 'sessions') {
        setNote('N → nota: seleziona una sessione (→ per il pane)');
      } else if (!selSessionId) {
        setNote('N → nessuna sessione da annotare');
      } else {
        openNote();
      }
    } else if (input === 'A') {
      // T57 — assegna la conversazione selezionata a una task. MAIUSCOLA perché
      // apre un modale (convenzione T39), e il modale è obbligatorio: il pane
      // task non può fare da picker, perché spostare la selezione lì cambia il
      // parent e la sessione da assegnare sparisce dalla lista sotto le mani.
      // Vincolo di focus identico a `p`/`N`, e vale anche su una pinnata STALE:
      // il binding è nostro, il transcript è di CC — riassegnare una
      // conversazione il cui transcript non c'è più resta legittimo.
      if (focus !== 'sessions') {
        setNote('A → assegna: seleziona una sessione (→ per il pane)');
      } else if (!selSessionId) {
        setNote('A → nessuna sessione da assegnare');
      } else {
        if (selSessionId) assign.open(selSessionId, bindings.get(selSessionId));
      }
    } else if (input === 't') {
      const title = identity ? `🖥️ ${identity.name} [term]` : null;
      const child = spawnTerminal(cwd, title);
      child.on('error', () => setNote('⚠ t → ptyxis non lanciabile'));
      setNote(`t → terminale su ${projectName}`);
    } else if (input === 'c') {
      // Minuscola = azione immediata (convenzione T39), gemella di `t`: entrambe
      // aprono una surface del cappello senza passare da un modale. `C` (create
      // task) resta distinta — stessa lettera, ma la maiuscola è per i modali.
      const child = spawnClaudeEmpty(cwd);
      child.on('error', () => setNote(`⚠ c → spawn claude fallito (${DECK_RUN})`));
      setNote(`c → claude nuda su ${projectName} (nessuna task)`);
    } else if (input === 'w') {
      // Salvataggio ESPLICITO: comporre una vista non tocca il disco, così
      // sperimentare non sporca lo stato persistito.
      try {
        saveView(cwd, view);
        setNote(`w → vista salvata (${viewFilePath(cwd)})`);
      } catch {
        setNote('⚠ salvataggio vista fallito');
      }
    } else if (input && /^[1-9]$/.test(input)) {
      const entry = launch[Number(input) - 1];
      if (!entry) {
        setNote(`${input} → nessuna voce launch (${launch.length} configurate)`);
      } else {
        const child = runLaunch(entry, cwd);
        child.on('error', () => setNote(`⚠ ${entry.label}: '${entry.command}' non lanciabile`));
        setNote(`${input} → ${entry.label} su ${projectName}`);
      }
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  const canSpawn = focus === 'tasks' && selTask !== null;
  const canResume = focus === 'sessions' && selSessionObj !== null;
  // T50 — il pin agisce su qualunque riga selezionata (anche stale, per
  // spinnarla); basta il focus sul pane e una selezione.
  const canPin = focus === 'sessions' && selSessionId !== null;
  // Le due surface built-in del cappello stanno in testa alla riga launch, non
  // fra i tasti: hanno la stessa natura delle voci `launch` — fire-once, cwd =
  // project root, nessuno stato — e la differenza è solo che sono universali
  // (nessun progetto le dichiara) invece che custom. Emoji del menu compass:
  // 🤖 = nuova sessione claude. Per il terminale compass usa 🖥️, che nel frame
  // Ink NON passa — `sanitize` lo sostituisce (VTE lo disegna largo 1,
  // string-width dice 2: discordante, invariante ① di width.ts) e resterebbe un
  // `·` muto. 💻 è il gemello concorde; il `sanitize` qui rende il vincolo
  // automatico invece che da ricordare.
  const surfaceLegend = sanitize('t 💻 · c 🤖');
  // Larghezza dal medesimo hook che dà l'altezza: dopo un resize la legenda si
  // ricalcola con lo stesso re-render che ridimensiona i pane. Le celle delle
  // surface (più il ` · ` che le separa dalle voci) sono già spese sulla riga →
  // vanno riservate, o le voci launch la sfonderebbero di quel tanto.
  const legend = launchLegend(launch, columns, cellWidth(surfaceLegend) + 3);

  // Legenda della modalità normale. Elenca SOLO i tasti che fanno qualcosa qui e
  // ora: le voci contestuali compaiono quando il pane a fuoco le rende possibili
  // e altrimenti spariscono, invece di annunciarsi inerti con un `—`.
  // Fuori: navigazione (`↑↓` `←→`) e uscita (`q`), universali in qualunque TUI, e
  // l'indicatore `focus:` — il pane a fuoco si vede già dall'evidenziazione, e
  // ridirlo a parole costava colonne su una riga che tronca in silenzio.
  const keyLegend = sanitize(
    [
      ...(canSpawn ? ['⏎ detail', '^K/^P/^R spawn'] : canResume ? ['⏎ resume'] : []),
      ...(canResume ? ['f fork'] : []),
      ...(canPin ? ['p pin', 'N nota', 'A assegna'] : []),
      '^F cerca',
      'C nuova',
      'E edit',
      'S sort',
      'F filtri',
      'w salva',
    ].join(' · '),
  );

  // ── T57 · schermata di assegnazione ─────────────────────────────────────
  // Sostitutiva come ricerca e reader (D3): la lista task non entra in un box
  // sopra i due pane, e prendendo l'intero frame non costa nulla al loro budget.
  // Conseguenza obbligata della scelta: la sessione in assegnazione non è più
  // visibile, quindi va RIPETUTA nel titolo — senza, non si sa più su cosa si
  // sta agendo.
  if (mode === 'assign') {
    if (isCompact(assign.capacity)) {
      return (
        <Text wrap="truncate-end">
          <Text bold color="cyan">loom-deck</Text>
          <Text dimColor>
            {' '}· assegna · terminale {rows}×{columns}: troppo basso, allarga · esc annulla
          </Text>
        </Text>
      );
    }
    const at = assign.list.findIndex((t) => (t?.id ?? null) === assign.sel);
    const win = windowRange(assign.list.length, at, assign.capacity);
    const s = assign.sid ? sessions.find((x) => x.sessionId === assign.sid) ?? null : null;
    // Etichetta della conversazione: la nota umana se c'è (è il nome con cui la
    // riconosci), altrimenti la stessa derivazione della ricerca. Su una pinnata
    // stale non resta nulla: il titolo si accontenta dell'hash.
    const label =
      (assign.sid ? sessionNotes.get(assign.sid) : '') ||
      (s ? conversationLabel(s, projectCore, assign.sid ? bindings.get(assign.sid) : undefined) : '');
    return (
      <AssignScreen
        sessionId={assign.sid ?? ''}
        label={label}
        current={assign.sid ? bindings.get(assign.sid) ?? null : null}
        filter={assign.filter}
        rows={assign.list.slice(win.start, win.end)}
        selected={assign.sel}
        matched={assign.list.length - 1}
        hidden={hiddenTasks}
        above={win.start}
        below={assign.list.length - win.end}
        childCount={childCount}
        columns={columns}
        note={note}
      />
    );
  }

  // ── T66 · detail della task ─────────────────────────────────────────────
  // Quarta schermata sostitutiva, stessa ragione delle altre tre: un task file
  // non entra in un box sopra i due pane. Il budget dei pane non viene nemmeno
  // calcolato — il render esce di qui prima.
  if (mode === 'detail' && sheet.sheet) {
    if (isCompact(sheet.capacity)) {
      return (
        <Text wrap="truncate-end">
          <Text bold color="cyan">loom-deck</Text>
          <Text dimColor>
            {' '}· {sheet.sheet.id} · terminale {rows}×{columns}: troppo basso, allarga · esc chiude
          </Text>
        </Text>
      );
    }
    // Niente `windowRange`: quella centra la finestra su una selezione, qui la
    // posizione è lo scroll mosso a mano. Il clamp serve comunque — un resize
    // può accorciare il testo sotto uno scroll già dato.
    const start = Math.min(sheet.top, sheet.maxTop);
    return (
      <DetailScreen
        id={sheet.sheet.id}
        title={sheet.sheet.title}
        missing={sheet.sheet.text === null}
        lines={sheet.lines.slice(start, start + sheet.capacity)}
        spans={sheet.doc?.spans ?? []}
        top={start}
        total={sheet.lines.length}
        capacity={sheet.capacity}
        action={sheet.action}
        columns={columns}
        find={sheet.find}
        occ={sheet.findRes.occ}
        occCur={sheet.occCur}
      />
    );
  }

  // ── T52 · schermate sostitutive ─────────────────────────────────────────
  // Ricerca e reader sono gli unici modali che NON stanno in flusso sopra i
  // pane: una lista di occorrenze non entra in un box da 4 righe. Prendono
  // l'intero frame, quindi escono di qui — il budget dei due pane sotto non
  // serve nemmeno calcolarlo, e la loro altezza la distribuiscono
  // `searchListCapacity` / `readerCapacity`.
  if (mode === 'search' || mode === 'reader') {
    const hit = mode === 'reader' && search.readerRow?.kind === 'hit' ? search.readerRow.hit : null;
    // Terminale sotto la cornice: riga singola invece del box, per lo stesso
    // motivo del `budget.compact` del deck — un frame più alto di `rows` fa
    // pulire lo schermo a Ink a ogni redraw, e il poll lo versa nello scrollback.
    if (isCompact(hit ? search.readerCap : search.listCap)) {
      return (
        <Text wrap="truncate-end">
          <Text bold color="cyan">loom-deck</Text>
          <Text dimColor>
            {' '}· {hit ? 'reader' : 'ricerca'} · terminale {rows}×{columns}: troppo basso, allarga ·{' '}
            esc {hit ? 'torna' : 'chiude'}
          </Text>
        </Text>
      );
    }
    if (hit) {
      // Niente `windowRange`: quella centra la finestra su una SELEZIONE, qui
      // la posizione è lo scroll che l'utente muove a mano. Il clamp serve
      // comunque — un resize può accorciare il testo sotto uno scroll già dato.
      const start = Math.min(search.readerTop, search.readerMaxTop);
      return (
        <ReaderScreen
          hit={hit}
          lines={search.readerLines.slice(start, start + search.readerCap)}
          top={start}
          total={search.readerLines.length}
          capacity={search.readerCap}
          bound={bindings.get(hit.sessionId) ?? null}
        />
      );
    }
    const selIdx = rowIndexOfKey(search.rows, search.selKey);
    const win = windowRange(search.rows.length, selIdx, search.listCap);
    // Anteprima dell'occorrenza selezionata: prende le righe che la lista non
    // usa. Con molti risultati `spare` è 0 e il pannello non esiste — la lista
    // se le riprende tutte, che è la priorità giusta quando c'è molto da
    // scorrere. La finestra si CENTRA sul match (`windowRange`), così il
    // contesto arriva da entrambi i lati.
    const spare = searchPreviewCapacity(search.listCap, win.end - win.start);
    let preview = null;
    if (spare >= 1 && search.selRow?.kind === 'hit') {
      const h = search.selRow.hit;
      const mline = Math.max(0, search.previewBody.findIndex((l) => l.end > h.matchStart));
      const pw = windowRange(search.previewBody.length, mline, spare);
      preview = {
        hit: h,
        lines: search.previewBody.slice(pw.start, pw.end),
        from: pw.start,
        total: search.previewBody.length,
        ts: sessions.find((s) => s.sessionId === h.sessionId)?.ts ?? 0,
      };
    }
    return (
      <SearchScreen
        preview={preview}
        hash={search.hash}
        query={search.query}
        field={search.field}
        opts={search.opts}
        result={search.result}
        rows={search.rows.slice(win.start, win.end)}
        selectedKey={search.selKey}
        selectedKind={selectedRow(search.rows, search.selKey)?.kind ?? null}
        above={win.start}
        below={search.rows.length - win.end}
        capacity={search.listCap}
        bindings={bindings}
        pinned={pinned}
        sessionNotes={sessionNotes}
        projectCore={projectCore}
        columns={columns}
        note={note}
      />
    );
  }

  // ── Budget d'altezza ────────────────────────────────────────────────────
  // Il frame deve restare sotto `rows`, sempre: oltre quella soglia Ink smette
  // di aggiornare per differenza e pulisce lo schermo a ogni redraw, che su
  // Ptyxis significa un frame intero versato nello scrollback per ogni tick del
  // poll. Tutto ciò che varia in altezza (le due liste e la descrizione del
  // dettaglio) riceve qui la propria capienza.
  // Le surface built-in `t`/`c` la rendono sempre presente in modalità normale:
  // non dipende più da quante voci `launch` il progetto dichiara.
  const launchLine = mode === 'normal';
  const detailParts = detail ? detailMetaOf(detail) : null;
  // T70 — un solo blocco preview, sotto i due pane, e il FOCUS decide cosa
  // contiene: a sinistra la task selezionata, a destra la conversazione. È il
  // focus e non la selezione perché il blocco è uno — averne due significava
  // pagare due cornici per mostrare contemporaneamente il dettaglio di una cosa
  // che si sta guardando e di una che non si sta guardando.
  // `none` quando non c'è contenuto (riga meta selezionata, task file assente,
  // pin stale): il blocco sparisce del tutto, non resta una cornice vuota.
  const previewKind: PreviewKind =
    focus === 'tasks' ? (detail ? 'task' : 'none') : selSessionObj ? 'session' : 'none';
  const budget: Budget = layoutBudget({
    rows,
    mode,
    launchLine,
    noteLine: Boolean(note),
    preview: previewKind,
    detailMetaLines: detailParts?.metaLines ?? 0,
    // Riservo righe di anteprima solo per i blocchi che davvero renderizzano: il
    // primo prompt aggiunge info solo con un titolo custom (senza, titolo ===
    // primo prompt); l'ultima risposta solo se il modello ha già risposto.
    sessionHasFirstPreview: previewKind === 'session' && Boolean(selSessionObj?.customTitle),
    sessionHasLastPreview: previewKind === 'session' && Boolean(selSessionObj?.lastReply),
  });

  // Finestre di rendering. Le liste "logiche" (viewTasks, sessionRows)
  // restano intere: navigazione, selezione e spawn continuano a ragionare su
  // quelle, la finestra è solo ciò che finisce a schermo.
  const taskWin = windowRange(paneTasks.length, selIndex - META_ROWS, budget.taskRows);
  const windowTasks = paneTasks.slice(taskWin.start, taskWin.end);
  const selRowIndex = rowIndexOf(sessionRows, selSessionId);
  const sessionWin = windowRange(sessionRows.length, selRowIndex, budget.sessionRows);
  const windowRows = sessionRows.slice(sessionWin.start, sessionWin.end);

  // Sotto la soglia minima il layout a box non entra a nessun costo: si scende
  // a una riga sola. Perdere il deck per un terminale basso è meglio che
  // sporcare la cronologia del terminale a ogni poll.
  if (budget.compact) {
    return (
      <Text wrap="truncate-end">
        <Text bold color="cyan">loom-deck</Text>
        <Text dimColor>
          {' '}· {viewTasks.length} task · sel {selectedTaskId ?? parentLabel} · terminale {rows}×
          {columns}: troppo basso, allarga
        </Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      {mode === 'create' ? (
        <Text dimColor wrap="truncate-end">
          nuova task · <Text color="yellow">⏎</Text> crea · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'sort' ? (
        <Text dimColor wrap="truncate-end">
          sort · <Text color="yellow">p</Text> pri <Text color="yellow">s</Text> stato{' '}
          <Text color="yellow">i</Text> id (asc→desc→off) · <Text color="yellow">⏎</Text> ok ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'filter' ? (
        <Text dimColor wrap="truncate-end">
          filtri · <Text color="yellow">↑↓←→</Text> naviga · <Text color="yellow">spazio</Text>{' '}
          mostra/nascondi · <Text color="yellow">⏎</Text> ok · <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'note' ? (
        <Text dimColor wrap="truncate-end">
          nota conversazione · <Text color="yellow">^U</Text> svuota ·{' '}
          <Text color="yellow">⏎</Text> salva (vuoto = rimuove) ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : mode === 'edit' ? (
        <Text dimColor wrap="truncate-end">
          edit · <Text color="yellow">↑↓</Text> campo · <Text color="yellow">←→</Text> valore, o
          cursore sul testo · <Text color="yellow">^A/^E</Text> inizio/fine ·{' '}
          <Text color="yellow">^D</Text> canc · <Text color="yellow">⏎</Text> salva+commit ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {keyLegend}
        </Text>
      )}
      {/* T43 — riga delle surface: prima le due built-in (`t`/`c`), poi la mappa
          indice→launch del progetto. Presente in tutta la modalità normale, non
          più solo con voci configurate: `t` e `c` esistono ovunque, quindi la
          riga non è mai vuota. */}
      {mode === 'normal' ? (
        <Text dimColor wrap="truncate-end">
          {surfaceLegend}
          {legend.shown ? ` · ${legend.shown}` : ''}
          {legend.overflow > 0 ? (
            <Text color="yellow"> · +{legend.overflow} fuori riga</Text>
          ) : null}
          {legend.unreachable > 0 ? (
            <Text color="yellow"> · {legend.unreachable} oltre la 9ª (non raggiungibili)</Text>
          ) : null}
        </Text>
      ) : null}
      {mode === 'create' ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">C › </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {/* T53 — gemello del box create. Il cursore sta in coda al testo (append
          only, come create): un cursore mobile vorrebbe gestire frecce e Home/End,
          e `Home`/`End` non sono nemmeno esposte da `useInput`. */}
      {mode === 'note' ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text color="yellow">✎ › </Text>
          <Text>{noteDraft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {mode === 'sort' ? <SortModal sort={view.sort} /> : null}
      {mode === 'filter' ? <FilterModal view={view} cursor={filterCursor} /> : null}
      {mode === 'edit' && edit && selTask ? (
        <EditModal id={selTask.id} draft={edit} row={editRow} columns={columns} />
      ) : null}
      <Box flexDirection="row" marginTop={1}>
        <TasksPane
          tasks={windowTasks}
          counts={taskCounts}
          activeView={taskViewId}
          paneCount={paneTasks.length}
          view={view}
          selected={selIndex}
          spotCount={spotCount}
          allCount={sessions.length}
          childCount={childCount}
          focused={focus === 'tasks'}
          loadError={loadError}
          windowStart={taskWin.start}
          above={taskWin.start}
          below={paneTasks.length - taskWin.end}
          columns={columns}
        />
        <SessionsPane
          parentLabel={parentLabel}
          isSpot={isSpot}
          isAll={isAll}
          bindings={bindings}
          taskW={sessionCols.task}
          ageW={sessionCols.age}
          rows={windowRows}
          counts={sessionCounts}
          activeView={sessionViewId}
          paneCount={sessionRows.length}
          selectedId={selSessionId ?? undefined}
          focused={focus === 'sessions'}
          above={sessionWin.start}
          below={sessionRows.length - sessionWin.end}
          columns={columns}
          forkOf={forkOf}
          sessionNotes={sessionNotes}
          projectCore={projectCore}
          live={live}
        />
      </Box>
      {/* T70 — blocco preview UNICO, a piena larghezza, sotto le due liste.
          Renderizzato solo con contenuto E spazio: `budget.preview` copre il
          secondo, `previewKind` il primo. */}
      {budget.preview && previewKind === 'task' && detail ? (
        <PreviewPane
          kind="task"
          detail={detail}
          maxLines={budget.detailLines}
          columns={columns}
        />
      ) : budget.preview && previewKind === 'session' && selSessionObj ? (
        <PreviewPane
          kind="session"
          s={selSessionObj}
          firstLines={budget.sessionFirstLines}
          lastLines={budget.sessionLastLines}
          columns={columns}
          origin={forkOf.get(selSessionObj.sessionId) ?? null}
          note={sessionNotes.get(selSessionObj.sessionId) ?? ''}
          live={live.get(selSessionObj.sessionId) ?? null}
        />
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} tasksDir={resolveTasksDir(cwd)} />);
