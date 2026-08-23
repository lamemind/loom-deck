// T39 — Lettura delle voci `launch` da `.claude/loom-works.json`.
// Allineamento T32: le launch sono voci CUSTOM per-progetto {emoji,label,command},
// di numero e nome arbitrari. Il deck non può quindi avere una lettera fissa per
// app (com'era `C`→codium / `I`→idea, hardcoded): le voci si raggiungono per
// indice 1..9. Il `command` gira con cwd = project root.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitize } from './width.js';
import { DEFAULT_ARCHIVABLE_DAYS } from './archivable.js';

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
      // L'emoji arriva dal file config: testo arbitrario, quindi va normalizzato
      // come ogni altro dato esterno — `☕` senza VS16 allargherebbe di una cella
      // la riga della legenda, mandandola a capo (vedi width.ts).
      emoji: sanitize(typeof emoji === 'string' ? emoji : '▸'),
      // `label` è opzionale per contratto → fallback sul comando stesso.
      label: sanitize(typeof label === 'string' && label ? label : command),
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

/** Separatore fra le voci della riga launch. Costante e non letterale sparso:
 *  lo usano il calcolo di quante voci entrano in riga, la resa, e l'hit-test
 *  del mouse — tre conti che devono misurare lo stesso spazio. */
export const LAUNCH_SEP = ' · ';

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
  /** Le stesse voci PRIMA di essere unite: `shown` è il loro join. T21 —
   *  l'hit-test del mouse deve sapere dove finisce una voce e comincia la
   *  successiva, e ri-splittare `shown` sul separatore sarebbe un secondo conto
   *  che diverge al primo separatore che compare dentro una label. */
  taken: readonly string[];
  /** Voci raggiungibili ma fuori larghezza. */
  overflow: number;
  /** Voci oltre la nona: configurate ma senza un tasto per lanciarle. */
  unreachable: number;
}

// T43 — legenda `indice → voce`. L'indice da solo è opaco (le launch sono voci
// custom per-progetto, non hanno una lettera fissa per app), quindi la resa deve
// esporre la mappa, non il conteggio. Degradazione mai silenziosa: ciò che non
// entra in larghezza finisce in un contatore esplicito, non troncato a metà.
// `reserved` = celle già occupate sulla stessa riga da chi la renderizza (le
// surface built-in `t`/`c`, che precedono le voci). Parametro e non aritmetica
// sul chiamante: `columns` significa "colonne del terminale" e passargliene di
// meno per fargli credere a uno schermo più stretto renderebbe il calcolo
// illeggibile al primo che lo rilegge.
export function launchLegend(
  entries: LaunchEntry[],
  columns: number,
  reserved = 0,
): LaunchLegend {
  const reachable = entries.slice(0, LAUNCH_MAX);
  const unreachable = entries.length - reachable.length;
  // bordo + padding del box ≈ 4 celle, più 2 di margine; pavimento a 24 per
  // non degenerare a legenda vuota su terminali strettissimi.
  const budget = Math.max(24, columns - 6 - reserved);
  // I fallback di parseLaunch (`▸` per emoji, command per label) sono già
  // applicati a monte: qui non si re-implementano né si assumono campi popolati.
  const parts = reachable.map((e, i) => `${i + 1} ${e.emoji} ${e.label}`);

  const fit = (reserve: number) => {
    const taken: string[] = [];
    let used = 0;
    for (const p of parts) {
      const cost = cellWidth(p) + (taken.length > 0 ? cellWidth(LAUNCH_SEP) : 0);
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
  return {
    shown: taken.join(LAUNCH_SEP),
    taken,
    overflow: parts.length - taken.length,
    unreachable,
  };
}

// T61 — soglia d'età del contatore archiviabili, campo `archivableDays`.
//
// È il PRIMO scalare che il lato TypeScript legge dal file config: `launch` e
// `identity` sopra sono strutture, e `docsRoot` arriva ancora dalla sola env
// `LOOM_DECK_DOCS_ROOT` (vedi `tasks.ts`). La catena da percorrere si ferma
// qui: nessun passaggio da `lib-config.sh`/`reg_pull`/dconf, perché il solo
// consumer è il deck e il file ce l'ha sotto mano. Il precedente esatto è
// `permissionMode`, che vive nel file, lo legge `deck-run` via jq e non è
// propagato al registry.

/** Interi positivi soltanto: uno 0 spegnerebbe la soglia (tutte le Done
 *  archiviabili), un negativo o un decimale sono un typo. Valore fuori dominio
 *  → default, mai passaggio cieco di un numero senza senso al conteggio. */
export function parseArchivableDays(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as { archivableDays?: unknown }).archivableDays;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null;
  return v;
}

/**
 * Precedenza `env → file → default`, la stessa che `deck-run` applica a
 * `permissionMode`. L'env esiste per i test e per la verifica manuale (con la
 * soglia reale il segmento resta invisibile per settimane su un progetto
 * giovane): la configurazione vera è il campo nel file, che viaggia col repo.
 */
export function loadArchivableDays(projectRoot: string): number {
  const env = Number(process.env.LOOM_DECK_ARCHIVABLE_DAYS);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const fromFile = parseArchivableDays(
      JSON.parse(readFileSync(configFilePath(projectRoot), 'utf8')),
    );
    if (fromFile !== null) return fromFile;
  } catch {
    // file assente o malformato → default, come loadLaunch/loadIdentity
  }
  return DEFAULT_ARCHIVABLE_DAYS;
}

// T37 — identità del progetto. Serve a titolare le tab spawnate dal deck in modo
// matchabile: compass riconosce la finestra cercando nel titolo della tab ATTIVA
// un prefisso `<emoji-di-surface> <name>`. Senza titolo la finestra esce dal
// radar mentre quella tab è in primo piano.
// T58 — `owner` non fa più parte del titolo: resta nel file come metadato
// organizzativo, ma il deck non ha ragione di leggerlo.
export interface Identity {
  name: string;
}

export function parseIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  return { name };
}

/** File assente o malformato → nessuna identità. Mai un throw. */
export function loadIdentity(projectRoot: string): Identity | null {
  try {
    return parseIdentity(JSON.parse(readFileSync(configFilePath(projectRoot), 'utf8')));
  } catch {
    return null;
  }
}
