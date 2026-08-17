// I due pane della vista principale — task e sessioni — con i rispettivi
// header. Sono presentazionali puri: ricevono la vista già selezionata e le
// larghezze già calcolate, non li derivano.
import { Box, Text } from 'ink';
import { cut, cutParts, pad, sanitize, termWidth } from '../width.js';
import { isDone, paneTextWidth } from '../layout.js';
import {
  CARET,
  CARET_OFF,
  LIVE_BUSY,
  LIVE_IDLE,
  LIVE_NONE,
  SESSION_SEP,
  SID_CHARS,
  TASK_EMPTY,
  WARN,
  displayProg,
  relTime,
} from '../glyphs.js';
import { META_ROWS, ROW_ALL, ROW_SPOT } from '../model.js';
import { rowLabel, sessionTitle, type SessionRow } from '../session-list.js';
import {
  sessionView,
  taskView,
  SESSION_VIEWS,
  TASK_VIEWS,
  type SessionViewCounts,
  type SessionViewId,
  type TaskViewCounts,
  type TaskViewId,
} from '../pane-views.js';
import { describeSort, PRI_ENTRIES, PROG_ENTRIES, type ViewState } from '../view.js';
import type { Task } from '../tasks.js';
import type { Session } from '../sessions.js';
import type { LiveSession } from '../live-sessions.js';

/**
 * Header del pane task, tagliato QUI e non da Ink — stesso motivo del gemello
 * `SessionsHeader`, con una differenza di rischio: qui i segmenti sono tutti
 * ASCII più le frecce `↑↓` (larghe 1), quindi `cli-truncate` oggi darebbe la
 * riga giusta per caso. Il taglio resta del deck perché la correttezza non deve
 * dipendere dall'alfabeto che capita nella riga: il primo glifo largo 2 che
 * entrasse in un segmento nuovo riaprirebbe il difetto in silenzio, e a
 * scoprirlo sarebbe il bordo del pane a schermo.
 *
 * `truncate-end` taglia dalla coda, e `cutParts` conserva l'ordine: l'ultimo
 * segmento resta il primo a cedere il posto (`↑↓` in coda alle voci navigabili).
 *
 * T100 — la riga non è più informativa: le voci del catalogo sono SELEZIONABILI
 * con `tab`, e l'attiva si distingue in video inverso (D5 — costa 0 colonne e non
 * entra in gara con la semantica di colore già occupata). Le voci ci sono tutte
 * anche a 0 (D1): un catalogo che si accorcia sposta le voci sotto le dita.
 * L'ordine è vincolato — le navigabili PRIMA di `↑N`/`↓N`, che cadono per primi
 * su un terminale stretto — e la voce attiva ha la precedenza sul budget (D6).
 */
export function TasksHeader({
  counts,
  active,
  above,
  below,
  focused,
  columns,
}: {
  counts: TaskViewCounts;
  active: TaskViewId;
  above: number;
  below: number;
  focused: boolean;
  columns: number;
}) {
  const views = TASK_VIEWS.map((v, i) => {
    const n = v.count(counts);
    return {
      // Il separatore sta nel segmento, non fra i segmenti: `cutParts` misura la
      // riga pezzo per pezzo e uno spazio fuori dai pezzi non verrebbe contato.
      text: `${i > 0 ? ' · ' : ''}${v.label(counts)}`,
      color: v.color,
      dim: v.dim || n === 0,
      active: v.id === active,
    };
  });
  const segments = [
    ...views,
    { text: above > 0 ? ` · ↑${above}` : '', dim: true, active: false, color: undefined },
    { text: below > 0 ? ` · ↓${below}` : '', dim: true, active: false, color: undefined },
  ];
  const shown = cutParts(
    segments.map((s) => s.text),
    paneTextWidth(columns),
    segments.findIndex((s) => s.active),
  );
  return (
    <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
      {segments.map((seg, i) =>
        shown[i] ? (
          <Text key={i} color={seg.color} dimColor={seg.dim} inverse={seg.active}>
            {shown[i]}
          </Text>
        ) : null,
      )}
    </Text>
  );
}

