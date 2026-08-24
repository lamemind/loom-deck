// T121 — project status: l'indicatore di testata e il viewer fullscreen.
//
// I due stanno nello stesso file perché sono due rese dello STESSO dato — cosa
// c'è in cache e come sta andando l'ultima generazione — e la testata compare
// anche dentro il viewer.
import { Box, Text } from 'ink';
import { cutParts, type WrappedLine } from '../width.js';
import { sanitize } from '../width.js';
import { LIVE_BUSY } from '../glyphs.js';
import { fmtTime } from '../glyphs.js';
import { DetailLine } from './detail-screen.js';
import type { Span } from '../markdown.js';
import type { StatusView } from '../overlays/status.js';

/** Nessuna occorrenza da evidenziare: il viewer non ha ricerca interna. Costanti
 *  di modulo e non letterali inline — un array nuovo a ogni riga renderizzata
 *  farebbe lavoro per niente su un recap di duecento righe. */
const NO_OCC: never[] = [];

/**
 * L'indicatore: `<progetto> :: PROJECT STATUS [ <stato> ]`.
 *
 * Occupa la posizione SINISTRA della testata, quella che era di `loom-deck`
 * (D1): il posto più visibile della cornice va a un dato che cambia, non a
 * un'etichetta costante che chi guarda il deck sa già.
 *
 * Il taglio lo fa `cutParts` e non `wrap` di Ink (invariante ③ di `width.ts`),
 * con `priority` sul blocco fra parentesi: su un terminale stretto a cadere è
 * il nome del progetto — che chi guarda quel deck conosce — mai lo stato, che è
 * l'unica cosa che la riga esiste per dire.
 */
export function StatusHeadline({
  name,
  label,
  building,
  failed,
  cols,
}: {
  name: string;
  label: string;
  building: boolean;
  failed: boolean;
  cols: number;
}) {
  // `name` arriva dal file config, cioè da testo arbitrario: un glifo discorde
  // allargherebbe la riga di una cella e manderebbe a capo la testata. Si
  // sanifica QUI e non in `loadIdentity`, perché lo stesso valore serve intatto
  // ai titoli delle tab, dove è la chiave di match di compass.
  const shown = sanitize(name);
  // Il glifo di conversazione viva sta DENTRO le parentesi, attaccato allo
  // stato: qualifica quel campo, e il vocabolario è lo stesso della colonna
  // liveness delle sessioni — una generazione in corso è una conversazione che
  // sta lavorando, non un quinto simbolo da imparare.
  const parts = [shown, ' :: PROJECT STATUS ', `[ ${building ? `${LIVE_BUSY} ` : ''}${label} ]`];
  const shownParts = cutParts(parts, Math.max(4, cols), 2);
  const color = building ? 'yellow' : failed ? 'yellow' : label === 'missing' ? 'gray' : 'green';
  return (
    <Text wrap="truncate-end">
      <Text bold color="cyan">{shownParts[0]}</Text>
      <Text dimColor>{shownParts[1]}</Text>
      <Text bold={building} color={color}>{shownParts[2]}</Text>
    </Text>
  );
}

/**
 * Viewer fullscreen del recap: quinta schermata sostitutiva.
 *
 * Stessa forma del detail della task — markdown reso in span tipizzati, righe
 * wrappate col proprio offset — meno l'area di compilazione: qui non c'è niente
 * da lanciare, si legge e basta. Da cui `↑↓` liberi di scorrere il testo, che
 * nel detail sono spesi sul fuoco fra i campi.
 */
export function StatusScreen({
  name,
  label,
  building,
  failed,
  view,
  lines,
  spans,
  top,
  total,
  capacity,
  columns,
}: {
  name: string;
  label: string;
  building: boolean;
  failed: boolean;
  view: StatusView;
  /** Solo la finestra visibile del testo RESO wrappato, con i suoi offset. */
  lines: WrappedLine[];
  /** Costrutti markdown dell'intero documento: il taglio per riga lo fa
   *  `sliceSpans` intersecando. */
  spans: readonly Span[];
  top: number;
  total: number;
  capacity: number;
  columns: number;
}) {
  const last = Math.min(total, top + capacity);
  const width = Math.max(20, (columns || 80) - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <StatusHeadline name={name} label={label} building={building} failed={failed} cols={width} />
      <Text dimColor wrap="truncate-end">
        generato alle <Text color="cyan">{fmtTime(view.mtime)}</Text> · righe{' '}
        {total === 0 ? 0 : top + 1}-{last} di {total}
        {/* D3 — aperto durante una generazione, quello che si legge è il recap
            PRECEDENTE. Non dirlo lascerebbe leggere un testo vecchio come se
            fosse l'esito di ciò che si sta aspettando. */}
        {view.stale ? (
          <Text color="yellow"> · versione precedente, generazione in corso</Text>
        ) : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">PgUp/PgDn</Text> ½ pagina ·{' '}
        <Text color="yellow">g/G</Text> estremi · <Text color="yellow">esc</Text> chiude
      </Text>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginTop={1}
      >
        {lines.map((l, i) => (
          <DetailLine key={top + i} line={l} spans={spans} occ={NO_OCC} current={-1} />
        ))}
      </Box>
    </Box>
  );
}
