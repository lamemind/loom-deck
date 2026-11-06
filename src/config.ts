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
  // T168 — gli ATTRIBUTI di una voce (P2/P3/P13/P17/P22/P26 preflight). Un tipo
  // solo per launcher e script: la differenza non sta nella voce ma in cosa il
  // deck fa dopo lo spawn, e gli attributi accendono quel comportamento. Sono
  // opzionali nel TIPO perché una voce scritta a mano (test, fixture) resta un
  // launcher nudo senza doverli elencare; `parseLaunch` li scrive sempre, coi
  // default, quindi a runtime non manca mai nessuno.
  /** Il deck cattura exit code e output (P26: il nome dell'utente). */
  capture?: boolean;
  /** Corre al mount del deck, senza guardare la scadenza. */
  startup?: boolean;
  /** La durata com'è nel file (`30m`, `6h`, `1d`), o `null`. */
  every?: string | null;
  /** La stessa durata in millisecondi: derivata UNA volta, perché la legge il
   *  tick della scadenza e riparsarla a ogni giro sarebbe lavoro per niente. */
  intervalMs?: number | null;
  /** La cifra pinnata (P10), o `null`: la voce prende la prima libera. */
  key?: string | null;
  /** Compare nella riga launch con la sua cifra (P22). Default `true`. */
  header?: boolean;
  /** Spenta (P17): né riga, né startup, né scadenza. Default `true`. */
  enabled?: boolean;
  /** Lo slug dei file di esito, unico fra le voci del progetto. */
  slug?: string;
  /** La posizione nell'array `launch` del FILE: è la chiave con cui la pagina
   *  riscrive gli attributi. Diverge dall'indice in questa lista perché le voci
   *  malformate sono saltate, quindi va portata e non ricalcolata. */
  index?: number;
}

export function configFilePath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'loom-works.json');
}

/** `^[0-9]+(m|h|d)$` → millisecondi; `null` se la forma non è quella (P25: una
 *  durata con unità, non un frammento di cron). */
export function parseEvery(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^([0-9]+)(m|h|d)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return n * unit;
}

/**
 * Lo slug dei file di esito di una voce: la label ridotta a `[a-z0-9-]`, mai
 * vuota. L'unicità fra le voci la garantisce `parseLaunch`, che aggiunge un
 * suffisso alla seconda omonima: due voci che condividessero il file di esito
 * si sovrascriverebbero a vicenda la guardia di concorrenza.
 */
export function launchSlug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'voce';
}

export interface ParsedLaunch {
  entries: LaunchEntry[];
  /** Gli attributi scartati, una frase per ognuno: la pagina e la riga di stato
   *  li mostrano, come per gli override di spawn (`parseSpawnOverrides`). Uno
   *  scarto silenzioso si presenterebbe come un attributo che non fa niente. */
  warnings: string[];
}

/**
 * Le voci `launch[]` con i loro attributi.
 *
 * Validazione per ATTRIBUTO, non per voce: un `every` malformato cade con una
 * nota e la voce resta un launcher, perché la voce è il comando, e il comando
 * sta bene anche senza la scadenza. I booleani accettano solo `true`/`false`:
 * una stringa `"true"` scritta a mano è un refuso da nominare, non da
 * interpretare.
 */
export function parseLaunchConfig(raw: unknown): ParsedLaunch {
  const entries: LaunchEntry[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { entries, warnings };
  const list = (raw as { launch?: unknown }).launch;
  if (!Array.isArray(list)) return { entries, warnings };
  const slugs = new Set<string>();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const src = item as Record<string, unknown>;
    const { emoji, label, command } = src;
    if (typeof command !== 'string' || !command.trim()) return;
    // `label` è opzionale per contratto → fallback sul comando stesso.
    const shown = sanitize(typeof label === 'string' && label ? label : command);
    const flag = (name: 'capture' | 'startup' | 'header' | 'enabled', dflt: boolean): boolean => {
      const v = src[name];
      if (v === undefined) return dflt;
      if (typeof v === 'boolean') return v;
      warnings.push(`launch[${index}].${name}: '${String(v)}' non è true/false, ignorato`);
      return dflt;
    };
    let every: string | null = null;
    let intervalMs: number | null = null;
    if (src.every !== undefined) {
      intervalMs = parseEvery(src.every);
      if (intervalMs === null) {
        warnings.push(`launch[${index}].every: '${String(src.every)}' non è una durata (30m, 6h, 1d), ignorato`);
      } else {
        every = String(src.every).trim();
      }
    }
    let key: string | null = null;
    if (src.key !== undefined) {
      if (typeof src.key === 'string' && /^[0-9]$/.test(src.key)) key = src.key;
      else warnings.push(`launch[${index}].key: '${String(src.key)}' non è una cifra, ignorato`);
    }
    // Slug unico: la seconda omonima prende un suffisso con la posizione.
    let slug = launchSlug(shown);
    if (slugs.has(slug)) slug = `${slug}-${index}`;
    slugs.add(slug);
    entries.push({
      // L'emoji arriva dal file config: testo arbitrario, quindi va normalizzato
      // come ogni altro dato esterno — `☕` senza VS16 allargherebbe di una cella
      // la riga della legenda, mandandola a capo (vedi width.ts).
      emoji: sanitize(typeof emoji === 'string' ? emoji : '▸'),
      label: shown,
      command,
      capture: flag('capture', false),
      startup: flag('startup', false),
      every,
      intervalMs,
      key,
      header: flag('header', true),
      enabled: flag('enabled', true),
      slug,
      index,
    });
  });
  return { entries, warnings };
}

