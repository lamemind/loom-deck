// T134 — dove sta il plugin loom-works su questa macchina, e quale versione.
//
// Terza volta che il deck incontra l'assenza di `CLAUDE_PLUGIN_ROOT`: è una env
// che esiste solo dentro un processo Claude Code, e il deck è un binario npm
// spawnato da Ptyxis. Le prime due volte (età delle task archiviabili in
// `archivable.ts`, gate `--ignored-files` in `purge.ts`) hanno RIPLICATO un
// criterio di poche righe. Qui si risolve invece di duplicare, perché la
// superficie da replicare sarebbe troppo grande — la grammatica del marker
// inbox da un lato, le tre euristiche tarate dello scanner di wrap dall'altro —
// e una divergenza fra le due copie non si vedrebbe finché non conta i file
// sbagliati.
//
// L'allow `Read(~/.claude/plugins/cache/…/**)` che `init` scrive in
// `.claude/settings.json` non c'entra: è un permesso per gli agent di Claude
// Code. Il deck non passa dal motore dei permessi e non ha niente da farsi
// autorizzare — gli manca soltanto di sapere quale versione eseguire.

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKETPLACE_OWNER = 'lamemind';
const PLUGIN_NAME = 'loom-works';

/** Radice delle cache version-pinned del plugin. */
export function pluginCacheRoot(): string {
  const env = process.env.LOOM_DECK_PLUGIN_CACHE_ROOT;
  if (env) return env;
  return join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_OWNER, PLUGIN_NAME);
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Confronto semver NUMERICO per componente: `-1` se `a` precede `b`, `1` se lo
 * segue, `0` se pari.
 *
 * È il punto di tutto il modulo. In ordine lessicografico `10.1.3` precede
 * `7.9.1` — `'1' < '7'` al primo carattere — quindi un `sort()` ingenuo su
 * questa cartella sceglierebbe `9.0.0` fra le quaranta presenti, cioè una cache
 * di due major fa, e lo farebbe senza dare alcun segno di sbagliare: gli script
 * ci sono, girano, e rispondono col contratto di allora.
 */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** La più alta fra le versioni passate; `null` se nessuna è un semver X.Y.Z. */
export function pickLatestVersion(names: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (!SEMVER_RE.test(name)) continue;
    if (best === null || compareSemver(name, best) > 0) best = name;
  }
  return best;
}

export interface PluginCache {
  /** Radice della versione risolta, es. `~/.claude/plugins/cache/…/11.4.0`. */
  root: string;
  version: string;
}

/**
 * Cache installata più recente, o `null` se il plugin non è installato su questa
 * macchina (radice assente, o presente ma senza una sola cartella semver).
 *
 * `null` non è un errore da riportare: un deck su una macchina senza il plugin
 * deve restare muto sugli indicatori che ne dipendono, non rompersi.
 */
export function resolvePluginCache(): PluginCache | null {
  const root = pluginCacheRoot();
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  const version = pickLatestVersion(names);
  if (version === null) return null;
  return { root: join(root, version), version };
}

/**
 * La versione si risolve UNA VOLTA e resta quella per tutta la vita del
 * processo. La cache cambia solo a un `plugin update`, quindi un deck aperto
 * durante l'update continua a leggere la versione di prima fino al riavvio.
 * È il limite accettato, e sta scritto qui invece di essere scoperto dopo.
 */
let resolved: PluginCache | null | undefined;

export function pluginCache(): PluginCache | null {
  if (resolved === undefined) resolved = resolvePluginCache();
  return resolved;
}

/** Path assoluto di uno script del plugin, `null` se il plugin non c'è. */
export function pluginScript(relative: string): string | null {
  const cache = pluginCache();
  return cache ? join(cache.root, relative) : null;
}

/** Solo per i test: dimentica la versione risolta al primo accesso. */
export function resetPluginCache(): void {
  resolved = undefined;
}
