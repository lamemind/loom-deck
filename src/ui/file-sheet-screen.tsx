// T134/T160 — il detail di un FILE: testo scorrevole più la riga che dichiara
// cosa partirà su `⏎`.
//
// Una schermata per le due istanze di `useFileSheet` (coda inbox e bersaglio
// doc). Quello che cambia fra loro è la TESTATA — tre celle di testo, che i due
// `…SheetHead` qui sotto compongono — e non la struttura: stesse righe fisse,
// stessa cornice, stesso `FILE_SHEET_CHROME` nel budget d'altezza. Due
// componenti avrebbero duplicato la cornice e il conteggio delle righe fisse,
// che è esattamente ciò che fa sfondare `rows` quando una delle due copie
// guadagna una riga e l'altra no.
//
// Riusa `DetailLine` del detail della task invece di ri-renderizzare il markdown
// per conto proprio: sono lo stesso costrutto — un documento reso in span
// tipizzati dentro un box — e due rese dello stesso markdown divergerebbero al
// primo stile aggiunto. L'evidenziazione della ricerca non serve qui, quindi le
// occorrenze arrivano vuote e il secondo taglio di `DetailLine` non gira nemmeno.
import { Box, Text } from 'ink';
import { cut, type WrappedLine } from '../width.js';
import type { Span } from '../markdown.js';
import { DetailLine } from './detail-screen.js';
import { INBOX_MARK, WARN, fmtDateTime, fmtSize } from '../glyphs.js';
import { NATURA_SHORT, inboxMark, type InboxFile } from '../inbox.js';
import { flagNames, type DocRow } from '../doc-tree.js';

/** Le tre celle di testata che distinguono le due istanze. Un dato e non JSX:
 *  così i due compositori restano funzioni pure, provabili senza montare
 *  niente. */
export interface SheetHead {
  /** La cella corta e colorata in testa al nome: la natura, o il tipo di riga. */
  tag: string;
  /** Il nome del bersaglio, per esteso. */
  name: string;
  /** La riga meta, senza la posizione nel testo — quella la aggiunge la
   *  schermata, che è l'unica a sapere dove si è arrivati a scorrere. */
  meta: string;
}

export function inboxSheetHead(file: InboxFile): SheetHead {
  const mark = inboxMark(file);
  return {
    tag: NATURA_SHORT[file.natura],
    name: file.basename,
    meta:
      `${INBOX_MARK[mark] ? `${INBOX_MARK[mark]} ` : ''}${mark}` +
      `${file.branch ? ` ⟨${file.branch}⟩` : ''}` +
      `${file.cappello ? ` · ${file.cappello}` : ''} · ${file.nozioni} nozioni · ` +
      `${file.aperte} aperte · ${fmtSize(file.chars)} · ${fmtDateTime(file.created * 1000)}`,
  };
}

/**
 * T160 — la testata del bersaglio doc.
 *
 * La meta cambia di natura fra file e cartella e non è un ramo di cortesia: il
 * `char` di un file è la sua lunghezza, quello di una cartella la somma dei
 * suoi, e le due si confrontano con due soglie diverse. Mostrarle sotto la
 * stessa etichetta le farebbe leggere come la stessa misura.
 */
export function docSheetHead(row: DocRow): SheetHead {
  const flags = flagNames(row.flags);
  return {
    tag: row.kind === 'dir' ? 'dir' : 'file',
    name: row.path,
    meta:
      (row.kind === 'dir'
        ? `${row.files} file · ${fmtSize(row.chars)} in cartella`
        : `${fmtSize(row.chars)} · TLDR ${row.tldr || 'assente'}`) +
      ` · ${flags.length > 0 ? flags.join(' · ') : 'nessun flag'}`,
  };
}

export function FileSheetScreen({
  head,
  missing,
  lines,
  spans,
  top,
  total,
  capacity,
  prompt,
  hint,
  columns,
}: {
  head: SheetHead;
  /** Il bersaglio non è leggibile: si mostra il perché, l'azione resta attiva. */
  missing: boolean;
  /** Solo la finestra visibile del testo RESO wrappato, con i suoi offset. */
  lines: WrappedLine[];
  /** Costrutti markdown dell'intero documento: il taglio per riga lo fa
   *  `sliceSpans` intersecando. */
  spans: readonly Span[];
  top: number;
  total: number;
  capacity: number;
  /** Il comando che partirà su `⏎`, già composto. Vuoto = nessuna azione. */
  prompt: string;
  /** Cosa dice la riga azione quando non c'è un comando. */
  hint: string;
  columns: number;
}) {
  const last = Math.min(total, top + capacity);
  const width = Math.max(20, (columns || 80) - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">{head.tag}</Text> {cut(head.name, Math.max(10, width - 8))}
      </Text>
      <Text dimColor wrap="truncate-end">
        {head.meta}
        {/* Senza testo la posizione non è un dato mancante: non esiste proprio.
            Un `righe 0-0 di 0` la annuncerebbe come tale. */}
        {missing ? '' : ` · righe ${total === 0 ? 0 : top + 1}-${last} di ${total}`}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓/PgUp/PgDn</Text> testo · <Text color="yellow">g/G</Text> estremi ·{' '}
        <Text color="yellow">⏎</Text> apre la sessione · <Text color="yellow">esc</Text> chiude
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {missing ? (
          <Text color="yellow" wrap="truncate-end">
            {WARN} non leggibile · l'azione resta attiva (la skill risolve il bersaglio per nome)
          </Text>
        ) : (
          lines.map((l, i) => (
            <DetailLine key={top + i} line={l} spans={spans} occ={[]} current={-1} />
          ))
        )}
      </Box>
      {/* La riga che rende `⏎` una scelta invece di un salto nel buio: dice il
          comando esatto, non una parafrasi. È una riga FISSA, contata da
          FILE_SHEET_CHROME — ogni riga aggiunta qui va scalata lì, o il frame
          sfonda `rows` e Ink passa a `clearTerminal`.
          T160 — senza comando la riga porta la RAGIONE, in giallo: una riga muta
          si leggerebbe come un comando che non si è riusciti a comporre. */}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>⏎ › </Text>
          <Text color={prompt ? 'green' : 'yellow'}>
            {cut(prompt || hint || 'nessuna azione su questo bersaglio', Math.max(10, width - 4))}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
