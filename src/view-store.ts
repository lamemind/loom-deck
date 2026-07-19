// T39 — Persistenza della vista (filtri + sort).
// D3 (preflight): sidecar `.claude/loom/deck-view.json`, GITIGNORED. La vista è
// preferenza personale macchina-locale, non config di progetto portabile: sta
// fuori da `.claude/loom-works.json` (committato), come session-tasks.jsonl.
// Formato JSON singolo documento read-modify-write — non JSONL append-only:
// lì l'append serviva la concorrenza fra spawn, qui il writer è uno solo.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_VIEW,
  PRI_ENTRIES,
  PROG_ENTRIES,
  type PriName,
  type ProgName,
  type SortEntry,
  type SortKey,
  type ViewState,
} from './view.js';

export function viewFilePath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom', 'deck-view.json');
}

const SORT_KEYS: SortKey[] = ['pri', 'prog', 'id'];
const PRI_NAMES = PRI_ENTRIES.map((e) => e.name);
const PROG_NAMES = PROG_ENTRIES.map((e) => e.name);

// Il file è editabile a mano e sopravvive ai cambi di schema: si tiene solo ciò
// che è riconoscibile e si scarta il resto, invece di fidarsi del JSON o di
// rifiutare l'intero documento per una chiave sporca.
function sanitizeSort(raw: unknown): SortEntry[] {
  if (!Array.isArray(raw)) return [...DEFAULT_VIEW.sort];
  const out: SortEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { key, dir } = item as { key?: unknown; dir?: unknown };
    if (!SORT_KEYS.includes(key as SortKey)) continue;
    if (dir !== 'asc' && dir !== 'desc') continue;
    if (out.some((e) => e.key === key)) continue; // una chiave compare una volta sola
    out.push({ key: key as SortKey, dir });
  }
  return out;
}

function sanitizeNames<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  return allowed.filter((name) => raw.includes(name));
}

export function parseView(raw: unknown): ViewState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VIEW };
  const o = raw as Record<string, unknown>;
  return {
    sort: sanitizeSort(o.sort),
    hiddenPri: sanitizeNames<PriName>(o.hiddenPri, PRI_NAMES),
    hiddenProg: sanitizeNames<ProgName>(o.hiddenProg, PROG_NAMES),
  };
}

/** File assente, illeggibile o corrotto → default puliti. Mai un throw. */
export function loadView(projectRoot: string): ViewState {
  try {
    return parseView(JSON.parse(readFileSync(viewFilePath(projectRoot), 'utf8')));
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

/** Scrittura esplicita (tasto `w`), mai automatica: sperimentare non persiste. */
export function saveView(projectRoot: string, view: ViewState): void {
  const path = viewFilePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(view, null, 2) + '\n', 'utf8');
}
