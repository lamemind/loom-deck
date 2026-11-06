// T194 — il modale delle combo: le azioni generali in alto, le due colonne sotto.
// Le righe arrivano già composte per la larghezza (`comboLines`), qui si colorano.
import { Box, Text } from 'ink';
import type { ComboLine, ComboSpan } from '../combo-catalog.js';

function SpanText({ span }: { span: ComboSpan }) {
  if (span.style === 'title') return <Text bold color="cyan">{span.text}</Text>;
  if (span.style === 'key') return <Text color="yellow">{span.text}</Text>;
  if (span.style === 'separator') return <Text dimColor>{span.text}</Text>;
  return <Text>{span.text}</Text>;
}

export function ComboScreen({
  lines,
  top,
  total,
  capacity,
}: {
  /** Solo la finestra visibile delle righe. */
  lines: ComboLine[];
  top: number;
  total: number;
  capacity: number;
}) {
  const last = Math.min(total, top + capacity);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color="cyan">combo</Text>
        <Text dimColor>
          {' '}
          · tutte le azioni del deck · righe {total === 0 ? 0 : top + 1}-{last} di {total}
        </Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓/PgUp/PgDn</Text> scorre · <Text color="yellow">g/G</Text> estremi ·{' '}
        <Text color="yellow">esc</Text> chiude
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {lines.map((line, index) => (
          <Text key={top + index} wrap="truncate-end">
            {line.map((span, spanIndex) => (
              <SpanText key={spanIndex} span={span} />
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
