// Modali in FLUSSO sopra i due pane (sort, filtri, edit): a differenza delle
// schermate sostitutive costano righe al budget d'altezza, quindi ognuno ha un
// costo dichiarato in `viewport.ts`.
import { Box, Text } from 'ink';
import { caretWindow, cut, cutParts, sanitize } from '../width.js';
import { cpLen, type EditRow } from '../layout.js';
import { CARET, CARET_OFF, WARN } from '../glyphs.js';
import { EDIT_PRI, EDIT_PROG, type EditDraft, type FilterCursor, type PurgeDraft } from '../model.js';
import { PRI_ENTRIES, PROG_ENTRIES, type SortEntry, type SortKey, type ViewState } from '../view.js';
import { progressText, PRI_GLYPH, PRI_LABEL, PROG_GLYPH } from '../task-edit.js';

export const SORT_UI: Record<SortKey, string> = { pri: 'pri', prog: 'stato', id: 'id' };

// Modali resi IN FLUSSO (come l'input box di create), non in overlay assoluto:
// spingono giù i pane invece di coprirli, così la lista che stai filtrando
// resta sempre visibile mentre la componi.
export function SortModal({ sort }: { sort: SortEntry[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">S › sort chain</Text>
      {sort.length === 0 ? (
        <Text dimColor>nessuna chiave · resta l'ordine per id ↑</Text>
      ) : (
        <Text>
          {sort
            .map((e, i) => `${i + 1}. ${SORT_UI[e.key]} ${e.dir === 'asc' ? '↑' : '↓'}`)
            .join('    ')}
        </Text>
      )}
    </Box>
  );
}

export function FilterModal({ view, cursor }: { view: ViewState; cursor: FilterCursor }) {
  const rows = [
    { label: 'pri  ', entries: PRI_ENTRIES, hidden: new Set<string>(view.hiddenPri) },
    { label: 'stato', entries: PROG_ENTRIES, hidden: new Set<string>(view.hiddenProg) },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">F › filtri</Text>
      {rows.map((row, r) => (
        <Text key={row.label}>
          <Text dimColor>{row.label}</Text>
          {row.entries.map((e, c) => {
            const on = !row.hidden.has(e.name);
            const here = cursor.row === r && cursor.col === c;
            return (
              <Text key={e.name} inverse={here} color={on ? 'green' : 'gray'} dimColor={!on}>
                {'  '}
                [{on ? 'x' : ' '}] {sanitize(e.glyph)}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

/**
 * T112 — conferma di ELIMINAZIONE, in flusso come gli altri modali.
 *
 * Quattro righe, e nessuna è decorativa:
 *
 * ① il bersaglio per TAGLIA — «7 task» o «T31». Lo stesso tasto pota una task
 *   sulla vista principale e N sulla vista `archiviabili`, e ciò che discrimina
 *   è quale vista è attiva, cioè un'informazione che sta in header e non sotto
 *   le dita di chi preme: la conferma è l'unico punto in cui quella differenza
 *   torna visibile.
 * ② gli ID, troncati con `+N`: una conferma che non dice COSA sparisce non è
 *   informata.
 * ③ l'EFFETTO sul disco, non il nome della vista. «Archiviare 7 task?»
 *   prometterebbe uno spostamento in un archivio che non esiste — `clean-tasks`
 *   rimuove task file, folder e riga, e il recupero da git history è il rimedio,
 *   non l'operazione.
 * ④ ciò che il bersaglio dichiarato NON copre: le scartate del bulk (promettere
 *   7 e farne 5 è una bugia che non compare da nessuna parte, perché le 2
 *   restano in lista come prima) oppure, sulla singola task sporca, la scelta
 *   keep/purge che accompagna l'ordine.
 */
export function PurgeModal({ draft, columns }: { draft: PurgeDraft; columns: number }) {
  // Due cornici annidate da scalare — root (bordo 2 + paddingX 2) e modale
  // (bordo 2 + paddingX 2): il taglio è del chiamante, o la riga esce dal box e
  // il frame va a capo (invariante ③ di width.ts).
  const width = Math.max(8, columns - 8);
  const target = draft.bulk ? `${draft.ids.length} task` : (draft.ids[0] ?? '—');
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
      <Text color="red">CANC › eliminare {target}?</Text>
      <Text wrap="truncate-end">{cut(idList(draft.ids), width)}</Text>
      <Text dimColor wrap="truncate-end">
        {cut(
          'via clean-tasks: task file + folder + riga in tasks.md · un commit per task · nessun push',
          width,
        )}
      </Text>
      {draft.ignored ? (
        <IgnoredChoice survivors={draft.survivors} mode={draft.ignored} width={width} />
      ) : (
        <Text color={draft.skipped.length > 0 ? 'yellow' : undefined} dimColor={draft.skipped.length === 0} wrap="truncate-end">
          {cut(
            draft.skipped.length > 0
              ? `${WARN} ${draft.skipped.length} scartate (folder con file non tracciati): ${idList(draft.skipped)}`
              : 'nessuna esclusa · ⏎ conferma · esc annulla',
            width,
          )}
        </Text>
      )}
    </Box>
  );
}

/** Gli ID del bersaglio, troncati con `+N` quando non ci stanno tutti. Il
 *  troncamento lo fa questa funzione e non `cut`, perché tagliare a metà un id
 *  (`T1…`) direbbe una cosa falsa invece di dire che manca. */
export function idList(ids: string[], max = 12): string {
  if (ids.length <= max) return ids.join(' ');
  return `${ids.slice(0, max).join(' ')} +${ids.length - max}`;
}

/** D3 — la sola task con superstiti apre una conferma a TRE uscite: `⏎` su
 *  KEEP, `⏎` su PURGE, `esc`. La scelta viaggia come `--ignored-files` nel
 *  comando passato alla skill, ed è rara e distruttiva in modo diverso dal
 *  purge normale: nasconderla dentro un binario `⏎`/`esc` la mascherebbe. */
function IgnoredChoice({
  survivors,
  mode,
  width,
}: {
  survivors: number;
  mode: 'keep' | 'purge';
  width: number;
}) {
  const segs = ['[ keep ]', '[ purge ]'];
  const parts = [`${WARN} ${survivors} file non tracciati · `, segs[0]!, '  ', segs[1]!, ' · ←→'];
  // `priority` sulla voce SCELTA: è l'unica informazione che la riga esiste per
  // dare, e su un terminale stretto deve restare a schermo per prima.
  const shown = cutParts(parts, width, mode === 'keep' ? 1 : 3);
  return (
    <Text wrap="truncate-end">
      {shown.map((s, i) =>
        s ? (
          <Text key={i} color="yellow" inverse={(i === 1 && mode === 'keep') || (i === 3 && mode === 'purge')}>
            {s}
          </Text>
        ) : null,
      )}
    </Text>
  );
}

/**
 * Campo di testo del modale edit: finestra ancorata al caret + cursore inverso
 * nella posizione REALE.
 *
 * Il cursore non è più uno spazio inverso appiccicato in coda ma la cella `at`
 * della finestra — cioè il carattere su cui il caret sta davvero. Fuori fuoco
 * (`focused` falso) il caret non si disegna e la finestra si ancora in fondo,
 * che è la vista utile per un campo che non si sta scrivendo.
 */
export function EditTextField({
  label,
  value,
  caret,
  focused,
  cols,
}: {
  label: string;
  value: string;
  caret: number;
  focused: boolean;
  cols: number;
}) {
  const win = caretWindow(value, focused ? caret : cpLen(value), cols);
  return (
    <>
      <Text dimColor>{label}</Text>
      <Text>
        {'  '}
        {sanitize(win.head)}
      </Text>
      {/* Fuori fuoco `at` è solo la cella virtuale di fine campo: disegnarla
          aggiungerebbe al testo uno spazio che non gli appartiene. */}
      {focused ? <Text inverse>{sanitize(win.at)}</Text> : null}
      <Text>{sanitize(win.tail)}</Text>
    </>
  );
}

// T41 — modale edit, in flusso come gli altri (spinge giù i pane invece di
// coprirli: la riga che stai modificando resta visibile sopra la lista).
// La riga di anteprima mostra il testo ESATTO che finirà nel campo `Progress`
// del task file — così il default (`✔️ Done at <oggi>`) non è una sorpresa.
export function EditModal({
  id,
  draft,
  row,
  columns,
}: {
  id: string;
  draft: EditDraft;
  row: EditRow;
  columns: number;
}) {
  const mark = (r: EditRow) => (row === r ? CARET : CARET_OFF);
  // Budget dei campi di testo, DERIVATO da `columns` (mai una costante): il box
  // del modale è ANNIDATO nella cornice del deck, quindi le cornici da scalare
  // sono due — root (bordo 2 + paddingX 2) e modale (bordo 2 + paddingX 2) — più
  // caret 2, etichetta 6, gap 2 e cursore 1. Totale 19.
  // Un titolo di tasks.md arriva a ~64 caratteri: senza taglio la riga va a capo
  // dentro il box, che si alza di una riga e sfonda il budget verticale (invariante ③).
  const fieldBudget = Math.max(8, columns - 19);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">E › {id} · titolo, priorità e stato</Text>
      <Text>
        {mark(0)}
        <Text dimColor>pri   </Text>
        {EDIT_PRI.map((p) => (
          <Text key={p} inverse={draft.pri === p} color={draft.pri === p ? 'green' : 'gray'}>
            {'  '}
            {sanitize(PRI_GLYPH[p])} {PRI_LABEL[p]}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(1)}
        <Text dimColor>stato </Text>
        {EDIT_PROG.map((p) => (
          <Text key={p} inverse={draft.prog === p} color={draft.prog === p ? 'green' : 'gray'}>
            {'  '}
            {sanitize(PROG_GLYPH[p])} {p}
          </Text>
        ))}
      </Text>
      <Text>
        {mark(2)}
        <EditTextField
          label="prog  "
          value={draft.detail}
          caret={draft.caret}
          focused={row === 2}
          cols={fieldBudget}
        />
        {!draft.detail && row !== 2 ? <Text dimColor>(default)</Text> : null}
      </Text>
      {/* Il titolo è UNO ma vive in due posti: la colonna Task di tasks.md e
          l'H1 del task file. Il modale ne mostra uno solo perché sono la stessa
          informazione — tenerli separati sarebbe l'invito a farli divergere. */}
      <Text>
        {mark(3)}
        <EditTextField
          label="titolo"
          value={draft.title}
          caret={draft.caret}
          focused={row === 3}
          cols={fieldBudget}
        />
      </Text>
      {/* sanitize SOLO qui, non dentro progressText: quel testo finisce
          nel campo `Progress` del task file, dove il glifo va scritto nudo. */}
      <Text dimColor wrap="truncate-end">
        ↳ {sanitize(progressText(draft.prog, draft.detail))}
      </Text>
    </Box>
  );
}
