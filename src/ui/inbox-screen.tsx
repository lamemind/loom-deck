// T134 — il detail di un file inbox: testo scorrevole più la riga che dichiara
// cosa partirà su `⏎`.
//
// Riusa `DetailLine` del detail della task invece di ri-renderizzare il
// markdown per conto proprio: sono lo stesso costrutto — un documento reso in
// span tipizzati dentro un box — e due rese dello stesso markdown
// divergerebbero al primo stile aggiunto. L'evidenziazione della ricerca non
// serve qui (nessuna ricerca dentro l'inbox), quindi le occorrenze arrivano
// vuote e il secondo taglio di `DetailLine` non gira nemmeno.
import { Box, Text } from 'ink';
import { cut, type WrappedLine } from '../width.js';
import type { Span } from '../markdown.js';
import { DetailLine } from './detail-screen.js';
import { INBOX_MARK, WARN, fmtDateTime, fmtSize } from '../glyphs.js';
import { NATURA_SHORT, inboxMark, type InboxFile } from '../inbox.js';

export function InboxScreen({
  file,
  missing,
  lines,
  spans,
  top,
  total,
  capacity,
  prompt,
  columns,
}: {
  file: InboxFile;
  /** Il file non è leggibile: si mostra il perché, l'azione resta attiva. */
  missing: boolean;
  /** Solo la finestra visibile del testo RESO wrappato, con i suoi offset. */
  lines: WrappedLine[];
  /** Costrutti markdown dell'intero documento: il taglio per riga lo fa
   *  `sliceSpans` intersecando. */
  spans: readonly Span[];
  top: number;
  total: number;
  capacity: number;
  /** Il prompt che partirà su `⏎`, già composto. */
  prompt: string;
  columns: number;
}) {
  const last = Math.min(total, top + capacity);
  const width = Math.max(20, (columns || 80) - 4);
  const mark = inboxMark(file);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">{NATURA_SHORT[file.natura]}</Text>{' '}
        {cut(file.basename, Math.max(10, width - 8))}
      </Text>
      <Text dimColor wrap="truncate-end">
        {INBOX_MARK[mark] ? `${INBOX_MARK[mark]} ` : ''}
        {mark}
        {file.branch ? ` ⟨${file.branch}⟩` : ''}
        {file.cappello ? ` · ${file.cappello}` : ''} · {file.nozioni} nozioni · {file.aperte}{' '}
        aperte · {fmtSize(file.chars)} · {fmtDateTime(file.created * 1000)}
        {/* Senza file la posizione nel testo non è un dato mancante: non esiste
            proprio. Un `righe 0-0 di 0` la annuncerebbe come tale. */}
        {missing ? '' : ` · righe ${total === 0 ? 0 : top + 1}-${last} di ${total}`}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓/PgUp/PgDn</Text> testo · <Text color="yellow">g/G</Text> estremi ·{' '}
        <Text color="yellow">⏎</Text> apre la sessione · <Text color="yellow">esc</Text> chiude
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {missing ? (
          <Text color="yellow" wrap="truncate-end">
            {WARN} file non leggibile · l'azione resta attiva (la skill risolve il file per nome)
          </Text>
        ) : (
          lines.map((l, i) => (
            <DetailLine key={top + i} line={l} spans={spans} occ={[]} current={-1} />
          ))
        )}
      </Box>
      {/* La riga che rende `⏎` una scelta invece di un salto nel buio: dice il
          comando esatto, non una parafrasi. È una riga FISSA, contata da
          INBOX_CHROME — ogni riga aggiunta qui va scalata lì, o il frame sfonda
          `rows` e Ink passa a `clearTerminal`. */}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>⏎ › </Text>
          <Text color="green">{cut(prompt, Math.max(10, width - 4))}</Text>
        </Text>
      </Box>
    </Box>
  );
}
