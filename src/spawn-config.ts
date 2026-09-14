// T161 — gli OVERRIDE di progetto delle azioni di spawn: lettura, validazione,
// risoluzione della terna, scrittura.
//
// ── La sede (P19 preflight) ─────────────────────────────────────────────────
// Blocco `spawn` dentro `.claude/loom-works.json`, il file di progetto che il
// deck già apre in tre loader (`launch`, `archivableDays`, `identity`) e che
// `deck-run` legge con `jq`. Nessun file nuovo: sotto `.claude/` ci sono già tre
// file di loom, e le impostazioni di spawn sono decisioni di progetto che devono
// viaggiare col repo — cioè committate, esattamente come `permissionMode` e
// `order`, e a differenza della vista (`.claude/loom/deck-view.json`, che è
// gitignored perché è una preferenza di questa macchina).
//
// Il costo della scelta, dichiarato: da qui in poi il deck SCRIVE in
// `loom-works.json`, cosa che prima non faceva mai. Il saver è un
// read-modify-write che conserva ogni altra chiave nel suo ordine e tocca il
// solo blocco `spawn`, e RIFIUTA di scrivere se il file non si parsa — quel file
// regge identità, label e registry di compass, e rigenerarlo da zero al posto di
// uno rotto significherebbe perderli.
//
// Lo schema del plugin (`templates/loom-works.schema.json`) dichiara
// `additionalProperties: false` e il blocco `spawn` non vi compare ancora: non è
// un errore a runtime, perché `cfg_validate` in `lib-config.sh` è jq scritto a
// mano sui soli campi noti e un campo sconosciuto passa. Lo schema è reference
// per chi scrive il file a mano, e la voce `"spawn": { "type": "object" }` lo
// raggiunge al prossimo publish del plugin (Prod Validation della task).
//
// ── Il formato ──────────────────────────────────────────────────────────────
//   "spawn": { "<id azione>": { "title"?: string, "model"?: alias, "prompt"?: string } }
//
// SOLO override: una chiave assente significa «il default del deck», e il blocco
// sparisce dal file quando non resta nessun override. Vuoto ≠ assente (P15): un
// `"title": ""` è un override legittimo che dice «nessuna nota».
//
// ── Chi legge cosa ──────────────────────────────────────────────────────────
// Il blocco lo legge il SOLO deck, che risolve la terna e la passa a `deck-run`
// sempre esplicita nell'argv (`--title-note`, `--model`, `--prompt`). `deck-run`
// non lo legge e non deve: `jq` è dipendenza OPZIONALE di quello script, e
// dargli un blocco JSON da consultare la renderebbe obbligatoria su un percorso
// che oggi degrada senza. La cascata env → catalogo → `fable` di `deck-run`
// resta intatta per chi lo invoca a mano.
import { readFileSync, writeFileSync } from 'node:fs';
import { configFilePath } from './config.js';
import { modelFor, type CatalogEntry } from './prompt-catalog.js';
import { interpolate, saneNote, saneTemplate } from './sane-note.js';
import {
  MODEL_DEFAULT,
  SPAWN_ACTIONS,
  SPAWN_FIELDS,
  editableFields,
  isModelKind,
  spawnAction,
  type ModelKind,
  type SpawnAction,
  type SpawnActionId,
  type SpawnField,
} from './spawn-catalog.js';

/** La chiave del blocco nel file di progetto. Costante e non letterale sparso:
 *  la nominano il parser, il saver e il messaggio d'avviso. */
export const SPAWN_BLOCK = 'spawn';

/** Un override di progetto: le sole celle che il progetto ha scritto. */
export interface SpawnOverride {
  title?: string;
  model?: ModelKind;
  prompt?: string;
}

export type SpawnOverrides = ReadonlyMap<SpawnActionId, SpawnOverride>;

export interface ParsedOverrides {
  entries: Map<SpawnActionId, SpawnOverride>;
  /** Le voci scartate, una frase per ognuna. La pagina e la riga di stato le
   *  mostrano: uno scarto silenzioso si presenta come un override che non fa
   *  niente, cioè come un guasto del deck. */
  warnings: string[];
}

/**
 * Validazione per VOCE, non per file (P7).
 *
 * La voce sbagliata cade con una nota che la nomina, il resto vive. Rifiutare
 * l'intero blocco alla prima chiave sporca significherebbe che un refuso su una
 * riga spegne in silenzio gli override di tutte le altre; e conservare per
 * sempre le voci ignote significherebbe riscriverle a ogni salvataggio, cioè
 * tenere in vita nel file una configurazione che nessuno legge più. È lo stesso
 * regime di `sanitizeSort` (`view-store.ts`) e di `parseLaunch`.
 *
 * Cosa cade e cosa no:
 *  - id fuori catalogo → l'intera voce, con nota (un'azione che non esiste più);
 *  - modello fuori dai quattro alias → il solo campo, con nota (arriverebbe al
 *    CLI e produrrebbe una tab con un comando che fallisce all'avvio);
 *  - campo su una cella FISSA → il solo campo, con nota (il valore non avrebbe
 *    nessuna strada per arrivare allo spawn);
 *  - titolo → ridotto, mai scartato: quello che si legge nella pagina è quello
 *    che comparirà nella tab, anche quando il file è stato scritto a mano;
 *  - prompt → qualunque testo, che viaggia come argv singolo.
 */
