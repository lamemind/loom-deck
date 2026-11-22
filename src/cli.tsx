#!/usr/bin/env node
// Il deck: composizione e resa della schermata normale.
//
// Questo file NON contiene logica. È il cablaggio — chi parla con chi — più il
// `return` della lista, che è la schermata del deck e non avrebbe senso come
// componente con venti props e un chiamante solo.
//
// L'ordine delle chiamate è imposto dalle dipendenze, non dalla leggibilità:
//
//   modello  →  attuatore  →  overlay  →  geometria  →  input
//
// La geometria sta PRIMA dell'input (T131): il dispatch riceve `listGeometry`
// come valore, e prima di questo split la leggeva da una closure risolta solo
// all'arrivo dell'evento, cioè dopo la fine del render.
import { render, Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { resolveTasksPath, resolveTasksDir } from './tasks.js';
import { LAUNCH_SEP, docsRootName, launchDigitsOf } from './config.js';
import { anchorFrame, enableMouse } from './mouse.js';
import { sanitize } from './width.js';
import { MODEL_SHORT_LIST, modelAlias } from './glyphs.js';
import { MODEL_DEFAULT, MODELS } from './spawn-catalog.js';
import { loadPromptCatalog } from './prompt-catalog.js';
import { resolveSpawnId } from './spawn-config.js';
import { type Mode } from './model.js';
import {
  BARE_BUTTONS_WIDTH,
  BARE_LABEL,
  HEADER_BUTTON_SEP,
  frameGeometry,
  headlineText,
  headlineWidth,
  indicatorRow,
  launchRow,
  unreachableText,
} from './frame.js';
import { deckLegend, hintLegend } from './combo-catalog.js';
import { choiceButtons } from './ui/fields.js';
import { useDeckModel } from './deck-model.js';
import { useDeckActions } from './actions.js';
import { useDeckInput } from './input.js';
import { useSearchOverlay } from './overlays/search.js';
import { taskSheet, useSheetOverlay } from './overlays/sheet.js';
import { useAssignOverlay } from './overlays/assign.js';
import { useComboOverlay } from './overlays/combo.js';
import { useFinderOverlay } from './overlays/finder.js';
import { useWrapOverlay } from './overlays/wrap.js';
import { useSpawnPage } from './overlays/spawn.js';
import { useLaunchPage } from './overlays/launch.js';
import { useGitlink } from './overlays/gitlink.js';
import { useSpawnEndpoint } from './overlays/endpoint.js';
import { usePurgeOverlay } from './overlays/purge.js';
import { useDropOverlay } from './overlays/drop.js';
import { useTextModals, useViewModals } from './overlays/modals.js';
import { useTerminalSize, useSpawnConfig, useLaunchConfig } from './hooks.js';
import { DropModal, EditModal, FilterModal, PurgeModal, SortModal } from './ui/modals.js';
import { SessionsPane, TasksPane } from './ui/panes.js';
import { PreviewPane, detailMetaOf } from './ui/preview.js';
import { CompactNotice, HintBar, TextBox, screenFor } from './ui/screens.js';
import { VERSION } from './version.js';

function Deck({
  cwd,
  tasksPath,
  tasksDir,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
}) {
  // La riga di STATO in fondo al frame: il feedback dell'ultima azione. Non è
  // la nota di una conversazione, che nel modello si chiama `sessionNotes`.
  const [note, setNote] = useState('');
  // Modali: catturano i tasti e corto-circuitano la navigazione normale.
  const [mode, setMode] = useState<Mode>('normal');
  // Dimensioni vive del terminale: sono l'input del budget d'altezza.
  const { rows, columns } = useTerminalSize();

  // T161 — il catalogo dati dei prompt e gli override di progetto: i due
  // gradini del default di ogni azione di spawn. Si leggono una volta per vita
  // del deck e scendono a chi risolve la terna (l'attuatore, il detail) e a chi
  // la configura (la pagina), invece di essere riletti a ogni sede di chiamata.
  const catalog = useMemo(() => loadPromptCatalog(), []);
  const spawnConfig = useSpawnConfig({ cwd, setNote });
  // Il default risolto della nuda serve due volte: valore iniziale del
  // selettore e bottone sottolineato come «default». Da una sola risoluzione,
  // o il bottone marcato non sarebbe quello con cui `c` apre davvero.
  const bareDefault = resolveSpawnId('bare', spawnConfig.overrides, catalog).model;
  // T168 — le voci launch coi loro attributi, e il saver della pagina `^L`.
  // Lette qui e non nel modello, perché la pagina le riscrive e dopo `w` la
  // riga launch deve vedere il file com'è.
  const launchConfig = useLaunchConfig({ cwd, setNote });

  const model = useDeckModel({
    cwd,
    tasksPath,
    tasksDir,
    bareModel: bareDefault,
    launch: launchConfig.entries,
    setNote,
  });
  const actions = useDeckActions({
    cwd,
    tasksPath,
    tasksDir,
    columns,
    model,
    overrides: spawnConfig.overrides,
    catalog,
    setNote,
  });

  const assign = useAssignOverlay({
    viewTasks: model.viewTasks,
    rows,
    hasNote: Boolean(note),
    setMode,
    setNote,
    onSubmit: actions.assignSession,
  });

  const sheet = useSheetOverlay({
    rows,
    columns,
    setMode,
    setNote,
    // T161 — il detail chiede la terna per ID DI CATALOGO e task aperta; chi la
    // risolve è l'attuatore, che ha già in mano override, catalogo dati e i
    // fornitori dei buchi.
    defaults: actions.spawnTaskDefaults,
    onAction: actions.spawnForTask,
  });

  // T169 — il finder legge la lista GREZZA di tasks.md (`model.tasks`), non
  // `viewTasks`: trovare una task nascosta dai filtri è la sua ragione d'essere.
  // Sta dopo il detail perché `⏎` lo apre: stesso `Sheet` del `⏎` sul pane task
  // (`taskSheet`), col titolo lungo dal task file che la preview ha già letto.
  const finder = useFinderOverlay({
    tasks: model.tasks,
    tasksDir,
    rows,
    hasNote: Boolean(note),
    setMode,
    setNote,
    onOpen: (task, detail) => sheet.open(taskSheet(tasksDir, task, detail?.title)),
    onJump: model.jumpToTask,
  });

  const search = useSearchOverlay({
    sessions: model.sessions,
    rows,
    columns,
    hasNote: Boolean(note),
    setMode,
    setNote,
    // T148/D1 — nessun selettore nella ricerca: il modello è quello ereditato
    // dalla conversazione, senza superficie di scelta.
    // T184 — `openSession` come il `⏎` della lista: una viva va davanti, solo
    // una non viva si riprende.
    onResume: (row) =>
      actions.openSession(row.session.sessionId, modelAlias(row.session.model) ?? MODEL_DEFAULT),
  });

  // T134 — l'hard-wrap. Non è solo un overlay: i suoi numeri si leggono in
  // testata a schermata chiusa, e la lista è una delle sue superfici invece che
  // il suo contenuto.
  const wrap = useWrapOverlay({
    cwd,
    rows,
    setMode,
    setNote,
    onApply: actions.unwrapPath,
  });

  // T155 — il gitlink dei submodule. Secondo sensore con lo stato in vista
  // normale, dopo l'hard-wrap: qui però non c'è nessuna schermata da aprire —
  // l'unica superficie è l'indicatore, e l'unica azione committa.
  const gitlink = useGitlink({ cwd, setNote });
  // T196 — l'endpoint locale: le conversazioni del progetto chiedono qui gli
  // spawn (`loom-deck-spawn`), che partono dallo stesso `spawnForTask` del tasto.
  useSpawnEndpoint({ cwd, tasksPath, tasksDir, actions, setNote });

  // T161 — la pagina delle azioni di spawn. Come il detail e la lista hard-wrap
  // non esce dal deck da sé: qui riceve il saver degli override, e lo spawn che
  // quegli override governano parte da tutt'altra parte.
  const spawn = useSpawnPage({
    cwd,
    rows,
    hasNote: Boolean(note),
    overrides: spawnConfig.overrides,
    save: spawnConfig.save,
    catalog,
    setMode,
    setNote,
  });

  // T168 — la pagina delle voci launch e il motore che le lancia (startup,
  // scadenza, esito). Come l'hard-wrap il suo stato si legge in testata a
  // schermata chiusa: 🔄 mentre una voce gira, 🚨 su un exit non-zero.
  const launchPage = useLaunchPage({
    cwd,
    name: model.projectCore ?? model.projectName,
    entries: launchConfig.entries,
    save: launchConfig.save,
    rows,
    columns,
    hasNote: Boolean(note),
    setMode,
    setNote,
  });

  const purge = usePurgeOverlay({
    setMode,
    setNote,
    draftFor: actions.purgeDraftFor,
    onSubmit: actions.purgeTasks,
  });

  const drop = useDropOverlay({
    setMode,
    setNote,
    draftFor: actions.dropDraftFor,
    onSubmit: actions.dropSession,
  });

  const viewModals = useViewModals({
    view: model.view,
    setView: model.setView,
    hiddenTasks: model.hiddenTasks,
    setMode,
    setNote,
  });

  const textModals = useTextModals({
    setMode,
    setNote,
    onCreate: actions.createTask,
    onNote: actions.writeNote,
    onEdit: actions.writeEdit,
    editDraftFor: actions.editDraftFor,
    currentNote: (sid) => model.sessionNotes.get(sid) ?? '',
  });

  // T194 — il modale delle combo. Le voci gli arrivano all'apertura, dal dispatch:
  // dipendono dalla geometria, che qui sotto si calcola dopo gli overlay.
  const combo = useComboOverlay({ rows, columns, setMode, setNote });

  const overlays = {
    assign,
    combo,
    finder,
    sheet,
    search,
    wrap,
    spawn,
    launch: launchPage,
    gitlink,
    purge,
    drop,
    view: viewModals,
    text: textModals,
  };

  // T70 — un solo blocco preview, sotto i due pane, e il FOCUS decide cosa
  // contiene: a sinistra la task selezionata, a destra la conversazione. È il
  // focus e non la selezione perché il blocco è uno — averne due significava
  // pagare due cornici per mostrare contemporaneamente il dettaglio di una cosa
  // che si sta guardando e di una che non si sta guardando.
  // `none` quando non c'è contenuto (riga meta selezionata, task file assente,
  // pin stale): il blocco sparisce del tutto, non resta una cornice vuota.
  const previewKind =
    model.focus === 'tasks'
      ? model.detail
        ? ('task' as const)
        : ('none' as const)
      : model.selSessionObj
        ? ('session' as const)
        : ('none' as const);
  const detailParts = model.detail ? detailMetaOf(model.detail) : null;

  const launch = launchRow(model.launch, columns);
  // T154 — i bottoni del blocco selettore della nuda: stessa primitiva
  // (`choiceButtons`) del selettore di resume/fork, sulle SHORT (D1) e con
  // `avail` pari alla larghezza naturale del gruppo, così `cutParts` non
  // taglia mai (il blocco è riservato, non conteso — vedi `launchRow`).
  const bareButtons = choiceButtons(
    MODEL_SHORT_LIST,
    MODELS.indexOf(model.bareModel),
    BARE_BUTTONS_WIDTH,
    MODELS.indexOf(bareDefault),
  );
  // T134 — gli indicatori ancorati a destra della riga legenda. Si compongono
  // PRIMA della legenda perché è la loro larghezza a decidere quanto ne resta:
  // hanno la precedenza sul budget (D5 preflight).
  const indicators = indicatorRow(
    {
      // T168 — `null` quando tutto è verde: il glifo compare solo con una voce
      // in corso o rossa (P23).
      launch: launchPage.indicator,
      // T155 — `null` chiude il gate: su un progetto senza `.gitmodules` il
      // segmento non esiste, e la riga legenda si riprende quelle colonne.
      gitlink: gitlink.enabled
        ? {
            count: gitlink.count,
            attention: gitlink.attention,
            scanned: gitlink.scanned,
            ok: gitlink.ok,
            failed: gitlink.failed,
            available: gitlink.available,
          }
        : null,
      wrap: {
        count: wrap.count,
        mtime: wrap.mtime,
        ok: wrap.ok,
        scanning: wrap.scanning,
        available: wrap.available,
      },
    },
    columns,
  );
  const frame = frameGeometry({
    rows,
    columns,
    mode,
    hasNote: Boolean(note),
    previewKind,
    detailMetaLines: detailParts?.metaLines ?? 0,
    sessionHasFirstPreview:
      previewKind === 'session' && Boolean(model.selSessionObj?.customTitle),
    sessionHasLastPreview: previewKind === 'session' && Boolean(model.selSessionObj?.lastReply),
    paneTasks: model.paneTasks,
    selIndex: model.selIndex,
    sessionRows: model.sessionRows,
    selSessionId: model.selSessionId,
    taskCounts: model.taskCounts,
    taskViewId: model.taskViewId,
    sessionCounts: model.sessionCounts,
    sessionViewId: model.sessionViewId,
    parentLabel: model.parentLabel,
    hasLoadError: Boolean(model.loadError),
    restoreCount: model.restorable.length,
  });
  const legend = deckLegend({
    purgeBulk: model.purgeBulk,
    gitlink: gitlink.enabled,
    restore: frame.headerButton !== null,
    launchDigits: launchDigitsOf(model.launch),
  });

  useDeckInput({
    tasksDir,
    mode,
    setMode,
    setNote,
    model,
    actions,
    overlays,
    frame,
    launchRegions: launch.regions,
    indicatorRegions: indicators.regions,
    comboLegend: legend,
  });

  // Le sei schermate sostitutive prendono il frame intero: se una è attiva
  // il render finisce qui, e il budget dei pane resta calcolato ma inutilizzato.
  const screen = screenFor({
    mode,
    rows,
    columns,
    note,
    sessions: model.sessions,
    bindings: model.bindings,
    pinned: model.pinned,
    sessionNotes: model.sessionNotes,
    projectCore: model.projectCore,
    taskRowData: model.taskRowData,
    hiddenTasks: model.hiddenTasks,
    overlays: {
      assign,
      combo,
      finder,
      sheet,
      search,
      wrap,
      spawn,
      launch: launchPage,
    },
  });
  if (screen) return screen;

  // Sotto la soglia minima il layout a box non entra a nessun costo: si scende
  // a una riga sola. Perdere il deck per un terminale basso è meglio che
  // sporcare la cronologia del terminale a ogni poll.
  if (frame.budget.compact) {
    return (
      <CompactNotice
        dot={false}
        what={`v${VERSION} · ${model.viewTasks.length} task · sel ${
          model.selectedTaskId ?? model.parentLabel
        }`}
        rows={rows}
        columns={columns}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Riga di testata: nome del progetto a sinistra, versione ancorata a
          destra. È una riga full-width come la riga dei pane — `space-between`
          la riempie fino al bordo, quindi il gate di `frame-width*.test.ts`
          continua a misurare esattamente `columns`.
          Il nome è quello del file config quando c'è, la cartella altrimenti:
          la testata deve dire di quale progetto parla anche su un checkout non
          ancora registrato. Il nome del programma resta fuori dalla cornice:
          sta nel fallback compatto e nel titolo della tab Ptyxis, che sono i
          due posti dove serve a identificare cosa si sta guardando. Il nome
          riceve il budget già scalato del segmento destro (risoluzione +
          versione), o `space-between` lo lascerebbe crescere fin dentro. */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">
          {headlineText(model.projectCore ?? model.projectName, headlineWidth(columns, frame.headerBlock))}
        </Text>
        {/* T181 — il bottone di restore sta nello stesso blocco di destra,
            prima di risoluzione e versione: un `Box` coi due `Text` fratelli e
            non un `Text` che li annida, perché un `Text` di `Text` non si
            stira alla larghezza del box (misurato su `IndicatorRow`). Il budget
            a sinistra sottrae l'intero blocco (`headerBlock`). */}
        {frame.headerButton ? (
          <Box flexDirection="row">
            <Text color="yellow" bold>
              {frame.headerButton}
            </Text>
            <Text dimColor>
              {HEADER_BUTTON_SEP}
              {frame.headerRight}
            </Text>
          </Box>
        ) : (
          <Text dimColor>{frame.headerRight}</Text>
        )}
      </Box>
      <HintBar
        mode={mode}
        purge={purge.draft}
        keyLegend={hintLegend({ restore: frame.headerButton !== null })}
        indicators={indicators}
        columns={columns}
      />
      {/* T43 — riga delle surface: la built-in `t`, poi la mappa indice→launch
          del progetto. Presente in tutta la modalità normale, non più solo
          con voci configurate: `t` esiste ovunque, quindi la riga non è mai
          vuota. T154/P9 — il blocco selettore della nuda (`c`) sta ANCORATO A
          DESTRA sulla stessa riga: il filler già calcolato da `launchRow`
          rende la riga un `<Text>` unico (P5), niente `Box space-between`. */}
      {frame.launchLine ? (
        <Text dimColor wrap="truncate-end">
          {launch.segments.map((s) => s.text).join(LAUNCH_SEP)}
          {launch.overflow > 0 ? (
            <Text color="yellow"> · +{launch.overflow} fuori riga</Text>
          ) : null}
          {launch.unreachable > 0 ? (
            <Text color="yellow">{unreachableText(launch.unreachable)}</Text>
          ) : null}
          {launch.filler}
          {BARE_LABEL.text}{' '}
          {bareButtons.nodes}
        </Text>
      ) : null}
      {mode === 'create' ? <TextBox glyph="C" value={textModals.draft} /> : null}
      {/* T53 — gemello del box create. Il cursore sta in coda al testo (append
          only, come create): un cursore mobile vorrebbe gestire frecce e Home/End,
          e `Home`/`End` non sono nemmeno esposte da `useInput`. */}
      {mode === 'note' ? <TextBox glyph="✎" value={textModals.noteDraft} /> : null}
      {mode === 'sort' ? <SortModal sort={model.view.sort} /> : null}
      {mode === 'filter' ? (
        <FilterModal view={model.view} cursor={viewModals.filterCursor} />
      ) : null}
      {mode === 'edit' && textModals.edit && textModals.editTask ? (
        <EditModal
          id={textModals.editTask.id}
          draft={textModals.edit}
          row={textModals.editCursor.row}
          caret={textModals.editCursor.caret}
          columns={columns}
        />
      ) : null}
      {mode === 'purge' && purge.draft ? (
        <PurgeModal draft={purge.draft} columns={columns} />
      ) : null}
      {mode === 'drop' && drop.draft ? <DropModal draft={drop.draft} columns={columns} /> : null}
      <Box flexDirection="row" marginTop={1}>
        <TasksPane
          tasks={frame.windowTasks}
          counts={model.taskCounts}
          activeView={model.taskViewId}
          paneCount={model.paneTasks.length}
          view={model.view}
          selected={model.selIndex}
          spotCount={model.spotCount}
          allCount={model.sessions.length}
          idW={model.taskCols.id}
          tailW={model.taskCols.tail}
          focused={model.focus === 'tasks'}
          loadError={model.loadError}
          windowStart={frame.taskWin.start}
          above={frame.taskWin.start}
          below={model.paneTasks.length - frame.taskWin.end}
          columns={columns}
          data={model.taskRowData}
          blockMark={model.blockMark}
        />
        <SessionsPane
          parentLabel={model.parentLabel}
          isSpot={model.isSpot}
          isAll={model.isAll}
          bindings={model.bindings}
          taskW={model.sessionCols.task}
          ageW={model.sessionCols.age}
          rows={frame.windowRows}
          counts={model.sessionCounts}
          activeView={model.sessionViewId}
          paneCount={model.sessionRows.length}
          selectedId={model.selSessionId ?? undefined}
          focused={model.focus === 'sessions'}
          above={frame.sessionWin.start}
          below={model.sessionRows.length - frame.sessionWin.end}
          columns={columns}
          forkOf={model.forkOf}
          sessionNotes={model.sessionNotes}
          sessionPriority={model.sessionPriority}
          projectCore={model.projectCore}
          live={model.live}
          headless={model.headless}
        />
      </Box>
      {/* T70 — blocco preview UNICO, a piena larghezza, sotto le due liste.
          Renderizzato solo con contenuto E spazio: `budget.preview` copre il
          secondo, `previewKind` il primo. */}
      {frame.budget.preview && previewKind === 'task' && model.detail ? (
        <PreviewPane
          kind="task"
          detail={model.detail}
          maxLines={frame.budget.detailLines}
          columns={columns}
        />
      ) : frame.budget.preview && previewKind === 'session' && model.selSessionObj ? (
        <PreviewPane
          kind="session"
          s={model.selSessionObj}
          firstLines={frame.budget.sessionFirstLines}
          lastLines={frame.budget.sessionLastLines}
          columns={columns}
          origin={model.forkOf.get(model.selSessionObj.sessionId) ?? null}
          note={model.sessionNotes.get(model.selSessionObj.sessionId) ?? ''}
          live={model.live.get(model.selSessionObj.sessionId) ?? null}
          headless={model.headless.get(model.selSessionObj.sessionId) ?? null}
          resumeModel={model.resumeModel}
        />
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
// T175 — la docs-root si risolve QUI, una volta: i path di `tasks.md` e dei
// task file devono nascere dalla stessa cartella, e due risoluzioni potrebbero
// non vederla.
const docsRoot = docsRootName(cwd);
// T116 — `exitOnCtrlC: false` toglie a Ink l'uscita immediata su `^C`: senza,
// il tasto non arriverebbe mai a `useInput` e il doppio colpo non sarebbe
// osservabile. In raw mode `^C` non è un SIGINT — è il byte `\x03` nello
// stream di input, e chi lo consuma per primo decide. Da qui in poi lo consuma
// il deck, quindi l'uscita è tutta a carico del suo handler.
// T21 — l'ordine dei tre passi è vincolante. `anchorFrame` va PRIMA del render:
// pinna il frame a riga 1 e con lui l'origine dell'hit-test, che senza sarebbe
// la posizione casuale del cursore all'avvio del processo. `enableMouse`
// registra il ripristino del tracking sulle vie d'uscita, quindi prima che
// esista qualcosa da cui uscire.
anchorFrame();
enableMouse();
render(
  <Deck
    cwd={cwd}
    tasksPath={resolveTasksPath(cwd, docsRoot)}
    tasksDir={resolveTasksDir(cwd, docsRoot)}
  />,
  { exitOnCtrlC: false },
);
