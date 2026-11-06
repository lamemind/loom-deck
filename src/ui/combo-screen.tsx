// T194 — il modale delle combo: le voci di `deckLegend` su due colonne, il tasto
// e ciò che fa.
import { Box, Text } from 'ink';
import { cut, pad } from '../width.js';
import type { ComboRow } from '../frame.js';

/** Spazio fra la colonna dei tasti e quella delle etichette. */
const KEY_GAP = '  ';

export function ComboScreen({
  rows,
  keyW,
  top,
  total,
  capacity,
  columns,
}: {
  /** Solo la finestra visibile dell'elenco. */
  rows: ComboRow[];
  /** Larghezza della colonna dei tasti, misurata sulla lista intera. */
  keyW: number;
  top: number;
  total: number;
  capacity: number;
  columns: number;
}) {
  const last = Math.min(total, top + capacity);
  // `- 8` = bordo + padding del box esterno e del box lista, che sta dentro il
  // primo. L'etichetta prende il resto, con pavimento 0: alzarlo sopra lo spazio
  // reale farebbe uscire la riga dal box mangiandone il bordo (invariante ③ di
  // width.ts).
  const labelW = Math.max(0, (columns || 80) - 8 - keyW - KEY_GAP.length);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color="cyan">combo</Text>
        <Text dimColor>
          {' '}
          · voci attive sul pane a fuoco · righe {total === 0 ? 0 : top + 1}-{last} di {total}
        </Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓/PgUp/PgDn</Text> scorre · <Text color="yellow">g/G</Text> estremi ·{' '}
        <Text color="yellow">esc</Text> chiude
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {rows.map((r) => (
          <Text key={`${r.key} ${r.label}`} wrap="truncate-end">
            <Text color="yellow">{pad(r.key, keyW)}</Text>
            {KEY_GAP}
            {cut(r.label, labelW)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
