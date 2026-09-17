// T160 — il pane dell'albero doc, che in modo doc occupa lo slot SINISTRO.
//
// Risponde a una domanda sola, ed è la ragione della sua forma: **vale la pena
// lanciare `rebalance-doc` adesso, e su cosa?** Da qui la colonna dei flag in
// testa, dove si scorre con l'occhio, e il nome come unica cella elastica.
//
// Le CIFRE non stanno in riga (P6): char, lunghezza del TLDR e conteggio file
// vivono nel blocco preview, insieme ai nomi interi dei flag. Su un pane largo la
// metà del terminale ogni colonna fissa la paga il nome, che è l'unica cosa con
// cui si riconosce un file — la stessa scelta già fatta per il pane inbox.
//
// Presentazionale puro: riceve la vista già selezionata e le larghezze già
// calcolate, non le deriva.
import { Box, Text } from 'ink';
import { cut } from '../width.js';
import { paneTextWidth } from '../layout.js';
import { CARET, CARET_OFF } from '../glyphs.js';
import { DOC_FLAG_W, flagCell, type DocRow } from '../doc-tree.js';
import { docView, type DocViewCounts, type DocViewId } from '../doc-views.js';
import { docHeaderParts } from '../pane-header.js';
import { HeaderLine } from './header-line.js';

/**
 * Rientro di un livello dell'albero: UNA colonna, non due.
 *
 * L'albero della doc arriva a quattro livelli (`runtime/reference/loom-deck/
 * sessions/`), e a due colonne per livello il rientro mangerebbe otto colonne
 * della cella nome proprio sulle righe più profonde — che su un pane a 80
 * colonne sono la metà di ciò che resta. Una colonna basta a vedere la
 * gerarchia, perché le cartelle stanno comunque prima dei loro file.
 */
const INDENT_W = 1;

/** I flag che chiamano un'operazione di `rebalance-doc`: la riga che ne porta
 *  almeno uno è quella per cui il pane esiste, e si legge accesa. */
const ACTIONABLE = new Set(['SPLIT', 'MERGE?', 'REGROUP']);

/** Quelli che chiamano `write-tldr`: un difetto vero, ma di un'altra skill. */
const TLDR_FLAGS = new Set(['TLDR>CAP', 'NOTLDR', 'TLDR-ORFANA']);

/** Il colore della cella flag, dal flag più urgente che la riga porta. Un colore
 *  solo per cella e non uno per short: la cella è un `Text` unico, e stilarne i
 *  pezzi costerebbe tre nodi annidati per riga su una lista lunga quanto la doc. */
function flagColor(row: DocRow): string | undefined {
  if (row.flags.some((f) => ACTIONABLE.has(f))) return 'yellow';
  if (row.flags.some((f) => TLDR_FLAGS.has(f))) return 'cyan';
  return undefined;
}

/**
 * Header del pane doc: le parti e il loro taglio vengono da `pane-header.ts`, lo
 * stesso modulo da cui `frame.ts` ricava le colonne cliccabili.
 */
export function DocHeader({
  counts,
  active,
  above,
  below,
  focused,
  columns,
  hasDirs,
}: {
  counts: DocViewCounts;
  active: DocViewId;
  above: number;
  below: number;
  focused: boolean;
  columns: number;
  hasDirs: boolean;
}) {
  const { parts, shown } = docHeaderParts(counts, active, above, below, columns, hasDirs);
  return <HeaderLine parts={parts} shown={shown} focused={focused} />;
}

export function DocPane({
  rows,
  counts,
  activeView,
  paneCount,
  selectedPath,
  focused,
  above,
  below,
  columns,
  ok,
  scanned,
  scanning,
  hasDirs,
}: {
  /** Solo la finestra visibile della lista, e della vista attiva. */
  rows: DocRow[];
  counts: DocViewCounts;
  activeView: DocViewId;
  /** Righe della vista ATTIVA (non `rows.length`, che è la sola finestra). */
  paneCount: number;
  selectedPath: string | null;
  focused: boolean;
  above: number;
  below: number;
  columns: number;
  /** L'ultimo scan è riuscito. */
  ok: boolean;
  /** Almeno uno scan è stato tentato. */
  scanned: boolean;
  /** Una misura è in corso adesso. */
  scanning: boolean;
  /** La misura portava anche la tabella delle cartelle. */
  hasDirs: boolean;
}) {
  const width = paneTextWidth(columns);
  // Cella elastica per sottrazione dalle colonne fisse, come nel pane inbox e
  // nella lista sessioni. Pavimento 0 e non un minimo di cortesia: è un tetto,
  // non una preferenza, e alzarlo sopra lo spazio reale fa uscire la riga dal
  // pane mangiandone il bordo (invariante ③ di width.ts).
  const nameW = Math.max(0, width - (2 /* caret */ + DOC_FLAG_W + 1 /* gutter */));
  return (
    <Box
      flexDirection="column"
      width="50%"
      marginRight={1}
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <DocHeader
        counts={counts}
        active={activeView}
        above={above}
        below={below}
        focused={focused}
        columns={columns}
        hasDirs={hasDirs}
      />
      {paneCount === 0 ? (
        // Quattro vuoti diversi, e dirlo è il punto. Ai tre del pane inbox se ne
        // aggiunge uno che solo questo scan ha: «sto misurando». Quattro secondi
        // di wall clock sono abbastanza da vedersi, e un pane vuoto per quattro
        // secondi si legge come una doc senza file.
        <Text color="yellow" wrap="truncate-end">
          {cut(
            scanning
              ? 'misura in corso…'
              : !scanned
                ? 'albero non ancora misurato'
                : !ok
                  ? 'misura della doc fallita: plugin assente o script in errore'
                  : docView(activeView).empty,
            width,
          )}
        </Text>
      ) : (
        rows.map((r) => {
          const sel = r.path === selectedPath;
          const indent = ' '.repeat(r.depth * INDENT_W);
          // La barra finale distingue una cartella da un file senza spendere una
          // colonna di marcatore: è la convenzione di `ls -F`, e su una riga che
          // porta già una colonna di flag un glifo in più sarebbe la terza cosa
          // da leggere prima del nome.
          const label = r.kind === 'dir' ? `${r.name}/` : r.name;
          const text = cut(indent + label, nameW);
          return (
            <Text key={r.path} inverse={sel && focused} bold={sel && !focused} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              <Text color={flagColor(r)} dimColor={r.flags.length === 0}>
                {flagCell(r.flags)}
              </Text>{' '}
              <Text bold={r.kind === 'dir'} dimColor={r.kind === 'file' && r.flags.length === 0}>
                {text}
              </Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
