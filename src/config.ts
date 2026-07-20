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

// T37 — identità del progetto. Serve a titolare le tab spawnate dal deck col core
// `<owner> <name>`, che è la chiave con cui compass matcha la finestra al progetto
// (match window-level sul titolo della tab ATTIVA). Senza titolo la finestra
// esce dal radar mentre quella tab è in primo piano.
export interface Identity {
  owner: string;
  name: string;
}

export function parseIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== 'object') return null;
  const { owner, name } = raw as Record<string, unknown>;
  if (typeof owner !== 'string' || !owner || typeof name !== 'string' || !name) return null;
  return { owner, name };
}

/** File assente o malformato → nessuna identità. Mai un throw. */
export function loadIdentity(projectRoot: string): Identity | null {
  try {
    return parseIdentity(JSON.parse(readFileSync(configFilePath(projectRoot), 'utf8')));
  } catch {
    return null;
  }
}
