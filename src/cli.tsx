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
import { useState } from 'react';
import { resolveTasksPath, resolveTasksDir } from './tasks.js';
import { LAUNCH_SEP } from './config.js';
import { anchorFrame, enableMouse } from './mouse.js';
import { sanitize } from './width.js';
import { type Mode } from './model.js';
import { deckLegend, frameGeometry, headlineWidth, launchRow } from './frame.js';
import { useDeckModel } from './deck-model.js';
import { useDeckActions } from './actions.js';
import { useDeckInput } from './input.js';
import { useSearchOverlay } from './overlays/search.js';
import { useSheetOverlay } from './overlays/sheet.js';
import { useAssignOverlay } from './overlays/assign.js';
import { useProjectStatus } from './overlays/status.js';
import { usePurgeOverlay } from './overlays/purge.js';
import { useTextModals, useViewModals } from './overlays/modals.js';
import { useTerminalSize } from './hooks.js';
import { EditModal, FilterModal, PurgeModal, SortModal } from './ui/modals.js';
import { StatusHeadline } from './ui/status-screen.js';
import { SessionsPane, TasksPane } from './ui/panes.js';
import { PreviewPane, detailMetaOf } from './ui/preview.js';
import { CompactNotice, HintBar, TextBox, screenFor } from './ui/screens.js';
import { VERSION } from './version.js';

function Deck({ cwd, tasksPath, tasksDir }: { cwd: string; tasksPath: string; tasksDir: string }) {
  // La riga di STATO in fondo al frame: il feedback dell'ultima azione. Non è
  // la nota di una conversazione, che nel modello si chiama `sessionNotes`.
  const [note, setNote] = useState('');
  // Modali: catturano i tasti e corto-circuitano la navigazione normale.
  const [mode, setMode] = useState<Mode>('normal');
  // Dimensioni vive del terminale: sono l'input del budget d'altezza.
  const { rows, columns } = useTerminalSize();

  const model = useDeckModel({ cwd, tasksPath, tasksDir, setNote });
  const actions = useDeckActions({ cwd, tasksPath, tasksDir, columns, model, setNote });

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
    onAction: actions.spawnForTask,
  });

  const search = useSearchOverlay({
    sessions: model.sessions,
    rows,
    columns,
    hasNote: Boolean(note),
    setMode,
    setNote,
    onResume: (row) => actions.resumeSession(row.session.sessionId),
  });

  // T121 — il project status. Non è solo un overlay come i tre sopra: il suo
  // stato si legge in TESTATA a schermata chiusa, e il viewer è una delle sue
  // superfici invece che il suo contenuto.
  // Il nome è quello del file config quando c'è, la cartella altrimenti: la
  // testata deve dire di quale progetto parla anche su un checkout non ancora
  // registrato.
  const status = useProjectStatus({
    cwd,
    name: model.projectCore ?? model.projectName,
    rows,
    columns,
    setMode,
    setNote,
  });

  const purge = usePurgeOverlay({
    setMode,
    setNote,
    draftFor: actions.purgeDraftFor,
    onSubmit: actions.purgeTasks,
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

  const overlays = { assign, sheet, search, status, purge, view: viewModals, text: textModals };

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
  });

  // Le cinque schermate sostitutive prendono il frame intero: se una è attiva
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
    projectName: model.projectName,
    taskRowData: model.taskRowData,
    hiddenTasks: model.hiddenTasks,
    overlays: { assign, sheet, search, status },
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
      {/* Riga di testata: project status a sinistra, versione ancorata a
          destra. È una riga full-width come la riga dei pane — `space-between`
          la riempie fino al bordo, quindi il gate di `frame-width.test.ts`
          continua a misurare esattamente `columns`.
          T121/D1 — il nome del programma esce dalla cornice: resta nel fallback
          compatto e nel titolo della tab Ptyxis, che sono i due posti dove
          serve davvero a identificare cosa si sta guardando. Il blocco status
          riceve il budget già scalato del segmento destro (risoluzione +
          versione), o `space-between` lo lascerebbe crescere fin dentro. */}
      <Box flexDirection="row" justifyContent="space-between">
        <StatusHeadline
          name={model.projectCore ?? model.projectName}
          label={status.label}
          building={status.building}
          failed={status.failed}
          cols={headlineWidth(columns, frame.headerRight)}
        />
        <Text dimColor>{frame.headerRight}</Text>
      </Box>
      <HintBar
        mode={mode}
        purge={purge.draft}
        keyLegend={deckLegend({
          focus: model.focus,
          hasTask: model.selTask !== null,
          hasSession: model.selSessionObj !== null,
          hasSessionId: model.selSessionId !== null,
          purgeBulk: model.purgeBulk,
        })}
      />
      {/* T43 — riga delle surface: prima le due built-in (`t`/`c`), poi la mappa
          indice→launch del progetto. Presente in tutta la modalità normale, non
          più solo con voci configurate: `t` e `c` esistono ovunque, quindi la
          riga non è mai vuota. */}
      {frame.launchLine ? (
        <Text dimColor wrap="truncate-end">
          {launch.segments.map((s) => s.text).join(LAUNCH_SEP)}
          {launch.overflow > 0 ? (
            <Text color="yellow"> · +{launch.overflow} fuori riga</Text>
          ) : null}
          {launch.unreachable > 0 ? (
            <Text color="yellow"> · {launch.unreachable} oltre la 9ª (non raggiungibili)</Text>
          ) : null}
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
          projectCore={model.projectCore}
          live={model.live}
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
        />
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

const cwd = process.cwd();
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
render(<Deck cwd={cwd} tasksPath={resolveTasksPath(cwd)} tasksDir={resolveTasksDir(cwd)} />, {
  exitOnCtrlC: false,
});
