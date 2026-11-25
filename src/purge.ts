// T112 — il BERSAGLIO di una potatura, e se il gate del plugin lo lascerebbe
// passare.
//
// Il deck non pota: ordina la potatura a `loom-works:clean-tasks`, che possiede
// l'intera sequenza distruttiva (task file + folder dot-prefixed + riga in
// tasks.md, un commit atomico per task, righe orfane riconciliate). Qui non
// c'è nessun `git rm` e nessuna riscrittura di tasks.md — solo il calcolo di
// CHI si può potare.
//
// D3/D4 (preflight) — il gate `--ignored-files` di `clean-tasks.sh` esce 2
// PRIMA di toccare qualsiasi cosa: in un'invocazione su N target, una sola
// folder con file che `git rm` non rimuove annulla il lavoro sugli altri N-1.
// Un chiamante che scoprisse la condizione dall'exit code potrebbe solo
// riportare il fallimento intero, quindi il deck replica il predicato del gate
// e scarta i non conformi a monte. È la TERZA duplicazione di un criterio del
// plugin dentro il deck (dopo la regola d'età, D1 di T61): se lo script cambia
// il modo di contare i superstiti, le due letture divergono in silenzio. Costo
// accettato perché il canale alternativo — un dry-run via processo Claude
// headless — non è rifacibile on-demand, cioè al momento in cui il tasto viene
// premuto.
//
// Il predicato porta con sé le due eccezioni degli script: una folder che RESTA
// sul disco mentre la sua task parte — dichiarata da una task fuori
// dall'invocazione (`lw_folder_declarers`), o col campo `Folder` fuori dalla
// forma `.YY-MM-DD-slug` (`lw_folder_shape_ok`) — è fuori dal gate e da
// `--ignored-files`. Senza, il deck chiederebbe keep o purge per una folder che
// lo script non tocca, e in blocco scarterebbe come sporca una task che parte.
//
// Il materiale 💎 di `## Materiale`, che fa rifiutare una task intera, qui NON
// si legge: il deck lo scopre dall'esito (`purgeOutcomeNote` in `task-ops.ts`).
// Il rifiuto è per task e non ferma le altre, quindi non annulla un giro come il
// gate, e un quarto criterio duplicato non comprerebbe niente.

import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { promisify } from 'node:util';
import { findTaskFile } from './tasks.js';

const execFileAsync = promisify(execFile);

/**
 * T186 (D4) — budget in caratteri dei pathspec di UNA chiamata git. Su Windows
 * una riga di comando sta sotto i 32.767 caratteri: oltre, lo spawn fallisce, e
 * un fallimento qui vale "nessun superstite". 8.000 lascia margine anche per il
 * prefisso del comando e per i path lunghi; le folder di oggi stanno in un
 * blocco solo.
 */
export const PATHSPEC_BUDGET = 8_000;

/** Lo stdout di `git ls-files -o` su una folder che contiene un albero ignorato
 *  intero (un `node_modules`) supera di molto il megabyte di default, e uno
 *  stdout tagliato fa fallire la chiamata, cioè "nessun superstite": il lato
 *  dell'errore che proporrebbe come eliminabile una folder sporca. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Direttiva `--ignored-files` di `clean-tasks.sh`, globale al run. */
export type IgnoredMode = 'keep' | 'purge';

export interface PurgeTarget {
  id: string;
  /** Path assoluto della task folder; `null` se la task non ne dichiara una o
   *  se il path dichiarato non è (più) una directory su disco. */
  folder: string | null;
  /** Perché la folder resta sul disco mentre la task parte — `condivisa con T15,
   *  T140` o `non ha la forma .YY-MM-DD-slug`, le parole del dry-run degli
   *  script —; `null` = parte con la task, o non c'è. */
  stays: string | null;
  /** Quanti file `git rm` NON rimuoverebbe. `> 0` = il gate del plugin
   *  scatterebbe su questa task. Una folder che resta non si misura: 0. */
  survivors: number;
}

