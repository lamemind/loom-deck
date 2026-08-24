// Schermate SOSTITUTIVE della ricerca full-text (T52): lista delle occorrenze
// e reader del messaggio aperto. Prendono l'intero frame — il budget dei due
// pane non viene nemmeno calcolato.
import { Box, Text } from 'ink';
import { cut, sanitize, termWidth, type WrappedLine } from '../width.js';
import { sliceLine, type Occurrence } from '../text-search.js';
import { MIN_QUERY, type Hit, type SearchOptions, type SearchResult, type SearchRow } from '../search.js';
import { KIND_LABEL, type SearchField } from '../model.js';
import { conversationLabel, searchExcerptWidth, searchTitleWidth } from '../layout.js';
import { CARET, CARET_OFF, WARN, fmtDateTime } from '../glyphs.js';
import type { BodyKind } from '../sessions.js';

// T52 — marcatore compatto del tipo di corpo sulla riga-occorrenza. Due
// caratteri ASCII e non un'emoji: con più toggle accesi la colonna deve
// allinearsi, e i glifi BMP larghi 2 sono proprio la classe che Ink e il
// terminale misurano diversamente (vedi width.ts).
export const KIND_TAG: Record<BodyKind, string> = { ai: 'ai', tool: 'tl', human: 'hu' };

export const KIND_COLOR: Record<BodyKind, string> = { ai: 'cyan', tool: 'gray', human: 'green' };

/**
 * Riga di toggle del modale ricerca.
 *
 * La mappa tasto→significato è SEMPRE a schermo: `^R` da solo è opaco quanto lo
 * era il range `1-9` delle launch prima di T43.
 *
 * Lo stato acceso/spento passa da `[x]`/`[ ]`, non dal solo colore — stessa
 * convenzione del modale filtri. Il colore è ridondanza, non l'informazione: su
 * un terminale monocromo, o in una cattura di testo, sei toggle tutti uguali
 * non direbbero più quali sono attivi.
 */
export function ToggleHint({ opts }: { opts: SearchOptions }) {
  const flag = (on: boolean, key: string, label: string) => (
    <Text key={key} color={on ? 'green' : 'gray'} dimColor={!on} bold={on}>
      {'  '}
      {key}[{on ? 'x' : ' '}] {label}
    </Text>
  );
  return (
    <Text wrap="truncate-end">
      {flag(opts.regex, '^R', 'regex')}
      {flag(opts.caseSensitive, '^A', 'Aa')}
      {flag(opts.wholeWord, '^W', 'word')}
      <Text dimColor>{'  │'}</Text>
      {flag(opts.kinds.ai, '^B', 'IA')}
      {flag(opts.kinds.tool, '^T', 'tools')}
      {flag(opts.kinds.human, '^U', 'human')}
    </Text>
  );
}

/** Intestazione della lista: dice sempre quanto NON si sta vedendo (regex rotta,
 *  query troppo corta, occorrenze tagliate dal cap, righe fuori finestra). */
export function SearchListHeader({
  result,
  query,
  above,
  below,
}: {
  result: SearchResult;
  query: string;
  above: number;
  below: number;
}) {
  if (result.error) {
    return (
      <Text color="red" wrap="truncate-end">
        {WARN} regex non valida · {result.error}
      </Text>
    );
  }
  if (result.idle) {
    return (
      <Text dimColor wrap="truncate-end">
        {query.length === 0
          ? 'digita la chiave da cercare'
          : `almeno ${MIN_QUERY} caratteri (${query.length})`}
      </Text>
    );
  }
  if (result.shown === 0) {
    return (
      <Text color="yellow" wrap="truncate-end">
        nessuna occorrenza
      </Text>
    );
  }
  return (
    <Text bold wrap="truncate-end">
      {result.shown} occorrenze in {result.sessionCount} conversazioni
      {result.hidden > 0 ? <Text color="yellow"> · +{result.hidden} oltre il cap</Text> : null}
      {above > 0 ? <Text dimColor> · ↑{above}</Text> : null}
      {below > 0 ? <Text dimColor> · ↓{below}</Text> : null}
    </Text>
  );
}

/**
 * Schermata di ricerca full-text (T52).
 *
 * Due campi + toggle + lista di occorrenze. Con l'hash vuoto la lista è
 * raggruppata per conversazione: la riga-gruppo NON ripete il nome del progetto
 * (D3: sono tutte dello stesso progetto, sarebbe una colonna costante) e usa lo
 * spazio per ciò che distingue davvero una conversazione — hash, task legata,
 * titolo, data.
 */
