// T168 — la pagina delle voci launch: la tabella a due righe per voce, e il
// log di una voce a tutto schermo.
import { Box, Text } from 'ink';
import { cut, pad, sanitize, termWidth, type WrappedLine } from '../width.js';
import { CARET, CARET_OFF, fmtTime } from '../glyphs.js';
import { launchEnabled, launchShown, type LaunchEntry, type LaunchSlot } from '../config.js';
import {
  isNoOutcome,
  lastTrueRecord,
  launchRunning,
  type LaunchLogFile,
  type LaunchRecord,
} from '../launch-run.js';
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

export interface LaunchOutcomeText {
  text: string;
  color?: string;
  dim: boolean;
  /** T190 — l'ultimo tentativo senza esito, accanto all'esito vero, in grigio:
   *  è l'unica traccia di un comando che esce sempre con un codice `noOutcome`. */
  aside?: string;
}

/** L'esito di una voce, in una riga: `mai`, in corso, o exit e ora. Un giro
 *  senza esito non prende il posto dell'ultimo giro vero: gli si affianca. */
export function launchOutcome(e: LaunchEntry, rec: LaunchRecord | null): LaunchOutcomeText {
  if (!e.capture) return { text: '', dim: true };
  if (!rec) return { text: 'mai', dim: true };
  if (launchRunning(rec)) return { text: `in corso da ${fmtTime(rec.startedAt)}`, color: 'yellow', dim: false };
  if (rec.exit === null) return { text: `avviata ${fmtTime(rec.startedAt)}, esito perso`, color: 'yellow', dim: false };
  if (isNoOutcome(rec.exit, e.noOutcome)) {
    const aside = `senza esito: exit ${rec.exit} · ${fmtTime(rec.endedAt ?? rec.startedAt)}`;
    const truth = lastTrueRecord(rec, e.noOutcome);
    return truth ? { ...exitText(truth), aside } : { text: 'mai', dim: true, aside };
  }
  return exitText(rec);
}

function exitText(rec: LaunchRecord): LaunchOutcomeText {
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
                  <>
                    <Text color={outcome.color} dimColor={outcome.dim}>
                      {outcome.text}
                    </Text>
                    {outcome.aside ? <Text dimColor> · {outcome.aside}</Text> : null}
                  </>
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

/**
 * T258 — l'intestazione della schermata del log: il solo giro di cui si legge
 * il testo. Sul log del giro vero è il suo esito, `[ exit 1 · 14:30 ]`; sul log
 * di un tentativo senza esito è `tentativo · senza esito: exit 3 · 14:31`, mai
 * l'esito del giro vero, che quel testo non descrive. `trueLogMissing` dice
 * perché si legge il tentativo quando la riga mostra un giro vero: il suo log
 * non è su disco.
 */
export interface LaunchLogHeading {
  text: string;
  color?: string;
  dim: boolean;
  attempt: boolean;
  trueLogMissing: boolean;
}

export function launchLogHeading(
  e: LaunchEntry,
  rec: LaunchRecord | null,
  file: LaunchLogFile,
  alternate: boolean,
): LaunchLogHeading {
  if (rec && file === 'outcome') {
    const truth = lastTrueRecord(rec, e.noOutcome);
    if (truth) {
      const done = exitText(truth);
      return { ...done, text: `[ ${done.text} ]`, attempt: false, trueLogMissing: false };
    }
  }
  if (rec && rec.exit !== null && isNoOutcome(rec.exit, e.noOutcome)) {
    return {
      text: `tentativo · senza esito: exit ${rec.exit} · ${fmtTime(rec.endedAt ?? rec.startedAt)}`,
      dim: true,
      attempt: true,
      trueLogMissing: !alternate && rec.lastOutcome !== null,
    };
  }
  const outcome = launchOutcome(e, rec);
  return { text: `[ ${outcome.text || 'nessun esito'} ]`, color: outcome.color, dim: outcome.dim, attempt: false, trueLogMissing: false };
}

/** Il log di una voce: testo grezzo, scorrevole, come il viewer del project
 *  status senza il markdown. */
export function LaunchLogScreen({
  entry,
  record,
  file,
  alternate,
  lines,
  top,
  total,
  capacity,
}: {
  entry: LaunchEntry;
  /** Il record com'era all'apertura del log: descrive il giro del testo. */
  record: LaunchRecord | null;
  file: LaunchLogFile;
  /** `tab` passa all'altro log: il tentativo, o il giro vero. */
  alternate: boolean;
  /** Solo la finestra visibile del testo wrappato. */
  lines: WrappedLine[];
  top: number;
  total: number;
  capacity: number;
}) {
  const last = Math.min(total, top + capacity);
  const heading = launchLogHeading(entry, record, file, alternate);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">{sanitize(`${entry.emoji} ${entry.label}`)}</Text>
        <Text dimColor> :: LOG </Text>
        <Text color={heading.color} dimColor={heading.dim}>
          {heading.text}
        </Text>
        {heading.trueLogMissing ? <Text dimColor> · log del giro vero non su disco</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitize(cut(entry.command, 80))} · righe {total === 0 ? 0 : top + 1}-{last} di {total}
      </Text>
      {/* Con `tab` la legenda supera le 76 colonne utili di un terminale da 80:
          `esc` si accorcia, perché è il tasto che chi legge conosce già. */}
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">PgUp/PgDn</Text> ½ pagina ·{' '}
        <Text color="yellow">g/G</Text> estremi ·{' '}
        {alternate ? (
          <>
            <Text color="yellow">tab</Text> {file === 'outcome' ? 'tentativo' : 'giro vero'} ·{' '}
            <Text color="yellow">esc</Text> torna
          </>
        ) : (
          <>
            <Text color="yellow">esc</Text> torna alla pagina
          </>
        )}
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
