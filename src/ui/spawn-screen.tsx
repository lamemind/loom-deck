// T161 — la pagina delle azioni di spawn: la tabella e la sua area di
// compilazione.
import { Box, Text } from 'ink';
import { cut, pad, sanitize, termWidth } from '../width.js';
import { ChoiceRow, FieldText, LABEL_W } from './fields.js';
import { CARET, CARET_OFF } from '../glyphs.js';
import { interpolate, saneNote } from '../sane-note.js';
import {
  MODELS,
  SPAWN_FIELDS,
  spawnCell,
  type SpawnField,
} from '../spawn-catalog.js';
import type { ModelKind } from '../spawn-catalog.js';
import type { SpawnRow } from '../overlays/spawn.js';
import type { FieldsCursor } from '../fields.js';

/**
 * Il glifo della riga configurata.
 *
 * Non è riusato da nessun'altra superficie del deck: `●`/`◍` dicono la liveness
 * di un processo, `📌`/`🔗`/`○` l'appartenenza di una conversazione, `✎` il
 * titolo — un falso amico costa più di un simbolo nuovo. Concorde alle due
 * contabilità di larghezza (`agrees('◆')`), quindi `sanitize` lo lascia passare
 * invece di renderlo `·`.
 */
const TOUCHED = '◆';

/** Cella del glifo: si riempie di spazi anche quando è vuota, o le righe non
 *  configurate sposterebbero a sinistra tutto ciò che segue. */
const MARK_W = 2;

/** Colonna modello: il dominio è chiuso, e a decidere la larghezza non è la voce
 *  più lunga (`sonnet`, 6) ma l'INTESTAZIONE — `modello` ne vuole 7, e una
 *  testata di colonna troncata con l'ellissi si legge come un difetto. */
const MODEL_W = 7;

/** Tetto della colonna funzione: la label più lunga del catalogo (`drain di un
 *  file inbox`) sta esattamente dentro. Un tetto più alto le celle le
 *  toglierebbe al prompt, che è l'unico dei quattro valori senza una forma
 *  breve; più basso troncherebbe due label su undici già a piena larghezza. */
const FUNC_MAX = 22;

/** Le etichette delle righe dell'area, in italiano come ogni altra etichetta a
 *  schermo: la chiave del campo è un nome del codice e finisce nel file di
 *  progetto, non sotto gli occhi di chi compila. */
const FIELD_LABEL: Readonly<Record<SpawnField, string>> = {
  title: 'titolo',
  model: 'modello',
  prompt: 'prompt',
};

export interface SpawnColumns {
  func: number;
  title: number;
  model: number;
  prompt: number;
}

/**
 * Le quattro colonne, per sottrazione come ogni lista del deck: le fisse sono
 * note, e ciò che resta si divide fra titolo e prompt.
 *
 * Il prompt prende la fetta maggiore perché è l'unico dei quattro valori che non
 * ha una forma breve: un titolo tagliato resta riconoscibile dal prefisso, un
 * prompt tagliato a dieci colonne dice solo `/loom-works…`.
 *
 * Pavimento 0 su ogni cella: è un tetto, non una preferenza, e alzarlo sopra lo
 * spazio reale fa uscire la riga dal box mangiandone il bordo (invariante ③ di
 * `width.ts`).
 */
export function spawnColumns(width: number, rows: readonly SpawnRow[]): SpawnColumns {
  // `- 4` = bordo + padding del box tabella, che sta DENTRO quello esterno.
  const avail = Math.max(0, width - 4);
  const func = Math.min(
    FUNC_MAX,
    Math.max(0, ...rows.map((r) => termWidth(r.action.label))),
  );
  // I tre separatori fra le quattro colonne vanno contati insieme alle celle:
  // sommare solo le celle è l'off-by-one che tronca la coda della riga.
  const rest = Math.max(0, avail - CARET_OFF.length - MARK_W - func - MODEL_W - 3);
  // Il titolo ha un TETTO oltre il quale non cresce: i template sono corti
  // (`📊 {slug}`), quindi su un terminale largo ogni colonna in più gli
  // resterebbe vuota mentre al prompt serve.
  const title = Math.min(28, Math.floor(rest * 0.4));
  return { func, title, model: MODEL_W, prompt: Math.max(0, rest - title) };
}

/** Una cella della tabella, col suo colore: il valore in chiaro, il segnaposto
 *  smorzato, l'override in ciano — l'origine si legge senza una legenda. */
function Cell({
  row,
  field,
  value,
  width,
}: {
  row: SpawnRow;
  field: SpawnField;
  value: string | null;
  width: number;
}) {
  const cell = spawnCell(row.action, field, value, row.raw.overridden.has(field));
  const text = cut(cell.text, width);
  return (
    <>
      <Text
        dimColor={cell.placeholder}
        color={cell.origin === 'override' && !cell.placeholder ? 'cyan' : undefined}
      >
        {text}
      </Text>
      {' '.repeat(Math.max(0, width - termWidth(text)))}
    </>
  );
}

