// T39 — Lettura delle voci `launch` da `.claude/loom-works.json`.
// Allineamento T32: le launch sono voci CUSTOM per-progetto {emoji,label,command},
// di numero e nome arbitrari. Il deck non può quindi avere una lettera fissa per
// app (com'era `C`→codium / `I`→idea, hardcoded): le voci si raggiungono per
// indice 1..9. Il `command` gira con cwd = project root.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LaunchEntry {
  emoji: string;
  label: string;
  command: string;
}

export function configFilePath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom-works.json');
}

export function parseLaunch(raw: unknown): LaunchEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { launch?: unknown }).launch;
  if (!Array.isArray(list)) return [];
  const out: LaunchEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { emoji, label, command } = item as Record<string, unknown>;
    if (typeof command !== 'string' || !command.trim()) continue;
    out.push({
      emoji: typeof emoji === 'string' ? emoji : '▸',
      // `label` è opzionale per contratto → fallback sul comando stesso.
      label: typeof label === 'string' && label ? label : command,
      command,
    });
  }
  return out;
}

/** File assente o malformato → nessuna voce launch. Mai un throw. */
export function loadLaunch(projectRoot: string): LaunchEntry[] {
  try {
    return parseLaunch(JSON.parse(readFileSync(configFilePath(projectRoot), 'utf8')));
  } catch {
    return [];
  }
}
