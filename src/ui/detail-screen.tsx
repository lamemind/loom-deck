// Detail della task (T66): quarta schermata sostitutiva, col markdown reso in
// span tipizzati (T75) e la ricerca interna (T91).
import { Box, Text } from 'ink';
import { caretWindow, cut, cutParts, sanitize, type WrappedLine } from '../width.js';
import { sliceLine, type Occurrence } from '../text-search.js';
import { sliceSpans, type Span, type SpanKind } from '../markdown.js';
import { cpLen } from '../layout.js';
import { DETAIL_ACTIONS, MODELS, type ModelKind } from '../spawn.js';
import { WARN } from '../glyphs.js';

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

/** Campo di testo del detail: finestra ancorata al caret, cursore inverso sulla
 *  cella reale. Gemello di `EditTextField` senza la label, che qui sta fuori
 *  perché il campo vive in FLUSSO su una riga condivisa con altro (il contatore
 *  di occorrenze per la ricerca, il segnaposto per la nota) — non su una riga
 *  propria. Lo usano i due campi del detail: la ricerca `^F`, dove il caret si
 *  muove, e la nota (T111), dove il caret sta sempre in coda. */
export function DetailTextField({ value, caret, cols }: { value: string; caret: number; cols: number }) {
  const win = caretWindow(value, caret, cols);
  return (
    <>
      <Text>{sanitize(win.head)}</Text>
      <Text inverse>{sanitize(win.at)}</Text>
      <Text>{sanitize(win.tail)}</Text>
    </>
  );
}

/** Segnaposto della riga nota quando il campo è vuoto. Costante e non letterale
 *  inline perché la sua larghezza entra nel budget del campo accanto. */
const NOTE_HINT = ' · nome della conversazione';