export function parseLaunch(raw: unknown): LaunchEntry[] {
  return parseLaunchConfig(raw).entries;
}

/** File assente → nessuna voce e nessun avviso (lo stato normale di un progetto
 *  senza config); illeggibile o non-JSON → nessuna voce con avviso, come
 *  `loadSpawnOverrides`. Mai un throw. */
export function loadLaunchConfig(projectRoot: string): ParsedLaunch {
  let text: string;
  try {
    text = readFileSync(configFilePath(projectRoot), 'utf8');
  } catch {
    return { entries: [], warnings: [] };
  }
  try {
    return parseLaunchConfig(JSON.parse(text));
  } catch {
    return { entries: [], warnings: [`${configFilePath(projectRoot)} non si parsa: voci launch ignorate`] };
  }
}

/** File assente o malformato → nessuna voce launch. Mai un throw. */
export function loadLaunch(projectRoot: string): LaunchEntry[] {
  return loadLaunchConfig(projectRoot).entries;
}

/** La voce vale per il deck: accesa. Una spenta non ha cifra, né startup, né
 *  scadenza (P17). */
export function launchEnabled(e: LaunchEntry): boolean {
  return e.enabled !== false;
}

/** La voce sta nella riga launch con la sua cifra: accesa e con `header` (P22).
 *  Una voce fuori riga resta lanciabile dalla pagina e dalla scadenza. */
export function launchShown(e: LaunchEntry): boolean {
  return launchEnabled(e) && e.header !== false;
}

// T43/T168 — le voci launch si raggiungono con le CIFRE, nell'ordine `1`..`9`
// poi `0` (P10): il cap non viene dallo schema config (che ne ammette quante se
// ne vogliono) ma dai tasti disponibili. Le cifre sono il solo spazio di tasti
// del deck riservato alle voci custom: ogni lettera è contesa dalle funzioni
// del deck, e `alt` non è un'alternativa (ESC arriva a Ink come `escape+meta`).
export const LAUNCH_DIGITS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
export const LAUNCH_MAX = LAUNCH_DIGITS.length;

export interface LaunchSlot {
  digit: string;
  entry: LaunchEntry;
}

export interface LaunchDigits {
  /** Le voci con una cifra, nell'ordine delle cifre (`1`..`9`, `0`). */
  slots: LaunchSlot[];
  /** Voci in riga ma senza cifra: più di dieci da mostrare. */
  unreachable: LaunchEntry[];
  /** Le `key` cadute perché già prese: la voce ha preso una cifra libera. */
  warnings: string[];
}

/**
 * T168/P10 — la mappa cifra → voce.
 *
 * Prima le voci con `key`, sulla loro cifra, nell'ordine del file; poi le altre
 * sulle cifre libere, nell'ordine del file. Una voce pinnata tiene la sua cifra
 * qualunque sia la posizione: inserire una voce in mezzo non sposta più il tasto
 * delle successive, che era il difetto dichiarato. Una `key` già presa cade con
 * un avviso e la voce prende una cifra libera, come fanno gli override di spawn
 * con un campo sbagliato: il resto vive.
 *
 * Le voci fuori riga (spente, o con `header` spento) non prendono cifra; una
 * spenta con `key` però la RISERVA, così riaccenderla non sposta le altre (P17).
 */
export function assignDigits(entries: readonly LaunchEntry[]): LaunchDigits {
  const taken = new Map<string, LaunchEntry>();
  const warnings: string[] = [];
  const reserved = new Set<string>();
  for (const e of entries) {
    if (!e.key || !LAUNCH_DIGITS.includes(e.key)) continue;
    if (!launchShown(e)) {
      if (!launchEnabled(e)) reserved.add(e.key);
      continue;
    }
    if (taken.has(e.key)) {
      warnings.push(`launch «${e.label}»: key ${e.key} già presa da «${taken.get(e.key)!.label}», cifra libera`);
      continue;
    }
    taken.set(e.key, e);
  }
  const placed = new Set(taken.values());
  const unreachable: LaunchEntry[] = [];
  for (const e of entries) {
    if (!launchShown(e) || placed.has(e)) continue;
    const free = LAUNCH_DIGITS.find((d) => !taken.has(d) && !reserved.has(d));
    if (free === undefined) {
      unreachable.push(e);
      continue;
    }
    taken.set(free, e);
    placed.add(e);
  }
  const slots = LAUNCH_DIGITS.filter((d) => taken.has(d)).map((d) => ({ digit: d, entry: taken.get(d)! }));
  return { slots, unreachable, warnings };
}

