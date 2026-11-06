// T168 — la pagina delle voci launch: la tabella a due righe per voce, e il
// log di una voce a tutto schermo.
import { Box, Text } from 'ink';
import { cut, pad, sanitize, termWidth, type WrappedLine } from '../width.js';
import { CARET, CARET_OFF, fmtTime } from '../glyphs.js';
import { launchEnabled, launchShown, type LaunchEntry, type LaunchSlot } from '../config.js';
import { launchRunning, type LaunchRecord } from '../launch-run.js';
import type { LaunchField } from '../overlays/launch.js';

/** Le spunte: concordi nelle due contabilità di larghezza (`agrees`), quindi
 *  `sanitize` le lascia passare — `✔`/`✖` diventerebbero i gemelli larghi 2. */
const ON = '✓';
const OFF = '✗';

/** Tetto della colonna nome (`cifra emoji label`): oltre, al comando resta
 *  troppo poco su un terminale normale. */
const NAME_MAX = 24;

/** Larghezza della cella `every`: `180m` è la forma più lunga sensata. */
const EVERY_W = 5;

/** L'esito di una voce, in una riga: `mai`, in corso, o exit e ora. */
export function launchOutcome(
  e: LaunchEntry,
  rec: LaunchRecord | null,
): { text: string; color?: string; dim: boolean } {
  if (!e.capture) return { text: '', dim: true };
  if (!rec) return { text: 'mai', dim: true };
  if (launchRunning(rec)) return { text: `in corso da ${fmtTime(rec.startedAt)}`, color: 'yellow', dim: false };
  if (rec.exit === null) return { text: `avviata ${fmtTime(rec.startedAt)}, esito perso`, color: 'yellow', dim: false };
  return {
    text: `exit ${rec.exit} · ${fmtTime(rec.endedAt ?? rec.startedAt)}`,
    color: rec.exit === 0 ? 'green' : 'red',
    dim: false,
  };
}

function Flag({ label, on, focused }: { label: string; on: boolean; focused: boolean }) {
  return (
    <>
      <Text dimColor>{label} </Text>
      <Text inverse={focused} color={on ? 'green' : 'red'}>
        {on ? ON : OFF}
      </Text>
    </>
  );
}

export function LaunchScreen({
  table,
  records,
  slots,
  sel,
  top,
  capacity,
  field,
  dirty,
  available,
  columns,
  note,
}: {
  /** La bozza intera, non la sola finestra. */
  table: LaunchEntry[];
  records: Map<string, LaunchRecord | null>;
  /** Le cifre delle voci VIVE: la bozza può averle spostate, e lo si vede
   *  solo dopo `w`. */
  slots: LaunchSlot[];
  sel: number;
  top: number;
  capacity: number;
  field: LaunchField | null;
  dirty: boolean;
  available: boolean;
  columns: number;
  note: string;
}) {
  const width = Math.max(20, (columns || 80) - 4);
  const digitOf = new Map(slots.map((s) => [s.entry.index, s.digit]));
  const nameOf = (e: LaunchEntry) => `${digitOf.get(e.index) ?? ' '} ${e.emoji} ${e.label}`;
  const nameW = Math.min(NAME_MAX, Math.max(4, ...table.map((e) => termWidth(nameOf(e)))));
  // `- 4` = bordo + padding del box tabella; `header ✓` = 8 celle più i due
  // separatori: il comando prende il resto, pavimento 0 (invariante ③ di
  // width.ts).
  const cmdW = Math.max(0, width - 4 - CARET_OFF.length - nameW - 2 - 8 - 2);
  const shown = table.slice(top, top + capacity);
  const inRow = table.filter(launchShown).length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">voci launch</Text>{' '}
        <Text dimColor>
          · {table.length} voc{table.length === 1 ? 'e' : 'i'} · {inRow} in riga
        </Text>
        {dirty ? <Text color="yellow"> · modifiche non salvate</Text> : null}
        {!available ? <Text color="yellow"> · lancio n/d su questa piattaforma</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> voce · <Text color="yellow">⏎</Text> lancia ·{' '}
        <Text color="yellow">l</Text> log · <Text color="yellow">tab</Text> campo ·{' '}
        <Text color="yellow">spazio</Text> alterna · <Text color="yellow">w</Text> salva ·{' '}
        <Text color="yellow">esc</Text> {field !== null ? 'torna alla riga' : 'chiude'}
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {table.length === 0 ? (
          <Text dimColor wrap="truncate-end">
            nessuna voce launch: aggiungile in .claude/loom-works.json
          </Text>
        ) : null}
        {shown.map((e, i) => {
          const at = top + i;
          const current = at === sel;
          const off = !launchEnabled(e);
          const rec = e.slug ? records.get(e.slug) ?? null : null;
          const outcome = launchOutcome(e, rec);
          const focus = (f: LaunchField) => current && field === f;
          return (
            <Box key={e.index ?? at} flexDirection="column">
              <Text wrap="truncate-end">
                {current ? CARET : CARET_OFF}
                <Text bold={current} dimColor={off}>
                  {pad(cut(nameOf(e), nameW), nameW)}
                </Text>
                {'  '}
                <Flag label="header" on={e.header !== false} focused={focus('header')} />
                {'  '}
                <Text dimColor={off}>{cut(sanitize(e.command), cmdW)}</Text>
              </Text>
              <Text wrap="truncate-end">
                {CARET_OFF}
                {' '.repeat(nameW)}
                {'  '}
                <Flag label="capture" on={Boolean(e.capture)} focused={focus('capture')} />
                {'  '}
                <Flag label="startup" on={Boolean(e.startup)} focused={focus('startup')} />
                {'  '}
                <Text dimColor>every </Text>
                <Text inverse={focus('every')} color={e.every && e.intervalMs === null ? 'red' : undefined}>
                  {pad(e.every ?? '-', EVERY_W)}
                </Text>
                {'  '}
                {off ? (
                  <Text color="yellow">spenta</Text>
                ) : (
                  <Text color={outcome.color} dimColor={outcome.dim}>
                    {outcome.text}
                  </Text>
                )}
              </Text>
            </Box>
          );
        })}
      </Box>
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

/** Il log di una voce: testo grezzo, scorrevole, come il viewer del project
 *  status senza il markdown. */
export function LaunchLogScreen({
  entry,
  record,
  lines,
  top,
  total,
  capacity,
}: {
  entry: LaunchEntry;
  record: LaunchRecord | null;
  /** Solo la finestra visibile del testo wrappato. */
  lines: WrappedLine[];
  top: number;
  total: number;
  capacity: number;
}) {
  const last = Math.min(total, top + capacity);
  const outcome = launchOutcome(entry, record);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">{sanitize(`${entry.emoji} ${entry.label}`)}</Text>
        <Text dimColor> :: LOG </Text>
        <Text color={outcome.color} dimColor={outcome.dim}>
          [ {outcome.text || 'nessun esito'} ]
        </Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitize(cut(entry.command, 80))} · righe {total === 0 ? 0 : top + 1}-{last} di {total}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">PgUp/PgDn</Text> ½ pagina ·{' '}
        <Text color="yellow">g/G</Text> estremi · <Text color="yellow">esc</Text> torna alla pagina
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {lines.map((l, i) => (
          <Text key={top + i} wrap="truncate-end">
            {sanitize(l.text)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