/**
 * Il campo `- **Folder**: <path>` del task file, primo token soltanto.
 *
 * Gemello di `read_field` in `clean-tasks.sh`, che chiude il valore con un
 * `awk '{print $1; exit}'`: il campo ammette un'annotazione inline dopo il path
 * (`.26-06-16-cat (condivisa con T19)`) e prenderla dentro produrrebbe una
 * directory inesistente.
 *
 * `[ \t]*` e non `\s*`: con un campo vuoto (`- **Folder**:` seguito dall'a
 * capo) uno `\s*` mangerebbe la newline e `(\S+)` catturerebbe il primo token
 * della riga SUCCESSIVA — cioè un path preso da un altro campo.
 */
export function folderField(content: string): string {
  const m = content.match(/^-[ \t]*\*\*Folder\*\*:[ \t]*(\S+)/m);
  return m ? m[1]! : '';
}

/** Il campo `Folder` nella forma su cui gli script confrontano due folder: via
 *  un `./` davanti e un `/` in coda, come in `clean-tasks.sh` e in
 *  `lw_folder_declarers` — `./.26-x/` e `.26-x` sono la stessa folder. */
export function normalizeFolder(field: string): string {
  return field.replace(/^\.\//, '').replace(/\/$/, '');
}

/** La forma di una task folder, `.YY-MM-DD-slug` in un componente solo. Gemella
 *  di `lw_folder_shape_ok` in `lib.sh`: gli script toccano una folder solo con
 *  questa forma (`Folder: .` sarebbe la project root intera).
 *
 *  Lettere di ogni alfabeto, non solo ASCII: il `[A-Za-z0-9]` della regex bash
 *  dipende dal locale, e sotto un locale UTF-8 come `it_IT.UTF-8` prende anche
 *  `é` (sotto `LC_ALL=C` no). La forma più larga sbaglia dal lato prudente: una
 *  folder che il deck dà in partenza si misura, e al peggio il deck chiede keep
 *  o purge per una folder che lo script lascerebbe. */
const FOLDER_SHAPE = /^\.[0-9]{2}-[0-9]{2}-[0-9]{2}-[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

export function folderShapeOk(rel: string): boolean {
  return FOLDER_SHAPE.test(rel);
}

interface FolderRef {
  abs: string;
  /** Il campo normalizzato, relativo alla project root. */
  rel: string;
}

function folderOf(projectRoot: string, taskFilePath: string): FolderRef | null {
  let content: string;
  try {
    content = readFileSync(taskFilePath, 'utf8');
  } catch {
    return null;
  }
  const field = folderField(content);
  if (!field) return null;
  const rel = normalizeFolder(field);
  const abs = join(projectRoot, rel);
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return { abs, rel };
}

/** Task folder della task, risolta e verificata su disco. */
export function taskFolder(projectRoot: string, taskFilePath: string): string | null {
  return folderOf(projectRoot, taskFilePath)?.abs ?? null;
}

/**
 * Chi tiene in vita quale folder: folder normalizzata → id delle task che la
 * dichiarano, fra i task file passati meno quelli in partenza (`leaving`, per
 * nome di file). Gemella di `lw_folder_declarers`: id dal nome del file fino al
 * primo `-`, ordine per nome con i numeri confrontati come numeri (`T15` prima
 * di `T140`, il `sort -V` dello script).
 */
export function folderDeclarers(
  files: ReadonlyArray<readonly [name: string, content: string]>,
  leaving: ReadonlySet<string>,
): Map<string, string[]> {
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const declarers = new Map<string, string[]>();
  for (const [name, content] of sorted) {
    if (leaving.has(name)) continue;
    const rel = normalizeFolder(folderField(content));
    if (!rel) continue;
    declarers.set(rel, [...(declarers.get(rel) ?? []), name.split('-')[0]!]);
  }
  return declarers;
}

function taskFileNames(tasksDir: string): string[] {
  try {
    return readdirSync(tasksDir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
}

function readTaskFiles(tasksDir: string): [string, string][] {
  return taskFileNames(tasksDir).flatMap((name): [string, string][] => {
    try {
      return [[name, readFileSync(join(tasksDir, name), 'utf8')]];
    } catch {
      return [];
    }
  });
}

async function readTaskFilesAsync(tasksDir: string): Promise<[string, string][]> {
  const files: [string, string][] = [];
  for (const name of taskFileNames(tasksDir)) {
    try {
      files.push([name, await readFile(join(tasksDir, name), 'utf8')]);
    } catch {
      // Un task file sparito fra readdir e lettura non dichiara niente.
    }
  }
  return files;
}

// ── i superstiti di N folder, da una chiamata git sola ─────────────────────
//
// T186 — su Windows uno spawn di git costa due ordini di grandezza più che su
// Linux, e il lavoro di git su queste folder è trascurabile accanto allo spawn:
// un `git ls-files -o` per folder moltiplicava il costo per il numero delle
// folder, mentre la stessa misura con tutte le folder in una chiamata costa
// quanto uno spawn solo. Il nucleo lancia un git per blocco di pathspec (uno
// solo, coi numeri di oggi) e divide l'output per folder.
//
// Stesso comando di `lw_folder_survivors` in `lib.sh` (`git ls-files -o`, senza
// `--exclude-standard`, quindi ignorati inclusi): replicare il predicato del
// gate ha senso solo se è LO STESSO predicato. Il `-z` non cambia quali file
// escono, cambia come si scrivono: senza, git mette fra virgolette e codifica in
// ottale i path non ASCII (`core.quotePath`), e il confronto col path della
// folder non li riconoscerebbe più.
//
// Git muto (non installato, repo assente, blocco rifiutato) → nessun superstite
// per le folder di quel blocco, cioè "conforme". La direzione dell'errore è
// deliberata: il gate a valle resta comunque la rete, e il chiamante ne riporta
// il fallimento invece di dichiarare successo.

/**
 * Un path di `relative()` nella forma che git stampa: su win32 il separatore è
 * `\`, git scrive sempre `/`. Su POSIX `\` è un carattere lecito di un nome, e
 * resta com'è.
 */
export function toGitPath(rel: string, separator: string = sep): string {
  return separator === '/' ? rel : rel.split(separator).join('/');
}

/** I pathspec in blocchi, ognuno sotto `budget` caratteri (spazio compreso). Un
 *  pathspec più lungo del budget fa blocco da solo. */
export function chunkPathspecs(rels: readonly string[], budget: number = PATHSPEC_BUDGET): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const rel of rels) {
    const cost = rel.length + 1;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(rel);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Divide l'output di `git ls-files -o -z` fra le folder: `buckets[i]` tiene i
 * path che stanno sotto `rels[i]`.
 *
 * Un path appartiene a una folder se è uguale al suo `rel` o sta sotto
 * `rel + '/'`: senza la `/` finale `.26-01-01-a` raccoglierebbe i file di
 * `.26-01-01-ab`. Il confronto passa per gli antenati del path, non per ogni
 * coppia path × folder: una folder con un albero ignorato intero dentro dà
 * centinaia di migliaia di path.
 *
 * Folder annidate: un file della folder interna conta per entrambe, come
 * quando ogni folder si misurava con una chiamata sua. Un path ripetuto (due
 * blocchi che lo vedono entrambi) conta una volta. Il confronto è esatto,
 * maiuscole comprese, anche su Windows: git stesso non abbina un pathspec che
 * differisce solo per le maiuscole da un file non tracciato.
 */
export function bucketSurvivors(rels: readonly string[], output: string): string[][] {
  const buckets = rels.map((): string[] => []);
  const byRel = new Map<string, number[]>();
  rels.forEach((rel, i) => byRel.set(rel, [...(byRel.get(rel) ?? []), i]));
  for (const path of new Set(output.split('\0'))) {
    if (!path) continue;
    // `a/b/c` → `a/b/c`, `a/b`, `a`. Un repo annidato esce come `a/sub/`: il
    // primo giro prova `a/sub/`, il secondo `a/sub`.
    for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
      for (const i of byRel.get(path.slice(0, end)) ?? []) buckets[i]!.push(path);
    }
  }
  return buckets;
}

/** Cosa misurare: il `rel` in forma git di ogni folder (`null` = fuori dal
 *  progetto, nessun superstite) e i blocchi di pathspec da passare a git. */
interface SurveyPlan {
  rels: (string | null)[];
  chunks: string[][];
}

function surveyPlan(projectRoot: string, folders: readonly string[]): SurveyPlan {
  const rels = folders.map((folder) => {
    const rel = relative(projectRoot, folder);
    // Un `rel` assoluto è una folder su un altro disco (win32).
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return toGitPath(rel);
  });
  const unique = [...new Set(rels.filter((rel): rel is string => rel !== null))];
  return { rels, chunks: chunkPathspecs(unique) };
}

function collect(plan: SurveyPlan, outputs: string[]): string[][] {
  const measured = plan.chunks.flat();
  const buckets = bucketSurvivors(measured, outputs.join('\0'));
  const byRel = new Map(measured.map((rel, i) => [rel, buckets[i]!]));
  return plan.rels.map((rel) => (rel === null ? [] : [...(byRel.get(rel) ?? [])]));
}

const lsOthersArgs = (chunk: string[]) => ['ls-files', '-o', '-z', '--', ...chunk];

/**
 * I file di N folder che `git rm` non rimuove — ignorati da un `.gitignore` o
 * mai tracciati — misurati con uno spawn di git per blocco di pathspec.
 * `result[i]` è la lista di `folders[i]`.
 */
export function foldersSurvivors(projectRoot: string, folders: readonly string[]): string[][] {
  const plan = surveyPlan(projectRoot, folders);
  const outputs = plan.chunks.map((chunk) => {
    try {
      return execFileSync('git', lsOthersArgs(chunk), {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        // Lo stderr di un git muto (`fatal: not a git repository`) andrebbe
        // sullo stderr del deck, cioè sopra lo schermo di Ink.
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return '';
    }
  });
  return collect(plan, outputs);
}

/** `foldersSurvivors` senza fermare l'event loop: lo usa lo scan periodico. */
export async function foldersSurvivorsAsync(
  projectRoot: string,
  folders: readonly string[],
): Promise<string[][]> {
  const plan = surveyPlan(projectRoot, folders);
  const outputs: string[] = [];
  for (const chunk of plan.chunks) {
    try {
      const { stdout } = await execFileAsync('git', lsOthersArgs(chunk), {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      outputs.push(stdout);
    } catch {
      outputs.push('');
    }
  }
  return collect(plan, outputs);
}

/** I superstiti di una folder sola: il caso N=1 del nucleo. */
export function folderSurvivors(projectRoot: string, folder: string): string[] {
  return foldersSurvivors(projectRoot, [folder])[0]!;
}

interface Located {
  id: string;
  /** Nome del task file; `null` = riga orfana, nessun file. */
  file: string | null;
  folder: FolderRef | null;
}

function locate(id: string, tasksDir: string, projectRoot: string): Located {
  const taskFile = findTaskFile(tasksDir, id);
  if (!taskFile) return { id, file: null, folder: null };
  return { id, file: basename(taskFile), folder: folderOf(projectRoot, taskFile) };
}

/** Le task folder si confrontano con quelle delle altre task solo se una delle
 *  folder in partenza ha la forma giusta: senza, leggere tutti i task file non
 *  serve. */
function needsDeclarers(located: readonly Located[]): boolean {
  return located.some((l) => l.folder !== null && folderShapeOk(l.folder.rel));
}

function leavingFiles(located: readonly Located[]): Set<string> {
  return new Set(located.flatMap((l) => (l.file ? [l.file] : [])));
}

function staysOf(located: readonly Located[], declarers: Map<string, string[]>): (string | null)[] {
  return located.map(({ folder }) => {
    if (!folder) return null;
    if (!folderShapeOk(folder.rel)) return 'non ha la forma .YY-MM-DD-slug';
    const keepers = declarers.get(folder.rel);
    return keepers ? `condivisa con ${keepers.join(', ')}` : null;
  });
}

/** Le folder che partono con la loro task: le sole su cui il gate guarda. */
function leavingFolders(located: readonly Located[], stays: readonly (string | null)[]): string[] {
  return located.flatMap((l, i) => (l.folder && stays[i] === null ? [l.folder.abs] : []));
}

function toTargets(
  located: readonly Located[],
  stays: readonly (string | null)[],
  survivors: string[][],
): PurgeTarget[] {
  let next = 0;
  return located.map((l, i) => {
    const measured = l.folder !== null && stays[i] === null;
    return {
      id: l.id,
      folder: l.folder?.abs ?? null,
      stays: stays[i] ?? null,
      survivors: measured ? survivors[next++]!.length : 0,
    };
  });
}

/**
 * Il bersaglio, misurato ADESSO.
 *
 * Una folder che resta (`stays`) non si misura: il gate dello script non la
 * guarda, e i suoi superstiti non decidono niente.
 *
 * Sincrono apposta: la dirtiness è un dato campionato (la vista `archiviabili`
 * lo mostra da uno scan periodico) e nell'istante in cui si preme il tasto può
 * essere stale — una folder sporcata dopo l'ultimo scan si presenterebbe come
 * eliminabile. Ricalcolarlo al momento dell'azione costa la lettura dei task
 * file più uno spawn di git per TUTTE le folder insieme: su Windows lo spawn
 * vale da solo quasi tutto il costo, e uno spawn per folder moltiplicava la
 * pausa per il numero delle folder.
 */
export function purgeTargets(ids: string[], tasksDir: string, projectRoot: string): PurgeTarget[] {
  const located = ids.map((id) => locate(id, tasksDir, projectRoot));
  const declarers = needsDeclarers(located)
    ? folderDeclarers(readTaskFiles(tasksDir), leavingFiles(located))
    : new Map<string, string[]>();
  const stays = staysOf(located, declarers);
  const leaving = leavingFolders(located, stays);
  return toTargets(located, stays, foldersSurvivors(projectRoot, leaving));
}

/**
 * `purgeTargets` per lo scan periodico della lista (`useDirtyFolders`): stesso
 * esito, senza fermare l'event loop. Git gira in asincrono, e fra un task file e
 * il successivo il ciclo cede il turno: la lettura dei task file scala col
 * numero delle archiviabili, e su Windows, fatta in un colpo, basta già a far
 * saltare un frame.
 */
export async function purgeTargetsAsync(
  ids: string[],
  tasksDir: string,
  projectRoot: string,
): Promise<PurgeTarget[]> {
  const located: Located[] = [];
  for (const id of ids) {
    located.push(locate(id, tasksDir, projectRoot));
    await yieldToLoop();
  }
  const declarers = needsDeclarers(located)
    ? folderDeclarers(await readTaskFilesAsync(tasksDir), leavingFiles(located))
    : new Map<string, string[]>();
  const stays = staysOf(located, declarers);
  const leaving = leavingFolders(located, stays);
  return toTargets(located, stays, await foldersSurvivorsAsync(projectRoot, leaving));
}

/** Conformi al gate (potabili in blocco) e non conformi (da scartare a monte). */
export function splitTargets(targets: PurgeTarget[]): {
  clean: PurgeTarget[];
  dirty: PurgeTarget[];
} {
  return {
    clean: targets.filter((t) => t.survivors === 0),
    dirty: targets.filter((t) => t.survivors > 0),
  };
}
