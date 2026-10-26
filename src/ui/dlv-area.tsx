// T189 — la lista dei DLV nel detail della task, al posto dell'area di
// compilazione quando il modo DLV è attivo.
import { Box, Text } from 'ink';
import { cut, cutParts, pad } from '../width.js';
import { parseMarkdown } from '../markdown.js';
import { windowRange } from '../viewport.js';
import { CARET, CARET_OFF, DLV_MARK, DLV_MARK_W, WARN } from '../glyphs.js';
import type { Deliverable, DlvGate } from '../deliverables.js';

/** Il testo di una voce come lo rende il detail sopra: senza `**` e backtick.
 *  Il markdown resta grezzo nel task file, e una lista che mostrasse i marker
 *  direbbe la stessa voce in due forme sulla stessa schermata. */
function plain(text: string): string {
  return parseMarkdown(text).text;
}

/** La riga di stato: cosa parte su `⏎`, o perché non parte niente, più quante
 *  righe della lista stanno fuori dalla finestra. Quattro pezzi, uno per
 *  colore; il budget serve per primo il secondo, perché è quello che si legge
 *  prima di premere. */
function statusParts(
  gate: DlvGate,
  prompt: string,
  model: string | null,
  above: number,
  below: number,
): { parts: string[]; tone: 'ready' | 'blocked' | 'off' } {
  const overflow = above + below > 0 ? ` · ↑${above} ↓${below}` : '';
  if (gate.kind === 'ready') {
    return { parts: ['⏎ ', prompt, model ? ` · ${model}` : '', overflow], tone: 'ready' };
  }
  const lead = gate.kind === 'blocked' ? `${WARN} ` : '';
  return { parts: [lead, gate.reason, ' · ⏎ inerte', overflow], tone: gate.kind };
}

/**
 * La lista dei DLV numerata come la numera `run-task`, coi fatti in grigio e
 * spuntati, più una riga di stato.
 *
 * Il cursore c'è solo quando il gate è `ready`: fuori da lì nessuna voce è
 * selezionabile, e un caret su una riga inerte prometterebbe un gesto che non
 * esiste. Sopra `rows` la lista si finestra sul cursore; senza cursore parte
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
  const ready = gate.kind === 'ready';
  const at = ready ? dlvs.findIndex((d) => d.n === cursor) : -1;
  const { start, end } = windowRange(dlvs.length, at, rows);
  const numW = String(dlvs.length).length;
  // caret + marca + spazio + numero + spazio: tutto ciò che precede il testo.
  const textW = Math.max(1, width - CARET_OFF.length - DLV_MARK_W - 1 - numW - 1);
  const status = statusParts(gate, prompt, model, start, dlvs.length - end);
  const [lead, body, tail, overflow] = cutParts(status.parts, width, 1);
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
        <Text color={status.tone === 'off' ? undefined : 'yellow'} dimColor={status.tone === 'off'}>
          {lead}
        </Text>
        <Text
          color={status.tone === 'ready' ? 'cyan' : status.tone === 'blocked' ? 'yellow' : undefined}
          dimColor={status.tone === 'off'}
        >
          {body}
        </Text>
        <Text dimColor>{tail}</Text>
        <Text dimColor>{overflow}</Text>
      </Text>
    </Box>
  );
}