/** Le cifre in uso, nell'ordine di lettura: ciò che la legenda delle combo
 *  annuncia. */
export function launchDigitsOf(entries: readonly LaunchEntry[]): string[] {
  return assignDigits(entries).slots.map((s) => s.digit);
}

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
  /** Voci che entrano in riga, già formattate `<cifra> <emoji> <label>`. */
  shown: string;
  /** Le stesse voci PRIMA di essere unite: `shown` è il loro join. T21 —
   *  l'hit-test del mouse deve sapere dove finisce una voce e comincia la
   *  successiva, e ri-splittare `shown` sul separatore sarebbe un secondo conto
   *  che diverge al primo separatore che compare dentro una label. */
  taken: readonly string[];
  /** T168 — la cifra di ogni voce presa, parallela a `taken`: è il tasto che il
   *  click sintetizza, e con le cifre pinnate non è più `i + 1`. */
  digits: readonly string[];
  /** Voci raggiungibili ma fuori larghezza. */
  overflow: number;
  /** Voci in riga oltre la decima: configurate ma senza un tasto per lanciarle. */
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
  // T168 — le voci in riga con la loro cifra (`assignDigits`): le spente e
  // quelle fuori riga non compaiono, le pinnate stanno sulla loro cifra.
  const digits = assignDigits(entries);
  const unreachable = digits.unreachable.length;
  // bordo + padding del box ≈ 4 celle, più 2 di margine; pavimento a 24 per
  // non degenerare a legenda vuota su terminali strettissimi.
  const budget = Math.max(24, columns - 6 - reserved);
  // I fallback di parseLaunch (`▸` per emoji, command per label) sono già
  // applicati a monte: qui non si re-implementano né si assumono campi popolati.
  const parts = digits.slots.map((s) => `${s.digit} ${s.entry.emoji} ${s.entry.label}`);

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
    digits: digits.slots.slice(0, taken.length).map((s) => s.digit),
    overflow: parts.length - taken.length,
    unreachable,
  };
}

// T61 — soglia d'età del contatore archiviabili, campo `archivableDays`.
//
// È il PRIMO scalare che il lato TypeScript legge dal file config: `launch` e
// `identity` sopra sono strutture. La catena da percorrere si ferma qui: nessun
// passaggio da `lib-config.sh`/`reg_pull`/dconf, perché il solo consumer è il
// deck e il file ce l'ha sotto mano. Il precedente esatto è `permissionMode`,
// che vive nel file, lo legge anche `deck-run` e non è propagato al registry.

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

/** La docs-root di un progetto che non la dichiara: la stessa di `lw_docs_root`
 *  nel plugin. */
export const DEFAULT_DOCS_ROOT = 'docs';

/** Stringa non vuota, presa così com'è: è il valore che il plugin legge con
 *  `jq -r '.docsRoot'`, e due letture che normalizzassero in modo diverso
 *  manderebbero deck e skill in due cartelle. */
export function parseDocsRoot(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as { docsRoot?: unknown }).docsRoot;
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Nome della cartella doc del progetto (`docs`, `runtime`, …): `tasks.md`,
 * `tasks/`, `inbox/` stanno lì sotto.
 *
 * T175 — precedenza `env → file → default`. Fino a T175 il deck leggeva la sola
 * env `LOOM_DECK_DOCS_ROOT`, contando su chi lo avvia: compass la antepone al
 * comando, il profilo Ptyxis la porta cablata. Un deck avviato a mano da una
 * shell — su Linux, e su Windows sempre, perché lì nessuno dei due canali
 * esiste — cercava `docs/` e mostrava una lista vuota invece di un errore. Il
 * campo `docsRoot` del file è la fonte unica della famiglia (lo legge anche il
 * plugin): il deck lo legge da sé.
 *
 * L'env resta IN TESTA, e non solo per i test: è il canale con cui compass
 * passa il valore del registry, e una env impostata è una scelta esplicita di
 * chi avvia, che batte il file come `LOOM_DECK_ARCHIVABLE_DAYS` batte
 * `archivableDays`.
 *
 * Si risolve UNA volta per vita del deck, in `cli.tsx`, e il valore scende a
 * chi lo usa: i path di `tasks.md` e dei task file e i due scan del modo doc
 * devono vedere la stessa cartella.
 */
export function docsRootName(projectRoot: string): string {
  const env = process.env.LOOM_DECK_DOCS_ROOT;
  if (env) return env;
  try {
    const fromFile = parseDocsRoot(JSON.parse(readFileSync(configFilePath(projectRoot), 'utf8')));
    if (fromFile !== null) return fromFile;
  } catch {
    // file assente o malformato → default, come loadLaunch/loadIdentity
  }
  return DEFAULT_DOCS_ROOT;
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
