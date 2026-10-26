// T189 — la lista dei DLV nel detail della task, al posto dell'area di
// compilazione quando il modo DLV è attivo.
import { Box, Text } from 'ink';
import { cut, cutParts, pad } from '../width.js';
import { parseMarkdown } from '../markdown.js';
import { windowRange } from '../viewport.js';
import { CARET, CARET_OFF, DLV_MARK, DLV_MARK_W, WARN } from '../glyphs.js';
import { dlvLaunchable, type Deliverable, type DlvGate } from '../deliverables.js';

/** Il testo di una voce come lo rende il detail sopra: senza `**` e backtick.
 *  Il markdown resta grezzo nel task file, e una lista che mostrasse i marker
 *  direbbe la stessa voce in due forme sulla stessa schermata. */
function plain(text: string): string {
  return parseMarkdown(text).text;
}

/** Un pezzo della riga di stato, con la propria resa. */
interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
}

/**
 * La riga di stato: cosa parte su `⏎`, o perché non parte niente, più quante
 * righe della lista stanno fuori dalla finestra.
 *
 * In `ready` il budget serve per primo il prompt, che è ciò che si legge prima
 * di premere. In `warn` l'avviso sta IN TESTA e il taglio cade dalla coda: su un
 * terminale stretto si perde la fine del prompt, non l'avviso — il prompt lo si
 * conosce già (è quello di `run`), il rifiuto probabile no.
 */
function statusSegments(
  gate: DlvGate,
  prompt: string,
  model: string | null,
  above: number,
  below: number,
): { segments: Segment[]; priority: number } {
  const overflow: Segment = { text: above + below > 0 ? ` · ↑${above} ↓${below}` : '', dim: true };
  const launch: Segment[] = [
    { text: '⏎ ', color: 'yellow' },
    { text: prompt, color: 'cyan' },
    { text: model ? ` · ${model}` : '', dim: true },
  ];
  if (gate.kind === 'ready') return { segments: [...launch, overflow], priority: 1 };
  if (gate.kind === 'warn') {
    return {
      segments: [{ text: `${WARN} ${gate.reason} · `, color: 'yellow' }, ...launch, overflow],
      priority: -1,
    };
  }
  return {
    segments: [{ text: gate.reason, dim: true }, { text: ' · ⏎ inerte', dim: true }, overflow],
    priority: -1,
  };
}

/**
 * La lista dei DLV numerata come la numera `run-task`, coi fatti in grigio e
 * spuntati, più una riga di stato.
 *
 * Il cursore c'è solo quando `⏎` lancia qualcosa (`ready`, `warn`): in `off`
 * nessuna voce è selezionabile, e un caret su una riga inerte prometterebbe un
 * gesto che non esiste. Sopra `rows` la lista si finestra sul cursore; senza cursore parte
 * dall'inizio, e la riga di stato dice quante voci restano fuori.
 */
export function DlvArea({
  dlvs,
  cursor,
  selected,
  gate,
  prompt,
  model,
  rows,
  width,
}: {
  dlvs: readonly Deliverable[];
  /** Numero del DLV sotto il cursore, 0 = nessuno. */
  cursor: number;
  selected: ReadonlySet<number>;
  gate: DlvGate;
  /** Il prompt che `⏎` farebbe partire, già composto. */
  prompt: string;
  model: string | null;
  /** Righe concesse alla lista, riga di stato esclusa (`dlvListRows`). */
  rows: number;
  /** Colonne utili della riga, cornice esclusa. */
  width: number;
}) {
  const ready = dlvLaunchable(gate);
  const at = ready ? dlvs.findIndex((d) => d.n === cursor) : -1;
  const { start, end } = windowRange(dlvs.length, at, rows);
  const numW = String(dlvs.length).length;
  // caret + marca + spazio + numero + spazio: tutto ciò che precede il testo.
  const textW = Math.max(1, width - CARET_OFF.length - DLV_MARK_W - 1 - numW - 1);
  const status = statusSegments(gate, prompt, model, start, dlvs.length - end);
  const texts = cutParts(
    status.segments.map((seg) => seg.text),
    width,
    status.priority,
  );
  return (
    <Box marginTop={1} flexDirection="column">
      {dlvs.slice(start, end).map((d) => {
        const focused = ready && d.n === cursor;
        const picked = selected.has(d.n);
        const mark = d.done ? DLV_MARK.done : picked ? DLV_MARK.picked : DLV_MARK.open;
        return (
          <Text key={d.n} wrap="truncate-end">
            {focused ? CARET : CARET_OFF}
            <Text color={picked ? 'cyan' : undefined} dimColor={d.done}>
              {pad(mark, DLV_MARK_W)}
            </Text>{' '}
            <Text dimColor>{pad(String(d.n), numW, 'right')}</Text>{' '}
            <Text dimColor={d.done} color={picked ? 'cyan' : undefined} bold={focused}>
              {cut(plain(d.text), textW)}
            </Text>
          </Text>
        );
      })}
      <Text wrap="truncate-end">
        {status.segments.map((seg, i) => (
          <Text key={i} color={seg.color} dimColor={seg.dim}>
            {texts[i]}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
