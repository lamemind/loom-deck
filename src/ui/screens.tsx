// Le SCHERMATE SOSTITUTIVE del deck e i due frammenti che le accompagnano.
//
// Una schermata sostitutiva prende il frame intero invece di stare in un box
// sopra i due pane: assegnazione, detail della task, project status, detail di
// un file inbox, ricerca e reader. Il criterio è la taglia del contenuto — una
// lista di occorrenze, un task file o un file di nozioni non entrano in quattro
// righe — e la conseguenza è che il budget d'altezza dei pane non viene nemmeno
// calcolato, perché il render esce prima.
//
// `screenFor` è il ROUTER: sceglie fra le sei e restituisce `null` quando
// nessuna è attiva, cioè quando si resta sulla lista. È una funzione e non un
// componente proprio per questo — il chiamante deve poter distinguere «ecco la
// schermata» da «non è il tuo turno», e un componente che rende `null` non gli
// direbbe la differenza in tempo utile per il proprio `return`.
//
// Fino a T131 le cinque vivevano in `cli.tsx` come cinque `if` consecutivi, con
// dentro le derivazioni di finestra di ognuna. Sono uscite insieme perché la
// scelta fra le viste non è né vista né input: la vista disegna ciò che le
// viene dato, l'input decide cosa cambiare, e chi sceglie quale albero tornare
// è un terzo mestiere.
//
// Direzione della dipendenza: questo file importa i TIPI di ritorno degli hook
// di `src/overlays/` (`import type` + `ReturnType`, nessun import a runtime).
// È lecito nell'asse — la vista sta a valle dell'input, mai a monte — ed è il
// primo file di `ui/` a farlo, quindi va detto invece che scoperto a grep.
import { Box, Text } from 'ink';
import { rowIndexOfKey, selectedRow } from '../search.js';
import { cut } from '../width.js';
import { legendWidth, type IndicatorRow } from '../frame.js';
import { isCompact, searchPreviewCapacity, windowRange } from '../viewport.js';
import { conversationLabel } from '../layout.js';
import { taskColumns, type TaskRowData, type ViewState } from '../view.js';
import type { Task } from '../tasks.js';
import type { Mode, PurgeDraft } from '../model.js';
import type { Session } from '../sessions.js';
import { AssignScreen } from './assign-screen.js';
import { DetailScreen } from './detail-screen.js';
import { StatusScreen } from './status-screen.js';
import { InboxScreen } from './inbox-screen.js';
import { WrapScreen } from './wrap-screen.js';
import { ReaderScreen, SearchScreen } from './search-screen.js';
import type { useAssignOverlay } from '../overlays/assign.js';
import type { useSheetOverlay } from '../overlays/sheet.js';
import type { useSearchOverlay } from '../overlays/search.js';
import type { useProjectStatus } from '../overlays/status.js';
import type { useInboxOverlay } from '../overlays/inbox.js';
import type { useWrapOverlay } from '../overlays/wrap.js';

type AssignOverlay = ReturnType<typeof useAssignOverlay>;
type SheetOverlay = ReturnType<typeof useSheetOverlay>;
type SearchOverlay = ReturnType<typeof useSearchOverlay>;
type StatusOverlay = ReturnType<typeof useProjectStatus>;
type InboxOverlay = ReturnType<typeof useInboxOverlay>;
type WrapOverlay = ReturnType<typeof useWrapOverlay>;

/**
 * Il ripiego per un terminale troppo basso: una riga sola al posto della
 * cornice. Perdere il layout è meglio che sfondare `rows` — oltre quella
 * soglia Ink smette di aggiornare per differenza e pulisce lo schermo a ogni
 * redraw, versando un frame intero nello scrollback a ogni tick del poll.
 *
 * Sei call site lo usavano in copia (le cinque schermate più la lista), identici
 * tranne il soggetto e il verbo di `esc`. `dot` esiste perché la sesta copia —
 * quella della lista — attacca al nome del programma la propria VERSIONE, e un
 * punto in mezzo la staccherebbe da ciò di cui è la versione.
 */