/** Anteprima dell'occorrenza selezionata, già finestrata dal chiamante. */
export interface SearchPreview {
  hit: Hit;
  lines: WrappedLine[];
  /** Indice della prima riga mostrata, nel corpo intero. */
  from: number;
  total: number;
  /** Ultima attività della conversazione (ms epoch); 0 = non risolta. */
  ts: number;
}

export function SearchScreen({
  preview,
  hash,
  query,
  field,
  opts,
  result,
  rows,
  selectedKey,
  selectedKind,
  above,
  below,
  capacity,
  bindings,
  pinned,
  sessionNotes,
  projectCore,
  columns,
  note,
}: {
  /** null = nessuna occorrenza selezionata, o nessuna riga avanzata. */
  preview: SearchPreview | null;
  hash: string;
  query: string;
  field: SearchField;
  opts: SearchOptions;
  result: SearchResult;
  /** Solo la finestra visibile della lista. */
  rows: SearchRow[];
  selectedKey: string | null;
  /** Tipo della riga selezionata: decide cosa promette `⏎` nell'hint. */
  selectedKind: SearchRow['kind'] | null;
  above: number;
  below: number;
  capacity: number;
  bindings: Map<string, string>;
  pinned: Map<string, number>;
  /** T53 — sessionId → nota umana (solo le sessioni annotate). */
  sessionNotes: Map<string, string>;
  /** `name` del progetto: prefisso da togliere ai titoli di tab. */
  projectCore: string | null;
  columns: number;
  note: string;
}) {
  const enter =
    selectedKind === 'session' ? 'resume' : selectedKind === 'hit' ? 'leggi' : '—';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        ricerca · <Text color="yellow">tab</Text> campo · <Text color="yellow">↑↓</Text> naviga ·{' '}
        <Text color="yellow">⏎</Text> {enter} · <Text color="yellow">esc</Text> chiudi
      </Text>
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>hash   </Text>
          <Text color={field === 'hash' ? 'yellow' : undefined}>{hash}</Text>
          {field === 'hash' ? <Text inverse> </Text> : null}
          {!hash ? <Text dimColor>  (vuoto = tutte le conversazioni)</Text> : null}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>chiave </Text>
          <Text color={field === 'query' ? 'yellow' : undefined}>{query}</Text>
          {field === 'query' ? <Text inverse> </Text> : null}
        </Text>
        <ToggleHint opts={opts} />
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <SearchListHeader result={result} query={query} above={above} below={below} />
        {rows.slice(0, Math.max(0, capacity)).map((row) => {
          const sel = row.key === selectedKey;
          if (row.kind === 'session') {
            const s = row.session;
            const bound = bindings.get(s.sessionId);
            const rowNote = sessionNotes.get(s.sessionId);
            const noteShown = rowNote ? cut(rowNote, 24) : '';
            // `+3` = i due caporali e lo spazio che li separa dall'etichetta.
            // Il pavimento non è cosmetico: senza, un terminale stretto manda
            // l'argomento di `cut` sotto zero, cioè un budget negativo.
            // La nota si misura con `termWidth`, non con `.length`: contiene
            // testo umano, emoji compresi.
            const restWidth = Math.max(
              8,
              searchTitleWidth(columns) - (noteShown ? termWidth(noteShown) + 3 : 0),
            );
            return (
              <Text key={row.key} inverse={sel} wrap="truncate-end">
                {sel ? CARET : CARET_OFF}
                {pinned.has(s.sessionId) ? <Text color="yellow">📌</Text> : <Text dimColor>○</Text>}{' '}
                <Text color="cyan">{s.sessionId.slice(0, 8)}</Text>
                <Text dimColor> · </Text>
                {bound ?? <Text dimColor>spot</Text>}
                <Text dimColor> · </Text>
                {/* T53 — la nota precede l'etichetta derivata: se l'hai scritta
                    è perché è il nome con cui riconosci quella conversazione, e
                    non ritrovarla qui col nome che ha in lista sarebbe il
                    difetto peggiore proprio dentro la ricerca. */}
                {noteShown ? <Text color="yellow" bold>«{noteShown}» </Text> : null}
                <Text dimColor={Boolean(noteShown)}>
                  {cut(conversationLabel(s, projectCore, bound), restWidth)}
                </Text>
                <Text dimColor>
                  {'  '}({row.hitCount}
                  {row.hidden > 0 ? `+${row.hidden}` : ''}) {fmtDateTime(s.ts)}
                </Text>
              </Text>
            );
          }
          const h = row.hit;
          return (
            <Text key={row.key} inverse={sel} wrap="truncate-end">
              {sel ? CARET : CARET_OFF}
              <Text dimColor>{String(h.idx).padStart(4)}</Text>{' '}
              <Text color={KIND_COLOR[h.kind]}>{KIND_TAG[h.kind]}</Text>{' '}
              {/* Invariante ③: `excerptAround` ritaglia il contesto per indice
                  di carattere (deve, per non spostare gli offset del match), e
                  un estratto pieno di emoji vale più colonne di quante ne ha
                  chieste. Il taglio a colonne si fa qui, all'ultimo momento. */}
              {cut(h.excerpt, searchExcerptWidth(columns))}
            </Text>
          );
        })}
      </Box>
      {preview ? <SearchPreviewPane p={preview} /> : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}

/**
 * Anteprima dell'occorrenza selezionata, sotto la lista.
 *
 * Riempie le righe che la lista non usa: con pochi risultati il terminale
 * resterebbe vuoto per tre quarti, e il contesto attorno al match è proprio
 * ciò che serve per decidere se è l'occorrenza giusta. Nel caso comune evita
 * del tutto di aprire il reader.
 *
 * Si aggiorna navigando con le frecce, e la finestra è centrata sul match:
 * stessa `windowRange` della lista, stessa evidenziazione del reader
 * (`ReaderLine`) — nessuna primitiva nuova.
 */
export function SearchPreviewPane({ p }: { p: SearchPreview }) {
  const last = Math.min(p.total, p.from + p.lines.length);
  const occ = [{ start: p.hit.matchStart, end: p.hit.matchEnd }];
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text dimColor wrap="truncate-end">
        record {p.hit.idx} · {KIND_LABEL[p.hit.kind]}
        {p.ts ? ` · ${fmtDateTime(p.ts)}` : ''} · righe {p.from + 1}-{last} di {p.total} ·{' '}
        <Text color="yellow">⏎</Text> apre il reader
      </Text>
      {p.lines.map((l, i) => (
        <ReaderLine key={p.from + i} line={l} occ={occ} current={0} />
      ))}
    </Box>
  );
}