/**
 * Detail della task (T66): il task file scrollabile più la barra azioni.
 *
 * Unisce due gesti che erano due schermate — leggere la task e agire su di essa
 * — perché convergono sullo stesso oggetto: si legge la Description proprio per
 * decidere QUALE azione lanciare, e con due overlay separati quella decisione
 * costava uscire dal viewer e ricordarsi la combo.
 *
 * Le azioni sono BOTTONI AFFIANCATI e non voci di un menu verticale: un
 * rettangolo ha già coordinate e area cliccabile, quindi il layout sopravvive
 * all'arrivo del mouse (T21 · SGR enable + hit-test) senza migrazione. La
 * navigazione da tastiera ci si sovrappone senza conflitti.
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
  /** T111 — nota con cui nascerà la conversazione; campo sempre attivo. */
  spawnNote: string;
  columns: number;
  /** T91 — ricerca nel testo: `null` nessuna, `open:false` evidenziazione congelata. */
  find: { q: string; caret: number; open: boolean } | null;
  occ: readonly Occurrence[];
  occCur: number;
}) {
  const last = Math.min(total, top + capacity);
  // Il taglio lo fa il chiamante (invariante ③ di width.ts): la riga bottoni è
  // ASCII, quindi `truncate-end` oggi darebbe il risultato giusto per caso — ma
  // la correttezza non deve dipendere dall'alfabeto che capita nella riga.
  const width = Math.max(20, (columns || 80) - 4);
  const segs = DETAIL_ACTIONS.map((a) => `[ ${a.label} ]`);
  const parts: string[] = [];
  segs.forEach((s, i) => {
    if (i > 0) parts.push('  ');
    parts.push(s);
  });
  const dropped = (v: string[], of: string[]) => of.filter((s, i) => v[i * 2] !== s).length;
  // Due passate: la seconda serve SOLO quando qualcosa cade, e riserva le
  // colonne del contatore. Riservarle sempre costerebbe 6 colonne su ogni
  // terminale largo per un avviso che lì non comparirà mai.
  let shown = cutParts(parts, width);
  if (dropped(shown, segs) > 0) shown = cutParts(parts, Math.max(0, width - 6));
  const cutCount = dropped(shown, segs);

  // T108 — riga del selettore modello: bottoni affiancati IDENTICI a quelli
  // della barra azioni, quadre comprese, e voce attiva in video inverso. Due
  // enfasi diverse su due righe adiacenti (là `inverse`, qui un grassetto
  // colorato) obbligano a guardare da vicino per capire quale voce è scelta —
  // la stessa resa si legge di colpo su entrambe.
  // T111 — la cifra è USCITA dalla quadra: `1`-`4` sono passate al campo nota e
  // il modello si scorre col solo `tab`. Un'etichetta che nomina un tasto è
  // accoppiata al binding, e tenerla dopo che il binding è morto non è
  // un'informazione parziale — è una resa che dichiara un tasto che non fa più
  // quella cosa, cioè peggio di nessuna indicazione.
  // `priority` sulla voce SELEZIONATA e non sulla prima: qui il troncamento
  // cancellerebbe l'unica informazione che la riga esiste per dare — quale
  // modello sta per essere usato — mentre nella barra azioni la voce attiva è
  // comunque nota dal tasto appena premuto.
  const mSegs = MODELS.map((m) => `[ ${m} ]`);
  const mParts: string[] = [];
  mSegs.forEach((s, i) => {
    if (i > 0) mParts.push('  ');
    mParts.push(s);
  });
  const mIdx = Math.max(0, MODELS.indexOf(model));
  // `- 8` = le colonne del prefisso "modello ", che sta fuori dai parts perché
  // non è un bottone e non deve mai cadere.
  const mWidth = Math.max(0, width - 8);
  let mShown = cutParts(mParts, mWidth, mIdx * 2);
  if (dropped(mShown, mSegs) > 0) mShown = cutParts(mParts, Math.max(0, mWidth - 6), mIdx * 2);
  const mCut = dropped(mShown, mSegs);

  // T111 — riga della nota. FISSA (D1): il valore armato si vede sempre, e il
  // suo costo sta in `DETAIL_CHROME` invece che in un secondo `extra`
  // condizionale di `detailCapacity`. Prefisso largo 8 come `modello `, così i
  // due parametri dello spawn si leggono incolonnati.
  // Il campo non ha nessun tasto che lo apra: il cursore è l'unica cosa che lo
  // dichiara attivo, e il segnaposto dice cosa ci si scrive. Le colonne del
  // segnaposto si riservano SOLO quando c'è (cioè a nota vuota): riservarle
  // sempre toglierebbe testo visibile a una nota lunga per un avviso assente.
  const nWidth = Math.max(10, width - 8 - (spawnNote ? 0 : NOTE_HINT.length));
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
          {/* Le due voci di scroll fuse in una: la riga porta due tasti in più
              di prima (`scrivi`, `^U`) e a 110 colonne perdeva `esc chiudi` in
              coda — la granularità riga/pagina si indovina, un tasto tagliato
              via no. */}
          <Text color="yellow">↑↓/PgUp/PgDn</Text> testo · <Text color="yellow">←→</Text> azione ·{' '}
          <Text color="yellow">tab</Text> modello ·{' '}
          <Text color="yellow">scrivi</Text> nota · <Text color="yellow">^U</Text> svuota ·{' '}
          <Text color="yellow">^F</Text> cerca · <Text color="yellow">⏎</Text> esegui ·{' '}
          <Text color="yellow">esc</Text> chiudi
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
            <DetailTextField value={find.q} caret={find.caret} cols={Math.max(10, width - 28)} />
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
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate-end">
          <Text dimColor>modello </Text>
          {mShown.map((part, i) =>
            i % 2 === 1 ? (
              <Text key={i}>{part}</Text>
            ) : (
              <Text key={i} inverse={i / 2 === mIdx} color={i / 2 === mIdx ? 'green' : 'gray'}>
                {part}
              </Text>
            ),
          )}
          {mCut > 0 ? <Text color="yellow"> · +{mCut}</Text> : null}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>nota    </Text>
          <DetailTextField value={spawnNote} caret={cpLen(spawnNote)} cols={nWidth} />
          {spawnNote ? null : <Text dimColor>{NOTE_HINT}</Text>}
        </Text>
        <Text wrap="truncate-end">
          {shown.map((part, i) =>
            i % 2 === 1 ? (
              <Text key={i}>{part}</Text>
            ) : (
              <Text key={i} inverse={i / 2 === action} color={i / 2 === action ? 'green' : 'gray'}>
                {part}
              </Text>
            ),
          )}
          {/* Troncamento mai silenzioso, come le liste: un bottone che sparisce
              su un terminale stretto non deve sembrare un'azione che non esiste. */}
          {cutCount > 0 ? <Text color="yellow"> · +{cutCount}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
