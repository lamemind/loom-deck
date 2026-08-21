// Detail della task (T66): quarta schermata sostitutiva, col markdown reso in
// span tipizzati (T75) e la ricerca interna (T91).
import { Box, Text } from 'ink';
import { cut, cutParts, type WrappedLine } from '../width.js';
import { sliceLine, type Occurrence } from '../text-search.js';
import { sliceSpans, type Span, type SpanKind } from '../markdown.js';
import { FieldText } from './fields.js';
import { DETAIL_ACTIONS, MODELS, type ModelKind } from '../spawn.js';
import { DROW } from '../overlays/sheet.js';
import type { FieldsCursor } from '../fields.js';
import { CARET, CARET_OFF, WARN } from '../glyphs.js';

/** Resa di ogni costrutto markdown (T75 · D4): un solo livello di enfasi per
 *  costrutto, senza un secondo alfabeto da imparare. Heading uguali a ogni
 *  livello — la gerarchia la porta già il testo. `code` e `fence` condividono
 *  il giallo perché sono lo stesso costrutto a due granularità: dargli due
 *  colori direbbe che sono due cose. */
export const MD_STYLE: Record<SpanKind, { bold?: boolean; color?: string }> = {
  heading: { bold: true, color: 'cyan' },
  bold: { bold: true },
  code: { color: 'yellow' },
  fence: { color: 'yellow' },
};

/**
 * Una riga del detail (T75): markdown reso, con sopra l'evidenziazione della
 * ricerca.
 *
 * Due segmentazioni sulla stessa riga, annidate e non fuse: prima si taglia sui
 * costrutti markdown, poi ogni pezzo si ritaglia sulle occorrenze. L'ordine non
 * è indifferente — così un match a cavallo di un `**grassetto**` resta
 * evidenziato per intero e insieme conserva il grassetto sulla metà che ce
 * l'ha, cosa che una segmentazione unica dovrebbe risolvere decidendo chi vince.
 *
 * Gli offset di `occ` e di `spans` indicizzano ENTRAMBI il testo reso: è ciò
 * che permette di comporli senza rimappature. Vedi `sheetDoc` per il perché la
 * ricerca del detail ha smesso di scandire il sorgente.
 */
export function DetailLine({
  line,
  spans,
  occ,
  current,
}: {
  line: WrappedLine;
  spans: readonly Span[];
  occ: readonly Occurrence[];
  current: number;
}) {
  const styled = sliceSpans(line, spans);
  // Riga vuota → uno spazio: un `<Text>` senza contenuto Ink non lo disegna, e
  // il testo si compatterebbe perdendo la struttura del file.
  if (styled.length === 0) return <Text wrap="truncate-end"> </Text>;
  let off = line.start;
  return (
    <Text wrap="truncate-end">
      {styled.map((seg, i) => {
        const st = seg.kind ? MD_STYLE[seg.kind] : undefined;
        const at = off;
        off += seg.text.length;
        // Senza ricerca aperta il secondo taglio non ha niente da tagliare, e
        // saltarlo evita di allocare tre array per ogni riga a ogni freccia.
        if (occ.length === 0) {
          return (
            <Text key={i} bold={st?.bold} color={st?.color}>
              {seg.text}
            </Text>
          );
        }
        return (
          <Text key={i} bold={st?.bold} color={st?.color}>
            {sliceLine(seg.text, at, occ, current).map((p, j) =>
              p.hit ? (
                <Text key={j} backgroundColor={p.current ? 'cyan' : 'yellow'} color="black">
                  {p.text}
                </Text>
              ) : (
                <Text key={j}>{p.text}</Text>
              ),
            )}
          </Text>
        );
      })}
    </Text>
  );
}

/** Segnaposti delle due righe di testo a campo vuoto. Costanti e non letterali
 *  inline perché la loro larghezza entra nel budget del campo accanto. */
const NOTE_HINT = ' · nome della conversazione';

const PROMPT_HINT = ' · nessun prompt iniziale';

/** Le lettere di selezione diretta dell'azione, per la riga hint. Derivate dallo
 *  stesso catalogo di `ACTION_HOTKEYS`, così una voce aggiunta compare qui senza
 *  che nessuno ci ripassi — un'etichetta che nomina dei tasti a mano è accoppiata
 *  al binding, e resta indietro appena il binding cambia. */
const ACTION_KEYS = DETAIL_ACTIONS.map((a) => a.label[0]).join(' ');

/** Prefisso incolonnato delle quattro righe dell'area di compilazione: le
 *  etichette si leggono una sotto l'altra, quindi la larghezza è quella della
 *  più lunga. Entra nel budget di ogni campo, da cui la costante. */
const LABEL_W = 8;