export function TasksPane({
  tasks,
  counts,
  activeView,
  paneCount,
  view,
  selected,
  spotCount,
  allCount,
  childCount,
  focused,
  loadError,
  windowStart,
  above,
  below,
  columns,
}: {
  /** Solo la finestra visibile, non la lista completa. */
  tasks: Task[];
  /** T100 — i contatori delle tre voci del catalogo, misurati sulla vista di
   *  default: l'header è un selettore, non un riassunto di ciò che si vede. */
  counts: TaskViewCounts;
  activeView: TaskViewId;
  /** Righe della vista ATTIVA (non `tasks.length`, che è la sola finestra): 0 →
   *  nota della vista vuota al posto della lista. */
  paneCount: number;
  view: ViewState;
  /** Indice nella lista COMPLETA (0 = riga "tutte", 1 = riga spot). */
  selected: number;
  spotCount: number;
  /** T59 — conversazioni totali del progetto (badge della riga "tutte"). */
  allCount: number;
  childCount: Map<string, number>;
  focused: boolean;
  loadError: string;
  /** Offset della finestra nella lista completa. */
  windowStart: number;
  /** Task fuori finestra sopra / sotto. */
  above: number;
  below: number;
  columns: number;
}) {
  const allSelected = selected === ROW_ALL;
  const spotSelected = selected === ROW_SPOT;
  return (
    <Box
      flexDirection="column"
      width="50%"
      marginRight={1}
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {/* Truncation MAI silenziosa: con un filtro attivo il conteggio delle
          nascoste è sempre a schermo, come `+N più vecchie` per le sessioni.
          Il deck non finge mai una lista completa.

          Le task fuori finestra sono un secondo tipo di invisibile, distinto
          dalle filtrate: non sono escluse dalla vista, solo oltre il bordo del
          terminale. Il contatore ↑↓ sta nell'header perché una riga dedicata
          costerebbe proprio la riga di lista che sta segnalando come mancante.

          T61 — `archiviabili` va IN CODA e in dimColor, non accanto a
          `nascoste`. Il colore: `yellow` su `nascoste` avverte che la vista è
          distorta da un filtro, mentre le Done oltre soglia non alterano ciò
          che stai guardando — sono informative, non urgenti. La posizione:
          `truncate-end` taglia dalla fine, quindi l'ultimo segmento è il primo
          a sparire su un terminale stretto, ed è giusto che a cedere il posto
          sia questo e non i contatori della vista corrente. */}
      <TasksHeader
        counts={counts}
        active={activeView}
        above={above}
        below={below}
        focused={focused}
        columns={columns}
      />
      {/* La riga sort/filtri è tutta dim: un pezzo solo, quindi `cut` basta e
          `cutParts` sarebbe cerimonia. Ma il taglio va fatto lo stesso QUI — i
          filtri elencano i glifi di priorità e stato (`−🔥 −⚡`), larghi 2, cioè
          la stessa condizione che sull'header delle sessioni faceva sparire il
          bordo. Si sanifica PRIMA di misurare (invariante ①: `✔` largo 1 diventa
          `✅` largo 2, e chi taglia deve contare le colonne disegnate). */}
      <Text dimColor wrap="truncate-end">
        {cut(
          sanitize(
            `sort: ${describeSort(view.sort)}` +
              (view.hiddenPri.length + view.hiddenProg.length > 0
                ? ' · filtri: ' +
                  [
                    ...PRI_ENTRIES.filter((e) => view.hiddenPri.includes(e.name)),
                    ...PROG_ENTRIES.filter((e) => view.hiddenProg.includes(e.name)),
                  ]
                    .map((e) => `−${e.glyph}`)
                    .join(' ')
                : ''),
          ),
          paneTextWidth(columns),
        )}
      </Text>
      {/* T59 — riga meta "tutte" come PRIMA voce: ogni conversazione del
          progetto, scoped e spot insieme. È l'unica vista da cui una sessione
          legata a una task è raggiungibile senza sapere a quale. */}
      <Text inverse={allSelected && focused} bold={allSelected && !focused} wrap="truncate-end">
        {allSelected ? CARET : CARET_OFF}
        ≡ tutte le sessioni{allCount > 0 ? ` (${allCount})` : ''}
      </Text>
      {/* riga meta "spot": sessioni non legate ad alcuna task */}
      <Text inverse={spotSelected && focused} bold={spotSelected && !focused} wrap="truncate-end">
        {spotSelected ? CARET : CARET_OFF}
        ○ spot  sessioni libere{spotCount > 0 ? ` (${spotCount})` : ''}
      </Text>
      {loadError ? (
        <Text color="red" wrap="truncate-end">{loadError}</Text>
      ) : paneCount === 0 ? (
        // T100/D1 — una voce a contatore 0 resta navigabile, e selezionarla dà
        // una lista vuota che DICE perché è vuota. Senza la nota il pane si
        // legge come rotto: le righe meta restano, le task no, e niente spiega
        // che è la vista scelta a non contenere nulla.
        <Text color="yellow" wrap="truncate-end">
          {cut(taskView(activeView).empty, paneTextWidth(columns))}
        </Text>
      ) : (
        tasks.map((task, i) => {
          // windowStart riporta l'indice di finestra a quello della lista
          // completa, su cui è keyata la selezione. +META_ROWS: le prime due
          // righe sono le meta.
          const sel = windowStart + i + META_ROWS === selected;
          const n = childCount.get(task.id) ?? 0;
          // Invariante ③: la descrizione è l'unico pezzo a lunghezza libera, e
          // si taglia QUI sul budget che resta dopo le colonne fisse. Lasciarlo
          // fare a `truncate-end` significa passare da `cli-truncate`, che
          // restituisce una riga più larga del pane (una colonna per emoji) e
          // quindi scrive sopra il bordo. Le parti fisse si misurano con
          // `termWidth`: `task.id` è `T9` o `T52`, i due glifi valgono 2 ciascuno.
          const head = `${CARET_OFF}${task.id}  ${sanitize(task.pri)}  ${displayProg(task.prog)}  `;
          const tail = n > 0 ? ` (${n})` : '';
          const desc = cut(
            task.desc,
            Math.max(4, paneTextWidth(columns) - termWidth(head) - termWidth(tail)),
          );
          return (
            <Text
              key={task.id}
              inverse={sel && focused}
              bold={sel && !focused}
              dimColor={!sel && isDone(task.prog)}
              wrap="truncate-end"
            >
              {sel ? CARET : CARET_OFF}
              {task.id}  {sanitize(task.pri)}  {displayProg(task.prog)}  {desc}
              {tail}
            </Text>
          );
        })
      )}
    </Box>
  );
}

