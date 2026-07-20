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

// T43 — le voci launch si raggiungono con le CIFRE `1`..`9`: il cap non viene
// dallo schema config (che ne ammette quante se ne vogliono) ma dai tasti
// disponibili. Le voci oltre la nona restano configurate e non raggiungibili.
export const LAUNCH_MAX = 9;

// Larghezza in celle terminale, approssimata: emoji astrali (U+1F000+) e simboli
// BMP portati a presentazione emoji occupano 2 colonne, il VS16 è un modificatore
// a larghezza 0, tutto il resto 1. Serve solo a decidere quante voci stanno in
// riga — non deve essere esatta, deve non SOTTOstimare (sottostimare manderebbe
// la riga a capo, che è il difetto da evitare).
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f) continue;
    w += cp >= 0x1f000 || (cp >= 0x2190 && cp <= 0x2bff) ? 2 : 1;
  }
  return w;
}

export interface LaunchLegend {
  /** Voci che entrano in riga, già formattate `<indice> <emoji> <label>`. */
  shown: string;
  /** Voci raggiungibili ma fuori larghezza. */
  overflow: number;
  /** Voci oltre la nona: configurate ma senza un tasto per lanciarle. */
  unreachable: number;
}

// T43 — legenda `indice → voce`. L'indice da solo è opaco (le launch sono voci
// custom per-progetto, non hanno una lettera fissa per app), quindi la resa deve
// esporre la mappa, non il conteggio. Degradazione mai silenziosa: ciò che non
// entra in larghezza finisce in un contatore esplicito, non troncato a metà.
export function launchLegend(entries: LaunchEntry[], columns: number): LaunchLegend {
  const reachable = entries.slice(0, LAUNCH_MAX);
  const unreachable = entries.length - reachable.length;
  // bordo + padding del box + prefisso "launch " ≈ 12 celle; pavimento a 24 per
  // non degenerare a legenda vuota su terminali strettissimi.
  const budget = Math.max(24, columns - 12);
  // I fallback di parseLaunch (`▸` per emoji, command per label) sono già
  // applicati a monte: qui non si re-implementano né si assumono campi popolati.
  const parts = reachable.map((e, i) => `${i + 1} ${e.emoji} ${e.label}`);

  const fit = (reserve: number) => {
    const taken: string[] = [];
    let used = 0;
    for (const p of parts) {
      const cost = cellWidth(p) + (taken.length > 0 ? 3 : 0); // ' · '
      if (used + cost > budget - reserve) break;
      taken.push(p);
      used += cost;
    }
    return taken;
  };

  // Primo tentativo senza riserva: se entra tutto, nessuno spazio sprecato per un
  // contatore che non servirebbe. Altrimenti si ripete riservando la coda.
  let taken = fit(0);
  if (taken.length < parts.length) taken = fit(10);
  return { shown: taken.join(' · '), overflow: parts.length - taken.length, unreachable };
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