/** Una riga a SCELTA dell'area di compilazione: bottoni affiancati, voce attiva
 *  in video inverso.
 *
 * Due passate di `cutParts`: la seconda serve SOLO quando qualcosa cade, e
 * riserva le colonne del contatore. Riservarle sempre costerebbe 6 colonne su
 * ogni terminale largo per un avviso che lì non comparirà mai.
 *
 * `priority` sulla voce SELEZIONATA e non sulla prima: qui il troncamento
 * cancellerebbe l'unica informazione che la riga esiste per dare — quale valore
 * sta per essere usato.
 */
function ChoiceRow({
  label,
  values,
  index,
  focused,
  width,
}: {
  label: string;
  values: readonly string[];
  index: number;
  focused: boolean;
  width: number;
}) {
  const segs = values.map((v) => `[ ${v} ]`);
  const parts: string[] = [];
  segs.forEach((s, i) => {
    if (i > 0) parts.push('  ');
    parts.push(s);
  });
  const avail = Math.max(0, width - LABEL_W - CARET_OFF.length);
  let shown = cutParts(parts, avail, index * 2);
  const dropped = (v: string[]) => segs.filter((s, i) => v[i * 2] !== s).length;
  if (dropped(shown) > 0) shown = cutParts(parts, Math.max(0, avail - 6), index * 2);
  const cut = dropped(shown);
  return (
    <Text wrap="truncate-end">
      {focused ? CARET : CARET_OFF}
      <Text dimColor>{label.padEnd(LABEL_W)}</Text>
      {shown.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i}>{part}</Text>
        ) : (
          <Text key={i} inverse={i / 2 === index} color={i / 2 === index ? 'green' : 'gray'}>
            {part}
          </Text>
        ),
      )}
      {/* Troncamento mai silenzioso, come le liste: un bottone che sparisce su
          un terminale stretto non deve sembrare un valore che non esiste. */}
      {cut > 0 ? <Text color="yellow"> · +{cut}</Text> : null}
    </Text>
  );
}

/**
 * Detail della task (T66): il task file scrollabile più l'area di compilazione.
 *
 * Unisce due gesti che erano due schermate — leggere la task e agire su di essa
 * — perché convergono sullo stesso oggetto: si legge la Description proprio per
 * decidere QUALE azione lanciare, e con due overlay separati quella decisione
 * costava uscire dal viewer e ricordarsi la combo.
 *
 * T117 — i quattro parametri dello spawn sono quattro RIGHE con un fuoco solo,
 * la stessa forma del modale edit: prima erano tre alfabeti diversi sulla stessa
 * schermata (`←→` per l'azione, `tab` per il modello, i tasti nudi per la nota),
 * e ogni parametro aggiunto ne chiedeva un quarto.
 *
 * Le righe a scelta restano BOTTONI AFFIANCATI e non menu verticali: un
 * rettangolo ha già coordinate e area cliccabile, quindi il layout sopravvive
 * all'arrivo del mouse (T21 · SGR enable + hit-test) senza migrazione.
 */