export function SpawnScreen({
  rows,
  sel,
  top,
  capacity,
  configured,
  dirty,
  editing,
  editable,
  fieldTitle,
  fieldModel,
  fieldPrompt,
  cursor,
  example,
  columns,
  note,
}: {
  /** L'intera tabella, non la sola finestra: il conteggio in testata e le
   *  larghezze si misurano su tutte le righe, o cambierebbero a ogni scroll. */
  rows: SpawnRow[];
  sel: number;
  top: number;
  capacity: number;
  /** Quante righe portano un override nella bozza. */
  configured: number;
  /** La bozza ha modifiche non ancora scritte su disco. */
  dirty: boolean;
  editing: boolean;
  /** Le celle editabili della riga aperta, nell'ordine in cui il cursore le
   *  indicizza: è la mappa fra `cursor.row` e le tre righe disegnate. */
  editable: readonly SpawnField[];
  fieldTitle: string;
  fieldModel: ModelKind;
  fieldPrompt: string;
  cursor: FieldsCursor;
  /** I valori finti dei buchi, per l'anteprima resa. */
  example: Readonly<Record<string, string>>;
  columns: number;
  /** La riga di stato: una schermata sostitutiva la disegna da sé, o le note
   *  delle sue azioni — `CANC` senza override, l'esito di `w` — finirebbero su
   *  una riga che non è a schermo. */
  note: string;
}) {
  const width = Math.max(20, (columns || 80) - 4);
  const col = spawnColumns(width, rows);
  const window = rows.slice(top, top + capacity);
  const current = rows[sel]!;
  /** La riga disegnata `field` è quella in fuoco? Il cursore indicizza le sole
   *  celle editabili, la resa le disegna tutte e tre. */
  const focused = (field: SpawnField) => editing && editable[cursor.row] === field;
  const textW = Math.max(10, width - LABEL_W - CARET_OFF.length);
  // L'anteprima si fa sul titolo GIÀ ridotto, come lo farà `deck-run`: mostrare
  // il template interpolato ma non ridotto prometterebbe un titolo che la tab
  // non porta.
  const rendered = saneNote(interpolate(fieldTitle, example) ?? '');
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        <Text color="cyan">azioni di spawn</Text>{' '}
        <Text dimColor>
          · {rows.length} azioni · {configured} configurate
        </Text>
        {dirty ? <Text color="yellow"> · modifiche non salvate</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="yellow">↑↓</Text> riga · <Text color="yellow">⏎</Text>{' '}
        {editing ? 'conferma' : 'modifica'} · <Text color="yellow">CANC</Text> torna al default ·{' '}
        <Text color="yellow">w</Text> salva · <Text color="yellow">esc</Text>{' '}
        {editing ? 'annulla' : 'chiude'}
      </Text>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {CARET_OFF}
          {' '.repeat(MARK_W)}
          {pad('funzione', col.func)} {pad('titolo', col.title)} {pad('modello', col.model)}{' '}
          {pad('prompt', col.prompt)}
        </Text>
        {window.map((r, i) => {
          const at = top + i;
          return (
            <Text key={r.action.id} wrap="truncate-end">
              {at === sel ? CARET : CARET_OFF}
              <Text color="cyan">{pad(r.touched ? TOUCHED : '', MARK_W)}</Text>
              <Text bold={at === sel}>{pad(cut(r.action.label, col.func), col.func)}</Text>{' '}
              <Cell row={r} field="title" value={r.raw.title} width={col.title} />{' '}
              <Cell row={r} field="model" value={r.raw.model} width={col.model} />{' '}
              <Cell row={r} field="prompt" value={r.raw.prompt} width={col.prompt} />
            </Text>
          );
        })}
      </Box>
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          {/* Le tre righe si disegnano SEMPRE, anche quelle che questa azione non
              fa modificare: una riga assente lascerebbe la domanda «e il titolo
              della nuda dove si mette», mentre la ragione scritta la chiude. */}
          {SPAWN_FIELDS.map((field) => {
            const fixed = current.action.fixed[field];
            if (fixed !== undefined) {
              return (
                <Text key={field} dimColor wrap="truncate-end">
                  {CARET_OFF}
                  {FIELD_LABEL[field].padEnd(LABEL_W)}({fixed})
                </Text>
              );
            }
            if (field === 'model') {
              return (
                <ChoiceRow
                  key={field}
                  label="modello"
                  values={MODELS}
                  index={Math.max(0, MODELS.indexOf(fieldModel))}
                  focused={focused('model')}
                  width={width}
                />
              );
            }
            const value = field === 'title' ? fieldTitle : fieldPrompt;
            return (
              <Text key={field} wrap="truncate-end">
                {focused(field) ? CARET : CARET_OFF}
                <Text dimColor>{FIELD_LABEL[field].padEnd(LABEL_W)}</Text>
                <FieldText
                  value={value}
                  caret={cursor.caret}
                  focused={focused(field)}
                  cols={textW}
                />
              </Text>
            );
          })}
          {/* L'anteprima: i buchi riempiti con valori FINTI e dichiarati tali.
              La pagina non ha una selezione di task — si apre da qualunque punto
              del deck — quindi legarla a ciò che capita di avere sotto il caret
              la renderebbe diversa a ogni apertura, per la stessa
              configurazione. */}
          <Text dimColor wrap="truncate-end">
            {CARET_OFF}
            {'esempio'.padEnd(LABEL_W)}
            {current.action.title === null ? (
              'nessun titolo per questa azione'
            ) : (
              <Text color={rendered ? 'green' : undefined}>
                {rendered ? cut(rendered, textW) : 'titolo a vuoto: nessuna nota'}
              </Text>
            )}
          </Text>
        </Box>
      ) : null}
      {note ? <Text color="green" wrap="truncate-end">{sanitize(note)}</Text> : null}
    </Box>
  );
}