/**
 * Reader fullscreen (T52 · D8).
 *
 * Mostra il messaggio INTERO che contiene l'occorrenza, aperto già posizionato
 * sul match e con il match evidenziato. È un `mode` a sé, catturato prima del
 * ramo `search`: il modale ricerca resta montato sotto e su `esc` si ritrova
 * con query, toggle e selezione intatti.
 */
export function ReaderScreen({
  hit,
  lines,
  top,
  total,
  capacity,
  bound,
}: {
  hit: Hit;
  /** Solo la finestra visibile del testo wrappato. */
  lines: WrappedLine[];
  top: number;
  total: number;
  capacity: number;
  bound: string | null;
}) {
  const last = Math.min(total, top + capacity);
  const occ = [{ start: hit.matchStart, end: hit.matchEnd }];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        reader · <Text color="cyan">{hit.sessionId.slice(0, 8)}</Text> · record {hit.idx} ·{' '}
        {KIND_LABEL[hit.kind]}
        {bound ? ` · ${bound}` : ''} · righe {total === 0 ? 0 : top + 1}-{last} di {total}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">PgUp/PgDn</Text> ½ pagina ·{' '}
        <Text color="yellow">g</Text> inizio · <Text color="yellow">G</Text> fine ·{' '}
        <Text color="yellow">esc</Text> torna alla lista
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {lines.map((l, i) => (
          <ReaderLine key={top + i} line={l} occ={occ} current={0} />
        ))}
      </Box>
    </Box>
  );
}

/** Una riga con le porzioni di match evidenziate. Gli offset sono quelli del
 *  testo sorgente, quindi un match a cavallo dell'a-capo si colora su entrambe
 *  le righe senza casi speciali — entrambe intersecano il suo intervallo.
 *
 *  Regge N occorrenze perché il detail (T91) ne mostra tutte quelle visibili; il
 *  reader (T52) ne passa una sola, che è il caso degenere dello stesso taglio. */
export function ReaderLine({
  line,
  occ,
  current,
}: {
  line: WrappedLine;
  occ: readonly Occurrence[];
  /** Indice in `occ` dell'occorrenza su cui si è posizionati; -1 = nessuna. */
  current: number;
}) {
  const segs = sliceLine(line.text, line.start, occ, current);
  if (segs.length === 0) return <Text wrap="truncate-end">{line.text || ' '}</Text>;
  return (
    <Text wrap="truncate-end">
      {segs.map((s, i) =>
        s.hit ? (
          // La corrente si distingue dalle altre per COLORE di sfondo, non per
          // presenza: tutte restano visibili, o navigare fra occorrenze non
          // mostrerebbe più dove sono le altre.
          <Text key={i} backgroundColor={s.current ? 'cyan' : 'yellow'} color="black">
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}
