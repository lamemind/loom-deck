// T168/P21 — la SCRITTURA degli attributi di una voce launch nel file di
// progetto, dalla pagina `^L`.
//
// Stessa forma del saver degli override di spawn (`saveSpawnOverrides`):
// read-modify-write su `.claude/loom-works.json`, che NON è del deck — regge
// identità, label, surface e registry di compass — quindi si tocca il solo
// pezzo di propria competenza, qui le chiavi degli attributi dentro ogni voce
// di `launch[]`, e si rifiuta di scrivere se il file non si parsa.
//
// Nel file entrano i soli valori DIVERSI dal default: `header: true` o
// `capture: false` non si scrivono, e una chiave riportata al default sparisce.
// Il file è committato e lo si legge in diff — una riga che non cambia niente è
// rumore su cui poi si fa merge. Nessun commit: il file resta sporco nel
// working tree e lo committa l'utente, come per gli override di spawn.
import { readFileSync, writeFileSync } from 'node:fs';
import { configFilePath, type LaunchEntry } from './config.js';

/** Le chiavi che la pagina governa, nell'ordine in cui si scrivono. */
const ATTRS = ['capture', 'startup', 'every', 'key', 'header', 'enabled'] as const;

/**
 * Riscrive gli attributi delle voci nel file, per POSIZIONE (`entry.index`).
 *
 * La posizione è la sola chiave stabile: la label è opzionale e il comando può
 * ripetersi. Prima di scrivere si verifica che la voce a quella posizione porti
 * ancora lo stesso comando: se il file è stato riscritto a mano mentre la pagina
 * era aperta, meglio rifiutare che mettere gli attributi di una voce su un'altra.
 */
export function saveLaunchAttrs(projectRoot: string, entries: readonly LaunchEntry[]): void {
  const path = configFilePath(projectRoot);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: non è un oggetto JSON`);
  }
  const doc = parsed as Record<string, unknown>;
  const list = doc.launch;
  if (!Array.isArray(list)) throw new Error(`${path}: nessun array launch da aggiornare`);
  for (const e of entries) {
    if (e.index === undefined) continue;
    const item = list[e.index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const voce = item as Record<string, unknown>;
    if (voce.command !== e.command) {
      throw new Error(`${path}: la voce ${e.index} è cambiata sotto la pagina, riaprila`);
    }
    const next: Partial<Record<(typeof ATTRS)[number], unknown>> = {
      capture: e.capture ? true : undefined,
      startup: e.startup ? true : undefined,
      every: e.every ?? undefined,
      key: e.key ?? undefined,
      header: e.header === false ? false : undefined,
      enabled: e.enabled === false ? false : undefined,
    };
    for (const k of ATTRS) {
      if (next[k] === undefined) delete voce[k];
      else voce[k] = next[k];
    }
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}