/**
 * Header del pane sessioni, tagliato QUI e non da Ink.
 *
 * `📌{pinnedCount}` è un glifo largo 2 in mezzo alla riga: con
 * `wrap="truncate-end"` il taglio passava da `cli-truncate`, che indicizza per
 * code point con un budget in colonne e restituiva una riga larga 45 su un
 * budget di 44 — la colonna in più finiva sopra il bordo destro del pane, che
 * spariva dalla riga (invariante ③ di `width.ts`).
 *
 * I segmenti restano segmenti fino al render: il taglio è della RIGA (budget
 * condiviso, `cutParts`), la resa è del pezzo. Il giallo su `📌N` distingue le
 * pinnate dal resto dell'header e non è decorazione.
 */
export function SessionsHeader({
  parentLabel,
  counts,
  active,
  above,
  below,
  focused,
  columns,
}: {
  parentLabel: string;
  /** T62 — le vive sono quelle delle righe MOSTRATE, contate sulla lista
   *  assemblata e non sul registry: le vive di un altro parent non sono in
   *  questa lista, e un numero più grande di quello che si vede si legge come un
   *  bug. T100 — «mostrate» = la vista di default, ferma sotto le frecce. */
  counts: SessionViewCounts;
  active: SessionViewId;
  above: number;
  below: number;
  focused: boolean;
  columns: number;
}) {
  const views = SESSION_VIEWS.map((v) => {
    const n = v.count(counts);
    return {
      text: ` · ${v.label(counts, parentLabel)}`,
      color: v.color,
      dim: v.dim || n === 0,
      active: v.id === active,
    };
  });
  const segments = [
    // `Sessions` non è una voce del catalogo: nomina il pane, non un
    // sottoinsieme, quindi non è raggiungibile con le frecce.
    { text: 'Sessions', color: undefined, dim: false, active: false },
    ...views,
    { text: above > 0 ? ` · ↑${above}` : '', dim: true, active: false, color: undefined },
    { text: below > 0 ? ` · ↓${below}` : '', dim: true, active: false, color: undefined },
  ];
  const shown = cutParts(
    segments.map((s) => s.text),
    paneTextWidth(columns),
    segments.findIndex((s) => s.active),
  );
  return (
    <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
      {segments.map((seg, i) =>
        shown[i] ? (
          <Text key={i} color={seg.color} dimColor={seg.dim} inverse={seg.active}>
            {shown[i]}
          </Text>
        ) : null,
      )}
    </Text>
  );
}

