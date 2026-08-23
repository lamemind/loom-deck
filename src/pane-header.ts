// T21 (mandata 3) — le PARTI degli header dei due pane come DATO, non come JSX.
//
// Stesso principio della riga launch (`launchSegments` in `cli.tsx`): gli
// stessi oggetti compongono la riga disegnata (`ui/panes.tsx`) e le colonne
// dell'hit-test (`cli.tsx`). Chi li deriva dall'altro — ri-splittando la
// stringa renderizzata, o ricontando le voci del catalogo — tiene due conti
// paralleli che divergono alla prima voce che cambia testo o ordine.
//
// Modulo PURO: nessun import da ink/react. Il taglio al budget (`cutParts`) sta
// qui e non nel componente perché è il taglio a decidere quali parti esistono a
// schermo, e una parte caduta non deve rispondere a un click.

import { cutParts } from './width.js';
import { paneTextWidth } from './layout.js';
import {
  SESSION_VIEWS,
  TASK_VIEWS,
  type SessionViewCounts,
  type SessionViewId,
  type TaskViewCounts,
  type TaskViewId,
} from './pane-views.js';

export interface HeaderPart {
  /** Id della vista che la parte seleziona; `null` per le parti non
   *  selezionabili — il nome del pane, i contatori `↑N`/`↓N`. */
  key: string | null;
  /** Testo PRIMA del taglio, separatore in testa compreso: `cutParts` misura la
   *  riga pezzo per pezzo e uno spazio fuori dai pezzi non verrebbe contato. */
  text: string;
  color?: string;
  dim: boolean;
  active: boolean;
}

export interface HeaderParts {
  parts: HeaderPart[];
  /** Testo di ogni parte DOPO il taglio al budget: `''` = parte caduta. */
  shown: string[];
}

function finish(parts: HeaderPart[], columns: number): HeaderParts {
  const shown = cutParts(
    parts.map((p) => p.text),
    paneTextWidth(columns),
    parts.findIndex((p) => p.active),
  );
  return { parts, shown };
}

/**
 * Header del pane task: le tre viste del catalogo, poi `↑N`/`↓N`.
 * Le voci ci sono tutte anche a 0 (T100/D1) e l'attiva ha la precedenza sul
 * budget (D6); i contatori di scroll stanno in coda perché sono i primi a
 * cedere il posto su un terminale stretto.
 */
export function taskHeaderParts(
  counts: TaskViewCounts,
  active: TaskViewId,
  above: number,
  below: number,
  columns: number,
): HeaderParts {
  const views: HeaderPart[] = TASK_VIEWS.map((v, i) => ({
    key: v.id,
    text: `${i > 0 ? ' · ' : ''}${v.label(counts)}`,
    color: v.color,
    dim: Boolean(v.dim) || v.count(counts) === 0,
    active: v.id === active,
  }));
  return finish(
    [
      ...views,
      { key: null, text: above > 0 ? ` · ↑${above}` : '', dim: true, active: false },
      { key: null, text: below > 0 ? ` · ↓${below}` : '', dim: true, active: false },
    ],
    columns,
  );
}

/**
 * Header del pane sessioni: `Sessions` nomina il pane e non è una voce del
 * catalogo (non si seleziona), poi le quattro viste, poi `↑N`/`↓N`.
 */
export function sessionHeaderParts(
  parentLabel: string,
  counts: SessionViewCounts,
  active: SessionViewId,
  above: number,
  below: number,
  columns: number,
): HeaderParts {
  const views: HeaderPart[] = SESSION_VIEWS.map((v) => ({
    key: v.id,
    text: ` · ${v.label(counts, parentLabel)}`,
    color: v.color,
    dim: Boolean(v.dim) || v.count(counts) === 0,
    active: v.id === active,
  }));
  return finish(
    [
      { key: null, text: 'Sessions', dim: false, active: false },
      ...views,
      { key: null, text: above > 0 ? ` · ↑${above}` : '', dim: true, active: false },
      { key: null, text: below > 0 ? ` · ↓${below}` : '', dim: true, active: false },
    ],
    columns,
  );
}

/** Le parti COME SONO A SCHERMO — testo tagliato, chiave intatta — nella forma
 *  che `inlineRegions` (`mouse.ts`) misura per l'hit-test. */
export function headerItems(h: HeaderParts): Array<{ key: string | null; text: string }> {
  return h.parts.map((p, i) => ({ key: p.key, text: h.shown[i] ?? '' }));
}
