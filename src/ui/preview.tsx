// Blocco preview a piena larghezza sotto i due pane: mostra la task o la
// conversazione selezionata a seconda del pane a fuoco.
import { Box, Text } from 'ink';
import { wrapLines } from '../width.js';
import { previewTextWidth } from '../layout.js';
import { LIVE_BUSY, LIVE_IDLE, META_KEYS, SID_CHARS, fmtDateTime, fmtSize } from '../glyphs.js';
import type { TaskDetail } from '../tasks.js';
import type { Session } from '../sessions.js';
import type { LiveSession } from '../live-sessions.js';

/**
 * T70 — blocco preview UNICO, a piena larghezza, sotto le due liste.
 *
 * Sostituisce i due pannelli che stavano in fondo a ciascun pane. Tre cose
 * cambiano insieme, e sono la ragione del blocco unico:
 *
 *  · **una cornice invece di due** — le righe di cornice (marginTop + 2 bordi)
 *    si pagavano due volte per mostrare due dettagli di cui se ne guarda uno;
 *  · **piena larghezza** — dentro un pane al 50% il testo aveva ~40 colonne, e
 *    una descrizione di task ci finiva spezzata in 4 righe di moncone;
 *  · **segue il focus** — a sinistra la task, a destra la conversazione. Il
 *    contenuto è quello dell'oggetto su cui si sta agendo, non di entrambi.
 *
 * Il box è qui e i due corpi sono componenti separati: la cornice (e quindi il
 * costo in righe che `layoutBudget` conta) è una sola, scritta una volta sola.
 */
export type PreviewProps =
  | { kind: 'task'; detail: TaskDetail; maxLines: number; columns: number }
  | {
      kind: 'session';
      s: Session;
      firstLines: number;
      lastLines: number;
      columns: number;
      /** T28 — id d'origine se la sessione è un ramo, altrimenti null. */
      origin: string | null;
      /** T53 — nota umana; '' = nessuna. */
      note: string;
      /** T62 — processo vivo che sta scrivendo questo transcript; null = chiuso. */
      live: LiveSession | null;
    };

export function PreviewPane(p: PreviewProps) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {p.kind === 'task' ? (
        <TaskPreview detail={p.detail} maxLines={p.maxLines} columns={p.columns} />
      ) : (
        <SessionPreview
          s={p.s}
          firstLines={p.firstLines}
          lastLines={p.lastLines}
          columns={p.columns}
          origin={p.origin}
          note={p.note}
          live={p.live}
        />
      )}
    </Box>
  );
}

