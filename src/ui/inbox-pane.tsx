// T134 — il pane della coda inbox, che in modo doc occupa lo slot DESTRO.
//
// T160 · D1 — estratto da `ui/panes.tsx` insieme al pane doc, per la ragione
// scritta in `coding-standards` §Un criterio verificato una volta non è un
// custode: quel file era già stato splittato e stava ricrescendo. L'asse dello
// split è per PANE, non per livello — ogni pane porta il proprio header, la
// propria riga e la propria nota di vuoto, e sono le tre cose che si toccano
// insieme. Ciò che i quattro condividono (`HeaderLine`) sta in
// `ui/header-line.tsx`, e nessuno dei moduli estratti importa `ui/panes.tsx`.
//
// Presentazionale puro: riceve la vista già selezionata e le larghezze già
// calcolate, non le deriva.
import { Box, Text } from 'ink';
import { cut, pad, sanitize, termWidth } from '../width.js';
import { paneTextWidth } from '../layout.js';
import { CARET, CARET_OFF, INBOX_MARK, INBOX_MARK_W, relTime } from '../glyphs.js';
import { NATURA_SHORT, NATURA_W, inboxMark, type InboxFile } from '../inbox.js';
import { inboxView, type InboxViewCounts, type InboxViewId } from '../inbox-views.js';
import { inboxHeaderParts } from '../pane-header.js';
import { HeaderLine } from './header-line.js';

/**
 * Header del pane inbox: le parti e il loro taglio vengono da `pane-header.ts`,
 * lo stesso modulo da cui `frame.ts` ricava le colonne cliccabili — una fonte
 * sola, non due conti paralleli che divergono alla prima voce che cambia testo.
 */
export function InboxHeader({
  counts,
  active,
  above,
  below,
  focused,
  columns,
}: {
  counts: InboxViewCounts;
  active: InboxViewId;
  above: number;
  below: number;
  focused: boolean;
  columns: number;
}) {
  const { parts, shown } = inboxHeaderParts(counts, active, above, below, columns);
  return <HeaderLine parts={parts} shown={shown} focused={focused} />;
}

/**
 * T134 — il pane inbox, montato nello slot destro dal modo doc (D6).
 *
 * Mostra SEMPRE TUTTO, senza filtro sulla task selezionata a sinistra (D7
 * preflight, che supersede la clausola di D6 congelate): niente righe meta,
 * nessun trattamento speciale per il cappello vuoto o per un cappello che nomina
 * una task non più in `tasks.md`. Ne discende che la colonna `CAPPELLO` di
 * `doc-metrics` non serve al filtro — resta nel blocco preview, dove dice
 * qualcosa senza costare una colonna su ogni riga.
 *
 * La riga porta marcatori, branch e nome (D8). Non le cifre (nozioni, aperte,
 * char): stanno nella preview, e su un pane largo la metà del terminale ogni
 * colonna fissa la paga la cella elastica del nome — che è l'unica cosa con cui
 * si riconosce un file.
 */
export function InboxPane({
  files,
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
}: {
  /** Solo la finestra visibile della lista, e della vista attiva. */
  files: InboxFile[];
  counts: InboxViewCounts;
  activeView: InboxViewId;
  /** Righe della vista ATTIVA (non `files.length`, che è la sola finestra). */
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
}) {
  const width = paneTextWidth(columns);
  // La cella elastica si calcola per SOTTRAZIONE dalle colonne fisse, come il
  // titolo della lista sessioni: pavimento 0 e non un minimo di cortesia — è un
  // tetto, non una preferenza, e alzarlo sopra lo spazio reale fa uscire la riga
  // dal pane mangiandone il bordo (invariante ③ di width.ts).
  const ageW = 3;
  const nameW = Math.max(
    0,
    width -
      (2 /* caret */ +
        NATURA_W +
        1 /* gutter */ +
        INBOX_MARK_W +
        1 /* gutter */ +
        1 /* gutter prima della data */ +
        ageW),
  );
  return (
    <Box
      flexDirection="column"
      width="50%"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <InboxHeader
        counts={counts}
        active={activeView}
        above={above}
        below={below}
        focused={focused}
        columns={columns}
      />
      {paneCount === 0 ? (
        // Tre vuoti diversi, e dirlo è il punto: «non ho ancora misurato» non è
        // «ho misurato e non c'è niente», e «la misura si è rotta» non è nessuno
        // dei due (D2 preflight). Una lista vuota che non dice quale dei tre è
        // si legge come un pane rotto.
        <Text color="yellow" wrap="truncate-end">
          {cut(
            !scanned
              ? 'coda non ancora misurata'
              : !ok
                ? 'misura della coda fallita: plugin assente o script in errore'
                : inboxView(activeView).empty,
            width,
          )}
        </Text>
      ) : (
        files.map((f) => {
          const sel = f.path === selectedPath;
          const mark = inboxMark(f);
          // Il branch sta DENTRO la cella del nome, non in una colonna propria:
          // è raro, e una colonna dedicata costerebbe spazio vuoto su ogni riga
          // non-branchata di un pane largo la metà del terminale. Stessa scelta
          // del marcatore di fork nella lista sessioni.
          const branchMark = f.branch ? `⟨${f.branch}⟩ ` : '';
          const inner = Math.max(0, nameW - termWidth(sanitize(branchMark)));
          const name = cut(f.basename.replace(/\.md$/, ''), inner);
          const age = relTime(f.created * 1000);
          return (
            <Text
              key={f.path}
              inverse={sel && focused}
              bold={sel && !focused}
              wrap="truncate-end"
            >
              {sel ? CARET : CARET_OFF}
              <Text
                color={mark === 'broken' ? 'red' : mark === 'queued' ? 'green' : undefined}
                dimColor={mark === 'held' || mark === 'branched'}
              >
                {pad(NATURA_SHORT[f.natura], NATURA_W)}
              </Text>{' '}
              <Text color={mark === 'branched' ? 'yellow' : undefined}>
                {pad(INBOX_MARK[mark], INBOX_MARK_W)}
              </Text>{' '}
              {branchMark ? <Text color="yellow">{sanitize(branchMark)}</Text> : null}
              <Text dimColor={mark !== 'queued'}>{name}</Text>
              {' '.repeat(Math.max(0, inner - termWidth(name)))}{' '}
              <Text dimColor>{pad(age, ageW, 'right')}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