export function parseSpawnOverrides(raw: unknown): ParsedOverrides {
  const entries = new Map<SpawnActionId, SpawnOverride>();
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { entries, warnings };
  const block = (raw as Record<string, unknown>)[SPAWN_BLOCK];
  if (block === undefined) return { entries, warnings };
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    warnings.push(`blocco ${SPAWN_BLOCK} ignorato: non è un oggetto`);
    return { entries, warnings };
  }

  for (const [id, value] of Object.entries(block as Record<string, unknown>)) {
    const action = spawnAction(id);
    if (!action) {
      warnings.push(`${SPAWN_BLOCK}.${id}: azione fuori catalogo, voce scartata`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${SPAWN_BLOCK}.${id}: non è un oggetto, voce scartata`);
      continue;
    }
    const src = value as Record<string, unknown>;
    const editable = new Set(editableFields(action));
    const out: SpawnOverride = {};
    for (const field of SPAWN_FIELDS) {
      const v = src[field];
      if (v === undefined) continue;
      if (!editable.has(field)) {
        warnings.push(`${SPAWN_BLOCK}.${id}.${field}: ${action.fixed[field]}, campo scartato`);
        continue;
      }
      if (field === 'model') {
        if (!isModelKind(v)) {
          warnings.push(`${SPAWN_BLOCK}.${id}.model: '${String(v)}' non è un modello, campo scartato`);
          continue;
        }
        out.model = v;
        continue;
      }
      if (typeof v !== 'string') {
        warnings.push(`${SPAWN_BLOCK}.${id}.${field}: non è un testo, campo scartato`);
        continue;
      }
      if (field === 'title') out.title = saneTemplate(v);
      else out.prompt = v;
    }
    // Una voce rimasta senza nessun campo valido non entra: nella pagina
    // marcherebbe la riga come «toccata» senza che niente sia stato cambiato.
    if (Object.keys(out).length > 0) entries.set(action.id, out);
  }
  return { entries, warnings };
}

/** File assente → nessun override e NESSUN avviso: è lo stato normale di un
 *  progetto che non ha mai aperto la pagina, come per `loadLaunch` e
 *  `loadArchivableDays`. Illeggibile o non-JSON → default con avviso: lì c'è un
 *  file, e sta dicendo qualcosa che non si riesce a leggere. */
export function loadSpawnOverrides(projectRoot: string): ParsedOverrides {
  let text: string;
  try {
    text = readFileSync(configFilePath(projectRoot), 'utf8');
  } catch {
    return { entries: new Map(), warnings: [] };
  }
  try {
    return parseSpawnOverrides(JSON.parse(text));
  } catch {
    return {
      entries: new Map(),
      warnings: [`${configFilePath(projectRoot)} non si parsa: override di spawn ignorati`],
    };
  }
}

/**
 * La terna risolta di un'azione, pronta per l'argv.
 *
 * `title` e `prompt` sono `string | null` e i due `null` dicono due cose
 * diverse, entrambe distinte dalla stringa vuota:
 *  - `title: null` — l'azione non porta un titolo (la nuda, il project status),
 *    oppure il template nomina un buco che non si è potuto riempire;
 *  - `prompt: null` — il testo lo compone il CHIAMANTE (il drain, dove la skill
 *    è una funzione della natura del file);
 *  - `''` — nessuna nota / nessun prompt, che è una richiesta esplicita e viene
 *    onorata (`--prompt-kind none`).
 */
export interface ResolvedSpawn {
  title: string | null;
  model: ModelKind;
  prompt: string | null;
  /** Le celle che vengono da un override di progetto: la pagina le marca, e la
   *  riga di stato dello spawn non ne ha bisogno (l'argv le mostra già). */
  overridden: ReadonlySet<SpawnField>;
}

/**
 * Default del deck ← override di progetto, più l'interpolazione dei buchi.
 *
 * La precedenza è a due soli livelli, per tutta la task: i valori cablati nel
 * sorgente sono i default, l'unico livello di override è il progetto. Nessuna
 * configurazione d'utente — né sotto `~/.claude/`, né sotto `~/.config/`.
 *
 * Dentro il livello «default» ci sono però due sorgenti, e l'ordine conta: il
 * modello e il prompt cablati nella riga di catalogo vincono su quelli del
 * catalogo dati, che si consulta solo per le azioni che hanno un `kind`. È
 * l'ordine giusto perché un'azione senza `kind` non ha una riga in
 * `prompt-catalog` per costruzione, e una che ce l'ha non porta valori propri.
 */
export function resolveSpawn(
  action: SpawnAction,
  overrides: SpawnOverrides,
  catalog: Map<string, CatalogEntry>,
  holes: Readonly<Record<string, string>> = {},
): ResolvedSpawn {
  const ov = overrides.get(action.id) ?? {};
  const overridden = new Set<SpawnField>(Object.keys(ov) as SpawnField[]);

  const model =
    ov.model ??
    action.model ??
    (action.kind ? modelFor(catalog, action.kind) : undefined) ??
    MODEL_DEFAULT;

  let prompt: string | null;
  if (ov.prompt !== undefined) prompt = ov.prompt;
  else if (action.prompt !== null) prompt = action.prompt;
  // Catalogo dati assente o voce mancante → nessun prompt, non un testo
  // inventato qui: un default scritto nel deck sarebbe la copia del catalogo che
  // il file dati esiste per non avere.
  else if (action.kind) prompt = catalog.get(action.kind)?.template ?? '';
  else prompt = null;
  if (prompt) prompt = interpolate(prompt, holes) ?? '';

  const rawTitle = ov.title ?? action.title;
  // La riduzione si applica DOPO l'interpolazione, perché i buchi portano dentro
  // testo che l'alfabeto non ammette: uno slug con un punto, un path con le
  // barre. Quello che esce di qui è la stessa stringa che `deck-run` comporrà.
  const filled = rawTitle === null ? null : interpolate(rawTitle, holes);
  const title = filled === null ? null : saneNote(filled) || null;

  return { title, model, prompt, overridden };
}

/**
 * Il blocco `spawn` come lo si scrive nel file: le sole voci non vuote, coi soli
 * campi presenti, ordinate come il catalogo.
 *
 * L'ordine è quello di `SPAWN_ACTIONS` e non quello di inserimento nella mappa:
 * il file è committato e lo si legge in diff, dove una riga che si sposta da
 * sola a ogni salvataggio è rumore su cui poi si fa merge.
 *
 * `undefined` quando non resta nessun override: il chiamante toglie la chiave
 * invece di scrivere `"spawn": {}`, che sarebbe una configurazione vuota da
 * spiegare a chi la legge.
 */
export function serializeSpawnBlock(
  entries: SpawnOverrides,
): Record<string, SpawnOverride> | undefined {
  const out: Record<string, SpawnOverride> = {};
  // L'ordine viene da `SPAWN_ACTIONS`, non da una seconda lista di id scritta
  // qui: una copia dell'elenco diverge alla prima riga aggiunta al catalogo, e
  // la voce nuova finirebbe fuori dal file senza che niente lo segnali.
  for (const action of SPAWN_ACTIONS) {
    const ov = entries.get(action.id);
    if (!ov) continue;
    const clean: SpawnOverride = {};
    if (ov.title !== undefined) clean.title = ov.title;
    if (ov.model !== undefined) clean.model = ov.model;
    if (ov.prompt !== undefined) clean.prompt = ov.prompt;
    if (Object.keys(clean).length > 0) out[action.id] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Scrive il blocco `spawn` nel file di progetto, conservando tutto il resto.
 *
 * Read-modify-write su un file che NON è nostro: `loom-works.json` regge
 * identità, label, surface, registry di compass e `permissionMode`, e il deck
 * finora non ci aveva mai scritto. Da qui le due cautele:
 *  - se il file non si parsa la funzione LANCIA invece di rigenerarlo: un
 *    `loom-works.json` rotto va riparato a mano, non sostituito con uno che ha
 *    perso l'identità del progetto;
 *  - ogni altra chiave sopravvive nel suo ordine (`JSON.parse` conserva l'ordine
 *    di inserimento delle chiavi stringa, `JSON.stringify` lo riscrive uguale),
 *    così il diff del commit mostra il solo blocco toccato.
 *
 * File ASSENTE: anche qui si lancia. Un progetto senza `loom-works.json` non è
 * registrato, e creargliene uno col solo blocco `spawn` produrrebbe un file che
 * fallisce ogni validazione a valle.
 */
export function saveSpawnOverrides(projectRoot: string, entries: SpawnOverrides): void {
  const path = configFilePath(projectRoot);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: non è un oggetto JSON`);
  }
  const doc = parsed as Record<string, unknown>;
  const block = serializeSpawnBlock(entries);
  if (block) doc[SPAWN_BLOCK] = block;
  else delete doc[SPAWN_BLOCK];
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}