// T49 — corpo della preview sessione. Tutti i campi vengono dal parse già
// cached dell'adapter (mtime-keyed): non costa I/O al movimento di selezione.
// Mostra "da dove parte, dove è arrivata": il primo prompt utente (`» `) e
// l'ultima risposta del modello (`« `). L'anteprima del primo prompt compare
// SOLO con un titolo custom — senza, il titolo È già il primo prompt e la riga
// lo duplicherebbe (D4 preflight). Le righe rese non superano mai il riservato
// dal budget (`firstLines`/`lastLines`); renderne meno è sicuro (frame più corto).
export function SessionPreview({
  s,
  firstLines,
  lastLines,
  columns,
  origin,
  note,
  live,
}: {
  s: Session;
  firstLines: number;
  lastLines: number;
  columns: number;
  origin: string | null;
  note: string;
  live: LiveSession | null;
}) {
  const width = previewTextWidth(columns);
  const first = s.customTitle && firstLines > 0 ? wrapLines(s.firstPrompt, width, firstLines) : [];
  const last = s.lastReply && lastLines > 0 ? wrapLines(s.lastReply, width, lastLines) : [];
  return (
    <>
      {/* T53 — la nota va sulla riga del titolo, non su una propria: le righe
          FISSE del blocco sono contate dal budget d'altezza (SESSION_DETAIL_FIXED)
          e una riga in più sforerebbe senza passare da `layoutBudget`. Qui il
          titolo resta INTERO anche con la nota — a differenza della lista, nel
          blocco lo spazio c'è e il prefisso non si ripete su N righe. */}
      <Text bold wrap="truncate-end">
        <Text color="cyan">{s.sessionId.slice(0, SID_CHARS)}</Text>{' '}
        {note ? <Text color="yellow">«{note}» </Text> : null}
        <Text dimColor={Boolean(note)}>{s.title}</Text>
      </Text>
      {/* La provenienza va IN CODA alla riga meta esistente, non su una riga
          propria: il budget d'altezza conta le righe fisse del blocco e una
          riga in più le sforerebbe senza passare da layoutBudget. */}
      {/* T60 — il branch è sceso qui dalla riga di lista: era `master` su quasi
          ogni riga, cioè 8 colonne × N che non distinguevano nulla. Nel
          blocco costa 0 righe in più (la meta è già una riga fissa contata da
          SESSION_DETAIL_FIXED) e resta consultabile dove serve davvero. */}
      <Text dimColor wrap="truncate-end">
        {fmtSize(s.sizeBytes)} · {s.turns} turni · {fmtDateTime(s.ts)} · {s.gitBranch || '-'}
        {origin ? ` · ⑂ da ${origin.slice(0, 8)}` : ''}
        {/* T62 — il pid va IN CODA alla riga meta, come la provenienza e per lo
            stesso motivo (le righe fisse del blocco sono contate dal budget
            d'altezza). È l'unica coordinata che il deck non mostra da nessuna
            altra parte, e serve proprio quando la si vuole: attaccarsi al
            processo, o ucciderlo. */}
        {live ? (
          <Text color={live.status === 'busy' ? 'yellow' : 'green'}>
            {` · ${live.status === 'busy' ? LIVE_BUSY : LIVE_IDLE} viva pid ${live.pid} (${live.status})`}
          </Text>
        ) : null}
      </Text>
      {first.map((line, i) => (
        <Text key={`f${i}`} dimColor wrap="truncate-end">
          {i === 0 ? '» ' : '  '}
          {line}
        </Text>
      ))}
      {last.map((line, i) => (
        <Text key={`l${i}`} dimColor wrap="truncate-end">
          {i === 0 ? '« ' : '  '}
          {line}
        </Text>
      ))}
    </>
  );
}

/**
 * Righe non-wrappabili del dettaglio (titolo + meta + commit) e loro conteggio.
 * Estratto dal componente perché il budget deve saperlo PRIMA di renderizzare:
 * sono righe fisse che tolgono spazio alla descrizione.
 */
export function detailMetaOf(detail: TaskDetail) {
  const meta = META_KEYS.map((k) => detail.fields[k])
    .filter(Boolean)
    .join('  ·  ');
  const commit = detail.fields['Last tracked commit'] ?? '';
  return { meta, commit, metaLines: 1 + (meta ? 1 : 0) + (commit ? 1 : 0) };
}

/** Corpo della preview task: titolo, meta, descrizione wrappata, commit. */
export function TaskPreview({
  detail,
  maxLines,
  columns,
}: {
  detail: TaskDetail;
  maxLines: number;
  columns: number;
}) {
  const { meta, commit } = detailMetaOf(detail);
  // Wrap calcolato qui, non delegato a `<Text wrap="wrap">`: il budget ha
  // riservato ESATTAMENTE `maxLines` righe, e un wrap deciso da Ink a runtime
  // ne produrrebbe un numero che il budget non conosce — cioè il frame torna a
  // sforare e il bug si riapre da questa singola casella di testo.
  const lines = wrapLines(detail.description ?? '', previewTextWidth(columns), maxLines);

  return (
    <>
      <Text bold wrap="truncate-end">{detail.title || detail.id}</Text>
      {meta ? <Text dimColor wrap="truncate-end">{meta}</Text> : null}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      {commit ? <Text dimColor wrap="truncate-end">↳ {commit}</Text> : null}
    </>
  );
}