export function CompactNotice({
  what,
  esc,
  rows,
  columns,
  dot = true,
}: {
  what: string;
  esc?: string;
  rows: number;
  columns: number;
  dot?: boolean;
}) {
  return (
    <Text wrap="truncate-end">
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor>
        {dot ? ' · ' : ' '}
        {what} · terminale {rows}×{columns}: troppo basso, allarga
        {esc ? ` · esc ${esc}` : ''}
      </Text>
    </Text>
  );
}

/**
 * La riga sotto la testata: in `normal` la legenda dei tasti, in un modale in
 * flusso le sue istruzioni. I modali sostitutivi non arrivano qui — hanno già
 * preso il frame.
 *
 * T134 — in `normal` la riga non è più tutta della legenda: divide lo spazio con
 * gli INDICATORI ancorati a destra, e sono loro ad avere la precedenza sul
 * budget (D5 preflight). `keyLegend` è già troncabile per costruzione e ciò che
 * perde si ricorda; un contatore troncato invece mente.
 *
 * Dentro un modale in flusso gli indicatori non compaiono, e non è un
 * nascondimento: la riga è dell'istruzione del modale, che sta a schermo per il
 * tempo di una domanda. «Mai nascondibile» (D9) dice che non esiste un tasto per
 * spegnerli, non che ogni riga del frame debba ospitarli.
 */