export function DetailScreen({
  id,
  title,
  missing,
  lines,
  spans,
  top,
  total,
  capacity,
  action,
  model,
  spawnNote,
  prompt,
  cursor,
  columns,
  find,
  occ,
  occCur,
}: {
  id: string;
  title: string;
  /** Il task file non esiste: si mostra il perché, le azioni restano attive. */
  missing: boolean;
  /** Solo la finestra visibile del testo RESO wrappato, con i suoi offset. */
  lines: WrappedLine[];
  /** Costrutti markdown dell'intero documento, non solo della finestra: il
   *  taglio per riga lo fa `sliceSpans` intersecando. */
  spans: readonly Span[];
  top: number;
  total: number;
  capacity: number;
  /** Indice dell'azione selezionata in DETAIL_ACTIONS. */
  action: number;
  /** T108 — modello con cui partirà la sessione. */
  model: ModelKind;
  /** T111 — titolo con cui nascerà la conversazione (dato `note` nel sidecar). */
  spawnNote: string;
  /** T117 — prompt iniziale, editabile: è il testo che parte davvero. */
  prompt: string;
  /** Riga in fuoco fra le quattro + caret dentro la riga di testo attiva. */
  cursor: FieldsCursor;
  columns: number;
  /** T91 — ricerca nel testo: `null` nessuna, `open:false` evidenziazione congelata. */
  find: { q: string; caret: number; open: boolean } | null;
  occ: readonly Occurrence[];
  occCur: number;
}) {
  const last = Math.min(total, top + capacity);
  // Il taglio lo fa il chiamante (invariante ③ di width.ts): le righe bottoni
  // sono ASCII, quindi `truncate-end` oggi darebbe il risultato giusto per caso
  // — ma la correttezza non deve dipendere dall'alfabeto che capita nella riga.
  const width = Math.max(20, (columns || 80) - 4);
  const mark = (row: number) => (cursor.row === row ? CARET : CARET_OFF);
  // Budget dei due campi di testo: la cornice, il marker di riga e l'etichetta
  // incolonnata. Le colonne del segnaposto si riservano SOLO quando c'è (cioè a
  // campo vuoto): riservarle sempre toglierebbe testo visibile a un titolo lungo
  // per un avviso assente.
  const textW = (extra: number) =>
    Math.max(10, width - LABEL_W - CARET_OFF.length - extra);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor wrap="truncate-end">
        <Text color="cyan">{id}</Text> · {cut(title, Math.max(10, width - 34))}
        {/* Senza file la posizione nel testo non è un dato mancante: non esiste
            proprio. Un `righe 0-0 di 0` la annuncerebbe come tale. */}
        {missing ? '' : ` · righe ${total === 0 ? 0 : top + 1}-${last} di ${total}`}
      </Text>
      {/* La riga hint cambia CONTENUTO, mai altezza: è ciò che permette al
          budget di contare le sole righe del campo di ricerca. */}
      {find?.open ? (
        <Text dimColor wrap="truncate-end">
          <Text color="yellow">↑↓</Text> occorrenza · <Text color="yellow">←→</Text> caret ·{' '}
          <Text color="yellow">^U</Text> svuota · <Text color="yellow">⏎</Text> tieni ·{' '}
          <Text color="yellow">esc</Text> annulla
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {/* T117 — `↑↓`, `←→`, `⏎` ed `esc` non compaiono: dentro un'area a
              righe fanno la cosa che ci si aspetta, e nominarli spende colonne
              per non dire niente. Resta ciò che non si deduce — a partire da
              `PgUp`/`PgDn`, che qui è l'UNICO modo di scorrere il testo proprio
              perché `↑↓` sono passate al fuoco fra le righe. */}
          <Text color="yellow">PgUp/PgDn</Text> testo ·{' '}
          <Text color="yellow">{ACTION_KEYS}</Text> azione ·{' '}
          <Text color="yellow">^U</Text> svuota campo · <Text color="yellow">^F</Text> cerca
        </Text>
      )}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        {missing ? (
          <Text color="yellow" wrap="truncate-end">
            {WARN} task file non trovato · le azioni restano attive (deck-run risolve la task per id)
          </Text>
        ) : (
          lines.map((l, i) => (
            <DetailLine key={top + i} line={l} spans={spans} occ={occ} current={occCur} />
          ))
        )}
      </Box>
      {find?.open ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text dimColor>cerca </Text>
            <FieldText
              value={find.q}
              caret={find.caret}
              focused
              cols={Math.max(10, width - 28)}
            />
            {/* Zero occorrenze si dice, non si lascia dedurre da un campo che
                non evidenzia niente — sotto il minimo di query non c'è ancora
                nulla da dire. */}
            {find.q.length === 0 ? (
              <Text dimColor> · digita per cercare</Text>
            ) : occ.length === 0 ? (
              <Text color="yellow"> · nessuna occorrenza</Text>
            ) : (
              <Text color="cyan">
                {' '}
                · {occCur + 1}/{occ.length}
              </Text>
            )}
          </Text>
        </Box>
      ) : null}
      {/* Le quattro righe dell'area di compilazione, nell'ordine in cui si
          decide: cosa lanciare, con quale prompt, con quale modello, sotto quale
          titolo. */}
      <Box marginTop={1} flexDirection="column">
        <ChoiceRow
          label="azione"
          values={DETAIL_ACTIONS.map((a) => a.label)}
          index={action}
          focused={cursor.row === DROW.action}
          width={width}
        />
        <Text wrap="truncate-end">
          {mark(DROW.prompt)}
          <Text dimColor>{'prompt'.padEnd(LABEL_W)}</Text>
          <FieldText
            value={prompt}
            caret={cursor.caret}
            focused={cursor.row === DROW.prompt}
            cols={textW(prompt ? 0 : PROMPT_HINT.length)}
          />
          {/* Prompt vuoto = nessun prompt allo spawn, che è l'esito voluto di
              `open` ma anche di un campo svuotato a mano: dirlo evita di leggere
              un campo vuoto come «non ancora caricato». */}
          {prompt ? null : <Text dimColor>{PROMPT_HINT}</Text>}
        </Text>
        <ChoiceRow
          label="modello"
          values={MODELS}
          index={Math.max(0, MODELS.indexOf(model))}
          focused={cursor.row === DROW.model}
          width={width}
        />
        <Text wrap="truncate-end">
          {mark(DROW.title)}
          <Text dimColor>{'titolo'.padEnd(LABEL_W)}</Text>
          <FieldText
            value={spawnNote}
            caret={cursor.caret}
            focused={cursor.row === DROW.title}
            cols={textW(spawnNote ? 0 : NOTE_HINT.length)}
          />
          {spawnNote ? null : <Text dimColor>{NOTE_HINT}</Text>}
        </Text>
      </Box>
    </Box>
  );
}
