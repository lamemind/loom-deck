// Schermata del finder delle task (T169): campo, lista di tutte le righe di
// `tasks.md` e preview della task selezionata.
//
// Sostitutiva come l'assegnazione, da cui prende la forma — un campo di una riga
// sopra una lista di `TaskRow` — e per la stessa ragione: una lista ad altezza
// variabile non entra in un modale in flusso, che ha un'altezza fissa per modo.
//
// Direzione della dipendenza: come `screens.tsx`, importa il TIPO di ritorno
// dell'hook del proprio overlay, mai il modulo a runtime.
import { Box, Text } from 'ink';
import { cut, sanitize } from '../width.js';
import { assignTextWidth } from '../layout.js';
import { windowRange } from '../viewport.js';
import { taskColumns, type TaskRowData } from '../view.js';
import { PreviewPane, detailMetaOf } from './preview.js';
import { TaskRow } from './task-row.js';
import type { FinderQuery } from '../finder.js';
import type { Task, TaskDetail } from '../tasks.js';
import type { useFinderOverlay } from '../overlays/finder.js';

type FinderOverlay = ReturnType<typeof useFinderOverlay>;

/**
 * La schermata già finestrata: sceglie quali righe stanno a schermo e se la
 * preview entra, poi rende. Vive qui e non in `screenFor` perché le derivazioni
 * sono solo sue — `screenFor` sceglie la schermata, non la compone. Il ripiego
 * del terminale troppo basso resta a `screenFor`, che ha già `CompactNotice`:
 * importarlo da qui chiuderebbe un ciclo fra i due file.
 */
export function finderScreen({
  finder,
  columns,
  note,
  taskRowData,
}: {
  finder: FinderOverlay;
  columns: number;
  note: string;
  taskRowData: TaskRowData;
}) {
  const { layout, result } = finder;
  const list = result.tasks;
  const at = list.findIndex((t) => t.id === finder.sel);
  const win = windowRange(list.length, at, layout.list);
  // Le colonne si misurano sulla lista INTERA del finder, non sulla finestra né
  // sul pane: stessa regola della schermata di assegnazione (T124), e per la
  // stessa ragione — una larghezza derivata dalle righe a schermo sposta le
  // colonne a ogni scroll.
  const cols = taskColumns(list, taskRowData);
  return (
    <FinderScreen
      query={finder.query}
      kind={result.query}
      rows={list.slice(win.start, win.end)}
      selected={finder.sel}
      matched={list.length}
      above={win.start}
      below={list.length - win.end}
      idW={cols.id}
      tailW={cols.tail}
      data={taskRowData}
      mark={finder.mark}
      selTask={finder.selTask}
      preview={layout.preview}
      detail={finder.detail}
      columns={columns}
      note={note}
    />
  );
}

function FinderScreen({
  query,
  kind,
  rows,
  selected,
  matched,
  above,
  below,
  idW,
  tailW,
  data,
  mark,
  selTask,
  preview,
  detail,
  columns,
  note,
}: {
  query: string;
  kind: FinderQuery;
  /** Solo la finestra visibile. */
  rows: Task[];
  selected: string | null;
  /** Righe che passano la query: la lista intera, non la finestra. */
  matched: number;
  above: number;
  below: number;
  idW: number;
  tailW: number;
  data: TaskRowData;
  mark: string;
  selTask: Task | null;
  /** Righe riservate alla preview; `0` = blocco omesso. */
  preview: number;
  /** Il task file della selezionata; `null` = file assente. */
  detail: TaskDetail | null;
  columns: number;
  note: string;
}) {
  const width = assignTextWidth(columns);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        trova task · <Text color="yellow">↑↓</Text> naviga · <Text color="yellow">⏎</Text> detail ·{' '}
        <Text color="yellow">→</Text> conversazioni · <Text color="yellow">^U</Text> pulisci ·{' '}
        <Text color="yellow">esc</Text> chiudi
      </Text>
      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>task </Text>
          <Text color="yellow">{cut(query, Math.max(8, width - 24))}</Text>
          <Text inverse> </Text>
          {!query ? <Text dimColor>  (numero o titolo)</Text> : null}
        </Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <ListHeader kind={kind} matched={matched} above={above} below={below} width={width} />
        {rows.map((task) => (
          // `focused` sempre vero: una schermata sostitutiva non cede il fuoco a
          // nessun altro pane, come l'assegnazione.
          <TaskRow
            key={task.id}
            task={task}
            sel={selected === task.id}
            focused
            width={width}
            idW={idW}
            tailW={tailW}
            data={data}
            mark={mark}
          />
        ))}
      </Box>
      {preview > 0 && selTask ? (
        detail ? (
          // La descrizione prende ciò che titolo, meta e commit lasciano delle
          // righe riservate: il blocco non supera mai la riserva, quindi il
          // frame resta sotto `rows` qualunque task sia selezionata.
          <PreviewPane
            kind="task"
            detail={detail}
            maxLines={Math.max(0, preview - detailMetaOf(detail).metaLines)}
            columns={columns}
          />
        ) : (
          <MissingPreview task={selTask} columns={columns} />
        )
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

/** L'header dice sempre cosa la lista sta mostrando, e a lista vuota perché. */
function ListHeader({
  kind,
  matched,
  above,
  below,
  width,
}: {
  kind: FinderQuery;
  matched: number;
  above: number;
  below: number;
  width: number;
}) {
  if (matched === 0) {
    return (
      <Text color="yellow" wrap="truncate-end">
        {kind.kind === 'id'
          ? `nessuna task T${kind.digits}`
          : kind.kind === 'text'
            ? `nessun titolo contiene «${cut(kind.text, Math.max(8, width - 30))}»`
            : 'nessuna task in tasks.md'}
      </Text>
    );
  }
  return (
    <Text dimColor wrap="truncate-end">
      {matched} task{kind.kind === 'all' ? ' · tutte, viste e filtri ignorati' : ''}
      {above > 0 ? ` · ↑${above}` : ''}
      {below > 0 ? ` · ↓${below}` : ''}
    </Text>
  );
}

/**
 * La preview di una task il cui file manca: la riga di `tasks.md` basta a dire
 * quale task è, e la seconda riga dice perché il resto non c'è — un blocco che
 * sparisse lascerebbe la domanda «la preview è rotta?».
 */
function MissingPreview({ task, columns }: { task: Task; columns: number }) {
  const width = assignTextWidth(columns);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate-end">
        {task.id} {cut(task.desc, Math.max(8, width - task.id.length - 1))}
      </Text>
      <Text dimColor wrap="truncate-end">
        task file assente: c'è solo la riga di tasks.md
      </Text>
    </Box>
  );
}
