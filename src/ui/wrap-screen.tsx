// T134 — la lista hard-wrap: i file con l'a-capo automatico rientrato, più il
// campo che nomina il perimetro dello srotolamento.
import { Box, Text } from 'ink';
import { cut, pad, termWidth } from '../width.js';
import { FieldText } from './fields.js';
import { fmtTime } from '../glyphs.js';
import type { WrapFile } from '../wrap-scan.js';

/** Larghezza della colonna verdetto: il dominio è chiuso (`WRAP`, `misto`) e la
 *  più lunga è larga 5, quindi misurarla a ogni render calcolerebbe un numero
 *  già noto. */
const VERDICT_W = 5;

export function WrapScreen({
  files,
  count,
  mixed,
  mtime,
  top,
  capacity,
  path,
  caret,
  columns,
}: {
  /** Solo la finestra visibile della lista. */
  files: WrapFile[];
  /** Totali dell'intera lista, non della finestra: un contatore che contasse lo
   *  schermo cambierebbe a ogni scroll. */
  count: number;
  mixed: number;
  /** Ora dell'ultimo scan riuscito; `null` = mai misurato. Viene dall'mtime del
   *  file di cache, mai da un campo scritto nel testo. */
  mtime: number | null;
  top: number;
  capacity: number;
  path: string;
  caret: number;
  columns: number;
}) {
  const width = Math.max(20, (columns || 80) - 4);
  const total = count + mixed;
  const last = Math.min(total, top + capacity);
  // Cella elastica per sottrazione, come ogni lista del deck: le colonne fisse
  // sono note, quindi il path prende il resto. Pavimento 0 — è un tetto, non
  // una preferenza, e alzarlo sopra lo spazio reale fa uscire la riga dal box
  // mangiandone il bordo (invariante ③ di width.ts).
  //
  // Le due celle numeriche vanno contate INSIEME al loro separatore: `col=` è
  // larga 8, `br=` 6, e fra loro c'è uno spazio. Sommarne solo due su tre è
  // l'off-by-one che tronca la coda della riga.
  const COL_W = 8;
  const BREAKS_W = 6;
  const numsW = COL_W + 1 + BREAKS_W;
  // `- 4` = bordo + padding del box della lista, che sta DENTRO quello esterno.
  const pathW = Math.max(0, width - 4 - VERDICT_W - 1 - numsW);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">hard-wrap</Text>{' '}
        <Text color="red">{count} WRAP</Text>{' '}
        <Text dimColor>· {mixed} misto</Text>{' '}
        <Text dimColor>
          · scan {mtime === null ? 'mai' : fmtTime(mtime)} · righe {total === 0 ? 0 : top + 1}-
          {last} di {total}
        </Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {/* `misto` non entra nel contatore ed è la classe che ospita il falso
            allarme noto — i file di note scritte una riga per pensiero. Dirlo
            qui evita che un elenco misto si legga come un numero sbagliato. */}
        <Text color="yellow">↑↓/PgUp/PgDn</Text> scorre · <Text color="yellow">^U</Text> svuota il
        path · <Text color="yellow">⏎</Text> srotola · <Text color="yellow">esc</Text> chiude ·
        misto = falso allarme probabile, fuori dal contatore
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {files.map((f) => (
          <Text key={f.path} wrap="truncate-end">
            <Text color={f.verdict === 'WRAP' ? 'red' : undefined} dimColor={f.verdict !== 'WRAP'}>
              {pad(f.verdict, VERDICT_W)}
            </Text>{' '}
            <Text dimColor={f.verdict !== 'WRAP'}>{cut(f.path, pathW)}</Text>
            {' '.repeat(Math.max(0, pathW - termWidth(cut(f.path, pathW))))}
            <Text dimColor>
              {pad(`col=${f.column ?? '?'}`, COL_W, 'right')}{' '}
              {pad(`br=${f.breaks}`, BREAKS_W, 'right')}
            </Text>
          </Text>
        ))}
      </Box>
      {/* Il campo del perimetro. Default `.` — la project root intera, che è il
          perimetro dello scan (D4): partire da lì rende il gesto completo di
          default, e restringerlo è una scelta esplicita. */}
      <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text color="yellow">path › </Text>
        <FieldText value={path} caret={caret} focused cols={Math.max(10, width - 12)} />
      </Box>
    </Box>
  );
}