export function SessionsPane({
  parentLabel,
  isSpot,
  isAll,
  bindings,
  taskW,
  ageW,
  rows,
  counts,
  activeView,
  paneCount,
  selectedId,
  focused,
  above,
  below,
  columns,
  forkOf,
  sessionNotes,
  projectCore,
  live,
}: {
  parentLabel: string;
  isSpot: boolean;
  /** T59 — vista "tutte": la lista mescola scoped e spot, quindi il marker di
   *  riga non può più venire dal parent (vedi il render sotto). */
  isAll: boolean;
  /** T59 — sessionId → taskId, letto dal sidecar. Serve SOLO alla vista "tutte",
   *  l'unica dove l'appartenenza non è desumibile dal parent selezionato. */
  bindings: Map<string, string>;
  /** T60 — larghezza della colonna task; 0 = colonna assente. Fuori dalla vista
   *  "tutte" la cella si riempie solo sulle righe pinnate: le contestuali
   *  condividono il binding dell'header, e ripeterlo N volte direbbe ciò che
   *  l'header dice una. */
  taskW: number;
  /** T60 — larghezza della colonna data, ancorata al margine destro. */
  ageW: number;
  /** T50 — solo la finestra visibile della lista a due gruppi (pinnate +
   *  separatore + contestuali). T100 — della vista attiva, non più
   *  necessariamente di quella di default. */
  rows: SessionRow[];
  /** T100 — contatori delle 4 voci del catalogo, tutti misurati sulla vista di
   *  default: l'header è un selettore e le sue cifre non si muovono navigando. */
  counts: SessionViewCounts;
  activeView: SessionViewId;
  /** Righe della vista ATTIVA (non `rows.length`, che è la sola finestra). */
  paneCount: number;
  selectedId: string | undefined;
  focused: boolean;
  /** T28 — sessionId → origine, per marcare i rami nella lista. */
  forkOf: Map<string, string>;
  /** Sessioni fuori finestra sopra / sotto. */
  above: number;
  below: number;
  columns: number;
  /** T53 — sessionId → nota umana (solo le sessioni annotate). */
  sessionNotes: Map<string, string>;
  /** `name` del progetto: il prefisso che la nota fa sparire. */
  projectCore: string | null;
  /** T62 — sessionId → processo vivo. Assente dalla mappa = conversazione
   *  chiusa (o aperta in un processo che non la sta più scrivendo, dopo un
   *  `/clear`: il flag dice «questo transcript è l'attivo di un processo vivo»,
   *  non «la tab esiste ancora»). */
  live: Map<string, LiveSession>;
}) {
  return (
    <Box
      flexDirection="column"
      width="50%"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <SessionsHeader
        parentLabel={parentLabel}
        counts={counts}
        active={activeView}
        above={above}
        below={below}
        focused={focused}
        columns={columns}
      />
      {paneCount === 0 ? (
        // T100 — la nota della vista di default resta quella storica, che nomina
        // il PARENT (task, spot o tutte); le altre tre viste portano la propria,
        // che nomina il sottoinsieme. Sono due vuoti diversi: «questo parent non
        // ha conversazioni» e «questo sottoinsieme del parent è vuoto».
        <Text color="yellow" wrap="truncate-end">
          {cut(
            sessionView(activeView).empty ??
              (isAll
                ? 'nessuna conversazione nel progetto'
                : isSpot
                  ? 'nessuna sessione libera'
                  : 'nessuna sessione legata a questa task'),
            paneTextWidth(columns),
          )}
        </Text>
      ) : (
        rows.map((row, i) => {
          // T50 — separatore leggero fra pinnate e contestuali: riga dim, non un
          // box pesante (coerente con lo styling delle Done dimmate).
          if (row.kind === 'separator') {
            return (
              <Text key={`sep${i}`} dimColor wrap="truncate-end">
                {SESSION_SEP}
              </Text>
            );
          }
          const sel = row.sessionId === selectedId;
          // T50 — pin stale: transcript sparito, nessuna Session da mostrare.
          // Riga navigabile e spinnabile (`p`), marcata, mai un crash.
          if (row.kind === 'pinned' && row.stale) {
            // T60 — anche qui la nota si taglia sul budget DERIVATO, non su un
            // 30 inchiodato: su un pane stretto quel valore fisso mandava la
            // riga oltre il bordo, e a ripararla arrivava `cli-truncate` (che
            // sfora di una colonna per emoji e mangia il bordo stesso).
            const staleNote = sessionNotes.get(row.sessionId);
            // La riga stale è libera (niente colonne: non ha né titolo né
            // data), ma il binding va detto lo stesso — è una pinnata, quindi
            // l'header del pane non ne dice l'appartenenza.
            const staleTask = bindings.get(row.sessionId) ?? null;
            const staleW = Math.max(
              0,
              paneTextWidth(columns) -
                (2 /* caret */ +
                  termWidth(`${WARN} pin stale `) +
                  SID_CHARS +
                  (staleTask ? termWidth(staleTask) + 1 : 0) +
                  3 /* spazio + caporali */),
            );
            return (
              <Text
                key={row.sessionId}
                inverse={sel && focused}
                bold={sel && !focused}
                dimColor
                wrap="truncate-end"
              >
                {sel ? CARET : CARET_OFF}
                <Text color="yellow">{WARN}</Text> pin stale{' '}
                <Text dimColor>{row.sessionId.slice(0, SID_CHARS)}</Text>
                {staleTask ? <Text color="green"> {staleTask}</Text> : null}
                {/* T53 — su una riga stale la nota è l'UNICA cosa rimasta che
                    dica cosa fosse quella conversazione: il transcript non c'è
                    più, quindi non esiste titolo né primo prompt da mostrare. */}
                {staleNote ? <Text color="yellow"> «{cut(staleNote, staleW)}»</Text> : null}
              </Text>
            );
          }
          const s = row.session as Session; // non-stale → session presente
          const isPinnedRow = row.kind === 'pinned';
          // T28 — un ramo eredita il titolo dell'origine: senza marcatore le due
          // righe sarebbero identiche a occhio.
          const forked = forkOf.has(s.sessionId);
          // T59 D2 — nella vista "tutte" il marker è PER-SESSIONE (binding letto
          // dal sidecar) e non deciso dal parent: la lista mescola scoped e spot,
          // quindi un marker uniforme mentirebbe su metà delle righe. E il solo
          // glifo direbbe *che* la conversazione è legata senza dire *a cosa* —
          // informazione monca proprio qui, l'unica vista dove l'appartenenza
          // non è scritta da nessun'altra parte dello schermo: da qui la colonna
          // task accanto, che esiste solo in questa vista.
          const bound = bindings.get(s.sessionId) ?? null;
          const linked = isAll ? Boolean(bound) : !isSpot;
          // T62 — liveness e binding sono ORTOGONALI: la cella marker dice a chi
          // appartiene la conversazione (pin/task/spot), questa dice se è aperta
          // adesso. Farle condividere una cella perderebbe una delle due.
          const liveEntry = live.get(s.sessionId);
          // Stesso motivo per cui la colonna esiste: una pinnata resta in lista
          // qualunque sia il parent selezionato, quindi l'header non ne dice
          // l'appartenenza e la cella va riempita anche fuori dalla vista
          // "tutte". Sulle contestuali, dove l'header parla già, resta vuota —
          // ma la cella è comunque larga `taskW`, o le colonne a destra
          // slitterebbero riga per riga.
          const taskCell = isAll || isPinnedRow ? (bound ?? TASK_EMPTY) : '';
          // T60 — colonne VERE: ogni cella fissa è larga esattamente quanto
          // dichiara, riempita di spazi con `pad` (che misura in colonne, non in
          // caratteri). Il marker va portato a 2 anche quando è `○`, largo 1:
          // era lui a far slittare a sinistra di una colonna tutta la riga di
          // ogni sessione spot.
          const age = relTime(s.ts);
          // Il taglio del titolo è ciò che RESTA, calcolato per sottrazione: le
          // colonne fisse sono note, quindi l'unica cella elastica prende il
          // resto. Pavimento `0` e non un minimo di cortesia — è un tetto, non
          // una preferenza: alzarlo sopra lo spazio reale fa uscire la riga dal
          // pane e le mangia il bordo (invariante ③).
          const titleW = Math.max(
            0,
            paneTextWidth(columns) -
              (2 /* caret */ +
                2 /* marker */ +
                1 /* gutter */ +
                1 /* T62 · colonna liveness */ +
                SID_CHARS +
                1 /* gutter */ +
                (taskW > 0 ? taskW + 1 : 0) +
                1 /* gutter prima della data */ +
                ageW),
          );
          // T28 — `⑂` sta DENTRO la cella titolo, non in una colonna sua: una
          // colonna dedicata costerebbe 2 spazi vuoti su ogni riga non-fork, e
          // metterlo fuori cella sposterebbe il bordo del titolo solo sui rami —
          // cioè rimetterebbe lo slittamento che le colonne tolgono.
          const forkMark = forked ? '⑂ ' : '';
          const inner = Math.max(0, titleW - termWidth(forkMark));
          // T60 — il testo arriva già ripulito di ciò che le colonne accanto
          // dicono già (progetto e task id): senza, la cella conterrebbe
          // `🧵 loom-works · T59` accanto a una colonna che dice `T59`.
          const label = rowLabel(
            sessionTitle(s, projectCore, bound),
            sessionNotes.get(s.sessionId),
            inner,
          );
          const used =
            (label.note ? termWidth(label.note) + 2 : 0) +
            (label.note && label.rest ? 1 : 0) +
            termWidth(label.rest);
          return (
            <Text key={s.sessionId} inverse={sel && focused} bold={sel && !focused} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              {isPinnedRow ? (
                <Text color="yellow">{pad('📌', 2)}</Text>
              ) : linked ? (
                <Text color="green">{pad('🔗', 2)}</Text>
              ) : (
                <Text dimColor>{pad('○', 2)}</Text>
              )}{' '}
              <Text color={liveEntry ? (liveEntry.status === 'busy' ? 'yellow' : 'green') : undefined}>
                {liveEntry ? (liveEntry.status === 'busy' ? LIVE_BUSY : LIVE_IDLE) : LIVE_NONE}
              </Text>
              <Text color={liveEntry ? (liveEntry.status === 'busy' ? 'yellow' : 'green') : 'cyan'} bold={Boolean(liveEntry)}>
                {s.sessionId.slice(0, SID_CHARS)}
              </Text>{' '}
              {taskW > 0 ? (
                <>
                  <Text color={bound && taskCell ? 'green' : undefined} dimColor={!bound}>
                    {pad(taskCell, taskW)}
                  </Text>
                  {' '}
                </>
              ) : null}
              {forkMark ? <Text color="magenta">{forkMark}</Text> : null}
              {label.note ? (
                <Text color="yellow" bold>«{label.note}»</Text>
              ) : null}
              {label.note && label.rest ? ' ' : null}
              {label.rest ? <Text dimColor={Boolean(label.note)}>{label.rest}</Text> : null}
              {' '.repeat(Math.max(0, inner - used))}{' '}
              <Text dimColor>{pad(age, ageW, 'right')}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