export function HintBar({
  mode,
  purge,
  keyLegend,
  indicators,
  columns,
}: {
  mode: Mode;
  purge: PurgeDraft | null;
  keyLegend: string;
  indicators: IndicatorRow;
  columns: number;
}) {
  if (mode === 'create') {
    return (
      <Text dimColor wrap="truncate-end">
        nuova task · <Text color="yellow">⏎</Text> crea · <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  if (mode === 'sort') {
    return (
      <Text dimColor wrap="truncate-end">
        sort · <Text color="yellow">p</Text> pri <Text color="yellow">s</Text> stato{' '}
        <Text color="yellow">i</Text> id (asc→desc→off) · <Text color="yellow">⏎</Text> ok ·{' '}
        <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  if (mode === 'filter') {
    return (
      <Text dimColor wrap="truncate-end">
        filtri · <Text color="yellow">↑↓←→</Text> naviga · <Text color="yellow">spazio</Text>{' '}
        mostra/nascondi · <Text color="yellow">⏎</Text> ok · <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  if (mode === 'note') {
    return (
      <Text dimColor wrap="truncate-end">
        titolo conversazione · <Text color="yellow">^U</Text> svuota ·{' '}
        <Text color="yellow">⏎</Text> salva (vuoto = rimuove) ·{' '}
        <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  if (mode === 'purge') {
    return (
      <Text dimColor wrap="truncate-end">
        elimina task ·{' '}
        {purge?.ignored ? (
          <>
            <Text color="yellow">←→</Text> keep/purge dei file non tracciati ·{' '}
          </>
        ) : null}
        <Text color="yellow">⏎</Text> conferma · <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  if (mode === 'edit') {
    return (
      <Text dimColor wrap="truncate-end">
        edit · <Text color="yellow">↑↓</Text> campo · <Text color="yellow">←→</Text> valore, o
        cursore sul testo · <Text color="yellow">^A/^E</Text> inizio/fine ·{' '}
        <Text color="yellow">^D</Text> canc · <Text color="yellow">⏎</Text> salva+commit ·{' '}
        <Text color="yellow">esc</Text> annulla
      </Text>
    );
  }
  // Riga a piena larghezza nella stessa forma della testata: un `Box` con
  // `justifyContent="space-between"` e due figli a stringa piatta. Il blocco
  // indicatori arriva già unito (`indicators.text`) invece che come segmenti
  // resi uno per uno — da cui il colore unico per il blocco.
  //
  // Il taglio della legenda resta del deck e non di Ink: la stringa porta emoji
  // e frecce, e `cli-truncate` le conta con un budget in colonne indicizzando
  // per code point — una colonna di troppo finisce sopra il bordo destro, che
  // sparisce dalla riga (invariante ③ di width.ts).
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor wrap="truncate-end">
        {cut(keyLegend, legendWidth(columns, indicators.width))}
      </Text>
      <Text color="cyan">{indicators.text}</Text>
    </Box>
  );
}

/** Ciò che il router deve sapere per scegliere e per rendere la schermata scelta. */
export type ScreensInput = {
  mode: Mode;
  rows: number;
  columns: number;
  note: string;
  /** Le conversazioni e i loro attributi, come li restituisce `useSessions`. */
  sessions: Session[];
  bindings: Map<string, string>;
  /** L'ordinale del pin, non un insieme: la mappa porta anche quando è stato messo. */
  pinned: Map<string, number>;
  sessionNotes: Map<string, string>;
  projectCore: string | null;
  projectName: string;
  taskRowData: TaskRowData;
  hiddenTasks: number;
  overlays: {
    assign: AssignOverlay;
    sheet: SheetOverlay;
    search: SearchOverlay;
    status: StatusOverlay;
    inbox: InboxOverlay;
    wrap: WrapOverlay;
  };
};

/**
 * Sceglie la schermata sostitutiva attiva, o `null` per restare sulla lista.
 *
 * L'ordine dei rami è quello che avevano in `cli.tsx` e non è indifferente: i
 * modi si escludono a vicenda, ma `detail`, `status` e `inbox` chiedono anche
 * che il proprio contenuto esista (`sheet.sheet`, `status.view`, `inbox.sheet`)
 * — un modo dichiarato senza contenuto deve cadere alla lista, non a una
 * schermata vuota.
 */
export function screenFor(input: ScreensInput) {
  const { mode, rows, columns, note, overlays } = input;
  const { assign, sheet, search, status, inbox, wrap } = overlays;

  // ── T57 · schermata di assegnazione ─────────────────────────────────────
  // Sostitutiva come ricerca e reader (D3): la lista task non entra in un box
  // sopra i due pane, e prendendo l'intero frame non costa nulla al loro budget.
  // Conseguenza obbligata della scelta: la sessione in assegnazione non è più
  // visibile, quindi va RIPETUTA nel titolo — senza, non si sa più su cosa si
  // sta agendo.
  if (mode === 'assign') {
    if (isCompact(assign.capacity)) {
      return <CompactNotice what="assegna" esc="annulla" rows={rows} columns={columns} />;
    }
    const at = assign.list.findIndex((t) => (t?.id ?? null) === assign.sel);
    const win = windowRange(assign.list.length, at, assign.capacity);
    const s = assign.sid
      ? input.sessions.find((x) => x.sessionId === assign.sid) ?? null
      : null;
    // Etichetta della conversazione: la nota umana se c'è (è il nome con cui la
    // riconosci), altrimenti la stessa derivazione della ricerca. Su una pinnata
    // stale non resta nulla: il titolo si accontenta dell'hash.
    const label =
      (assign.sid ? input.sessionNotes.get(assign.sid) : '') ||
      (s
        ? conversationLabel(
            s,
            input.projectCore,
            assign.sid ? input.bindings.get(assign.sid) : undefined,
          )
        : '');
    // T124 — le colonne si misurano sulla lista FILTRATA di questa schermata,
    // non su `paneTasks`: la popolazione è un'altra, e riusare le larghezze del
    // pane darebbe una colonna dimensionata su righe che qui non ci sono.
    // `assign.list` porta in testa la riga `detach` (`null`), che non è una task.
    const assignCols = taskColumns(
      assign.list.filter((t): t is Task => t !== null),
      input.taskRowData,
    );
    return (
      <AssignScreen
        sessionId={assign.sid ?? ''}
        label={label}
        current={assign.sid ? input.bindings.get(assign.sid) ?? null : null}
        filter={assign.filter}
        rows={assign.list.slice(win.start, win.end)}
        selected={assign.sel}
        matched={assign.list.length - 1}
        hidden={input.hiddenTasks}
        above={win.start}
        below={assign.list.length - win.end}
        idW={assignCols.id}
        tailW={assignCols.tail}
        data={input.taskRowData}
        columns={columns}
        note={note}
      />
    );
  }

  // ── T66 · detail della task ─────────────────────────────────────────────
  // Quarta schermata sostitutiva, stessa ragione delle altre tre: un task file
  // non entra in un box sopra i due pane. Il budget dei pane non viene nemmeno
  // calcolato — il render esce di qui prima.
  if (mode === 'detail' && sheet.sheet) {
    if (isCompact(sheet.capacity)) {
      return (
        <CompactNotice what={sheet.sheet.id} esc="chiude" rows={rows} columns={columns} />
      );
    }
    // Niente `windowRange`: quella centra la finestra su una selezione, qui la
    // posizione è lo scroll mosso a mano. Il clamp serve comunque — un resize
    // può accorciare il testo sotto uno scroll già dato.
    const start = Math.min(sheet.top, sheet.maxTop);
    return (
      <DetailScreen
        id={sheet.sheet.id}
        title={sheet.sheet.title}
        missing={sheet.sheet.text === null}
        lines={sheet.lines.slice(start, start + sheet.capacity)}
        spans={sheet.doc?.spans ?? []}
        top={start}
        total={sheet.lines.length}
        capacity={sheet.capacity}
        action={sheet.action}
        model={sheet.model}
        spawnNote={sheet.spawnNote}
        prompt={sheet.prompt}
        cursor={sheet.cursor}
        columns={columns}
        find={sheet.find}
        occ={sheet.findRes.occ}
        occCur={sheet.occCur}
      />
    );
  }

  // ── T121 · viewer del project status ────────────────────────────────────
  // Quinta schermata sostitutiva, stessa ragione delle altre quattro: un recap
  // di progetto è lungo quanto un task file e non entra in un box sopra i pane.
  if (mode === 'status' && status.view) {
    if (isCompact(status.capacity)) {
      return (
        <CompactNotice what="project status" esc="chiude" rows={rows} columns={columns} />
      );
    }
    // Il clamp serve anche qui: un resize può accorciare il testo sotto uno
    // scroll già dato.
    const start = Math.min(status.top, status.maxTop);
    return (
      <StatusScreen
        name={input.projectCore ?? input.projectName}
        label={status.label}
        building={status.building}
        failed={status.failed}
        view={status.view}
        lines={status.lines.slice(start, start + status.capacity)}
        spans={status.doc?.spans ?? []}
        top={start}
        total={status.lines.length}
        capacity={status.capacity}
        columns={columns}
      />
    );
  }

  // ── T134 · detail di un file inbox ──────────────────────────────────────
  // Sesta schermata sostitutiva, stessa ragione delle altre cinque: un file di
  // nozioni supera i 28KB, cioè è più lungo di ogni task file del progetto.
  if (mode === 'inbox' && inbox.sheet) {
    if (isCompact(inbox.capacity)) {
      return (
        <CompactNotice
          what={inbox.sheet.file.basename}
          esc="chiude"
          rows={rows}
          columns={columns}
        />
      );
    }
    // Il clamp serve anche qui: un resize può accorciare il testo sotto uno
    // scroll già dato.
    const start = Math.min(inbox.top, inbox.maxTop);
    return (
      <InboxScreen
        file={inbox.sheet.file}
        missing={inbox.sheet.text === null}
        lines={inbox.lines.slice(start, start + inbox.capacity)}
        spans={inbox.doc?.spans ?? []}
        top={start}
        total={inbox.lines.length}
        capacity={inbox.capacity}
        prompt={inbox.prompt}
        columns={columns}
      />
    );
  }

  // ── T134 · lista hard-wrap ──────────────────────────────────────────────
  // Settima schermata sostitutiva: sul cappello lo scan trova 77 `WRAP` e 147
  // `misto`, cioè una lista che in un box sopra i pane non entrerebbe.
  if (mode === 'wrap' && wrap.files) {
    if (isCompact(wrap.capacity)) {
      return <CompactNotice what="hard-wrap" esc="chiude" rows={rows} columns={columns} />;
    }
    const start = Math.min(wrap.top, wrap.maxTop);
    return (
      <WrapScreen
        files={wrap.files.slice(start, start + wrap.capacity)}
        count={wrap.count}
        mixed={wrap.mixed}
        mtime={wrap.mtime}
        top={start}
        capacity={wrap.capacity}
        path={wrap.path}
        caret={wrap.caret}
        columns={columns}
      />
    );
  }

  // ── T52 · ricerca e reader ──────────────────────────────────────────────
  // Gli unici modali che NON stanno in flusso sopra i pane: una lista di
  // occorrenze non entra in un box da 4 righe. Prendono l'intero frame, quindi
  // escono di qui — il budget dei due pane sotto non serve nemmeno calcolarlo,
  // e la loro altezza la distribuiscono `searchListCapacity` / `readerCapacity`.
  if (mode === 'search' || mode === 'reader') {
    const hit =
      mode === 'reader' && search.readerRow?.kind === 'hit' ? search.readerRow.hit : null;
    // Terminale sotto la cornice: riga singola invece del box, per lo stesso
    // motivo del `budget.compact` del deck — un frame più alto di `rows` fa
    // pulire lo schermo a Ink a ogni redraw, e il poll lo versa nello scrollback.
    if (isCompact(hit ? search.readerCap : search.listCap)) {
      return (
        <CompactNotice
          what={hit ? 'reader' : 'ricerca'}
          esc={hit ? 'torna' : 'chiude'}
          rows={rows}
          columns={columns}
        />
      );
    }
    if (hit) {
      // Niente `windowRange`: quella centra la finestra su una SELEZIONE, qui
      // la posizione è lo scroll che l'utente muove a mano. Il clamp serve
      // comunque — un resize può accorciare il testo sotto uno scroll già dato.
      const start = Math.min(search.readerTop, search.readerMaxTop);
      return (
        <ReaderScreen
          hit={hit}
          lines={search.readerLines.slice(start, start + search.readerCap)}
          top={start}
          total={search.readerLines.length}
          capacity={search.readerCap}
          bound={input.bindings.get(hit.sessionId) ?? null}
        />
      );
    }
    const selIdx = rowIndexOfKey(search.rows, search.selKey);
    const win = windowRange(search.rows.length, selIdx, search.listCap);
    // Anteprima dell'occorrenza selezionata: prende le righe che la lista non
    // usa. Con molti risultati `spare` è 0 e il pannello non esiste — la lista
    // se le riprende tutte, che è la priorità giusta quando c'è molto da
    // scorrere. La finestra si CENTRA sul match (`windowRange`), così il
    // contesto arriva da entrambi i lati.
    const spare = searchPreviewCapacity(search.listCap, win.end - win.start);
    let preview = null;
    if (spare >= 1 && search.selRow?.kind === 'hit') {
      const h = search.selRow.hit;
      const mline = Math.max(0, search.previewBody.findIndex((l) => l.end > h.matchStart));
      const pw = windowRange(search.previewBody.length, mline, spare);
      preview = {
        hit: h,
        lines: search.previewBody.slice(pw.start, pw.end),
        from: pw.start,
        total: search.previewBody.length,
        ts: input.sessions.find((s) => s.sessionId === h.sessionId)?.ts ?? 0,
      };
    }
    return (
      <SearchScreen
        preview={preview}
        hash={search.hash}
        query={search.query}
        field={search.field}
        opts={search.opts}
        result={search.result}
        rows={search.rows.slice(win.start, win.end)}
        selectedKey={search.selKey}
        selectedKind={selectedRow(search.rows, search.selKey)?.kind ?? null}
        above={win.start}
        below={search.rows.length - win.end}
        capacity={search.listCap}
        bindings={input.bindings}
        pinned={input.pinned}
        sessionNotes={input.sessionNotes}
        projectCore={input.projectCore}
        columns={columns}
        note={note}
      />
    );
  }

  return null;
}

/**
 * I due box di testo in flusso — create e nota — e i tre modali che li
 * accompagnano stanno in `ui/modals.tsx`; qui resta il solo `CreateBox`, che
 * non aveva una casa perché nato come JSX inline nel corpo del deck.
 *
 * Il cursore sta in coda al testo (append only): un cursore mobile vorrebbe
 * gestire frecce e Home/End, e `Home`/`End` non sono nemmeno esposte da
 * `useInput`.
 */
export function TextBox({ glyph, value }: { glyph: string; value: string }) {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow">{glyph} › </Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

/** Ri-esportato perché `screenFor` e la lista compatta lo usano dallo stesso posto. */
export type { ViewState };
