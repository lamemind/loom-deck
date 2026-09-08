// T117 — il testo dei prompt iniziali, letto dal file dati che il deck CONDIVIDE
// con `deck-run`.
//
// Fino a T116 il catalogo era un `case` dentro `deck-run` e il deck non ne aveva
// mai visto una stringa: passava un simbolo (`--prompt-kind`) e il testo restava
// dall'altra parte. Un campo che MOSTRA il prompt prima dello spawn rompe quella
// divisione — per mostrarlo bisogna averlo — e le due strade erano ricopiare il
// catalogo qui (seconda scrittura delle stesse regole, divergente alla prima
// voce aggiunta da una parte sola) oppure spostarlo in un dato che entrambi
// leggono. È la seconda.
//
// Il file sta in `scripts/`, sibling di `deck-run`, e non in `src/`: la cartella
// è già dentro `files` di package.json, quindi viene pubblicata as-is su npm,
// mentre `tsc` non copia asset in `dist/` e un file dati sotto `src/` avrebbe
// richiesto un passo di build apposta.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODELS, type ModelKind, type PromptKind } from './spawn.js';

/** Stessa risalita di `DECK_RUN`: src/ (dev) e dist/ (build) sono entrambi
 *  figli della package root, quindi il sibling è un livello sopra. */
export const PROMPT_CATALOG = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'prompt-catalog',
);

/** Una riga del catalogo: template sempre presente, modello opzionale — una
 *  riga a due colonne (pre-T152, o un kind fuori catalogo) resta leggibile. */
export interface CatalogEntry {
  template: string;
  model?: ModelKind;
}

/**
 * Il catalogo come mappa kind → entry, col placeholder `{TASK}` del template
 * ancora dentro.
 *
 * File illeggibile → mappa VUOTA, non un fallback cablato: un default scritto
 * qui sarebbe esattamente la copia del catalogo che questo modulo esiste per non
 * avere, e divergerebbe in silenzio. L'assenza si vede — il campo prompt resta
 * vuoto — e uno spawn senza prompt è un esito benigno.
 *
 * Il taglio è su DUE tab, non uno: il primo separa il kind, l'ultimo separa un
 * modello opzionale in coda — così una riga a due colonne (nessun secondo tab)
 * lascia il template intatto. Un valore in terza colonna che non è un
 * `ModelKind` viene scartato come se la colonna non ci fosse (P2 preflight
 * T152): il chiamante cade sul proprio default, stesso esito bash del `case`
 * di `deck-run` che degrada un modello ignoto.
 */
export function loadPromptCatalog(path: string = PROMPT_CATALOG): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kind = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    const lastTab = rest.lastIndexOf('\t');
    const template = (lastTab >= 0 ? rest.slice(0, lastTab) : rest).trim();
    const rawModel = lastTab >= 0 ? rest.slice(lastTab + 1).trim() : '';
    const model = (MODELS as readonly string[]).includes(rawModel)
      ? (rawModel as ModelKind)
      : undefined;
    out.set(kind, model ? { template, model } : { template });
  }
  return out;
}

/** Il prompt di un kind su una task. Kind fuori catalogo (`none`, o un file
 *  mutilo) → stringa vuota, che è la stessa cosa che `deck-run` fa con `none`. */
export function promptFor(
  catalog: Map<string, CatalogEntry>,
  kind: PromptKind,
  taskId: string,
): string {
  const template = catalog.get(kind)?.template;
  return template ? template.replaceAll('{TASK}', taskId) : '';
}

/** Il modello di un kind, gemello di `promptFor`. Kind fuori catalogo o riga
 *  priva del campo → `undefined`: il chiamante cade sul proprio default
 *  (`MODEL_DEFAULT`), mai su un valore inventato qui. */
export function modelFor(catalog: Map<string, CatalogEntry>, kind: PromptKind): ModelKind | undefined {
  return catalog.get(kind)?.model;
}
