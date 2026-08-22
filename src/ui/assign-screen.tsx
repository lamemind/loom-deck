// Schermata di assegnazione conversazione → task (T57).
import { Box, Text } from 'ink';
import { cut, sanitize } from '../width.js';
import { assignTextWidth } from '../layout.js';
import { CARET, CARET_OFF } from '../glyphs.js';
import { TaskRow } from './task-row.js';
import type { TaskRowData } from '../view.js';
import type { Task } from '../tasks.js';

/**
 * Schermata di assegnazione di una conversazione a una task (T57).
 *
 * Fullscreen sostitutiva (D3) come la ricerca: la lista task non entra in un
 * box sopra i due pane. Da lì discende che l'oggetto dell'azione — la sessione
 * selezionata, che non è più a schermo — va ripetuto nel titolo.
 *
 * L'header della lista conta le task escluse dai filtri della vista (D4): la
 * scelta di mostrare `viewTasks` e non tutte le task ha come prezzo noto che un
 * filtro può nascondere proprio il bersaglio, e quel prezzo non deve essere
 * silenzioso — stessa convenzione del `+N più vecchie` del pane sessioni.
 */
export function AssignScreen({
  sessionId,
  label,
  current,
  filter,
  rows,
  selected,
  matched,
  hidden,
  above,
  below,
  idW,
  tailW,
  data,
  columns,
  note,
}: {
  sessionId: string;
  /** Nota umana o etichetta derivata; '' = solo l'hash (pinnata stale). */
  label: string;
  /** Task a cui la sessione è legata ORA; null = spot. */
  current: string | null;
  filter: string;
  /** Solo la finestra visibile: `null` = riga detach. */
  rows: Array<Task | null>;
  /** Task selezionata; `null` = riga detach. */
  selected: string | null;
  /** Task che passano il filtro (detach escluso). */
  matched: number;
  /** Task fuori dai filtri della VISTA (non del campo di questo modale). */
  hidden: number;
  above: number;
  below: number;
  /** T124 — le stesse due colonne del pane task, misurate sulla lista filtrata
   *  di QUESTA schermata: la popolazione è un'altra, il criterio no. */
  idW: number;
  tailW: number;
  data: TaskRowData;
  columns: number;
  note: string;
}) {
  const width = assignTextWidth(columns);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      {/* `↑↓` non è in legenda: la navigazione è universale in qualunque TUI e
          qui le colonne servono a dire su COSA si sta agendo — l'unica cosa che
          la schermata sostitutiva ha tolto da sotto gli occhi. */}
      <Text dimColor wrap="truncate-end">
        assegna <Text color="cyan">{sessionId.slice(0, 8)}</Text>
        {label ? ` «${cut(sanitize(label), Math.max(10, Math.floor(width / 4)))}»` : ''} · ora{' '}
        {current ? <Text color="green">{current}</Text> : 'spot'} · <Text color="yellow">⏎</Text>{' '}
        assegna · <Text color="yellow">^U</Text> pulisci · <Text color="yellow">esc</Text> annulla
      </Text>
      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>filtro </Text>
          <Text color="yellow">{cut(filter, Math.max(8, width - 24))}</Text>
          <Text inverse> </Text>
          {!filter ? <Text dimColor>  (id o titolo)</Text> : null}
        </Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {matched} task
          {hidden > 0 ? <Text color="yellow"> · +{hidden} fuori dai filtri</Text> : null}
          {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
          {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
        </Text>
        {rows.map((task) => {
          // T57/D2 — `detach` è una VOCE della lista, non un tasto a parte: un
          // solo gesto (`A`), un solo modale. Speculare alla riga meta `spot`
          // del pane task, e nominata con l'AZIONE («detach») invece che con lo
          // stato d'arrivo — è ciò che si sta per fare.
          if (!task) {
            const sel = selected === null;
            // Le colonne fisse (caret + `○ detach` + i due spazi) sono 12: solo
            // la glossa si taglia, così su un terminale stretto resta comunque
            // il nome dell'azione invece di un moncone di frase.
            return (
              <Text key="detach" inverse={sel} wrap="truncate-end">
                {sel ? CARET : CARET_OFF}
                ○ detach  {cut('la sessione torna spot', width - 12)}
              </Text>
            );
          }
          // T124 — la riga è la STESSA del pane task, non più una copia
          // ricomposta qui: id paddato alla colonna, coda ancorata al bordo
          // destro, marker dirty ed evidenze della liveness arrivano tutti dal
          // componente condiviso. `focused` è sempre vero — una schermata
          // sostitutiva non cede il fuoco a nessun altro pane.
          return (
            <TaskRow
              key={task.id}
              task={task}
              sel={selected === task.id}
              focused
              width={width}
              idW={idW}
              tailW={tailW}
              data={data}
            />
          );
        })}
      </Box>
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}
