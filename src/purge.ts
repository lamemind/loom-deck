// T112 — il BERSAGLIO di una potatura, e se il gate del plugin lo lascerebbe
// passare.
//
// Il deck non pota: ordina la potatura a `loom-works:clean-tasks`, che possiede
// l'intera sequenza distruttiva (task file + folder dot-prefixed + riga in
// tasks.md, un commit atomico per task, symlink `current-task.md` rimosso,
// righe orfane riconciliate). Qui non c'è nessun `git rm` e nessuna riscrittura
// di tasks.md — solo il calcolo di CHI si può potare.
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

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
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
  /** Quanti file `git rm` NON rimuoverebbe. `> 0` = il gate del plugin
   *  scatterebbe su questa task. */
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

/** Task folder della task, risolta e verificata su disco. */
export function taskFolder(projectRoot: string, taskFilePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(taskFilePath, 'utf8');
  } catch {
    return null;
  }
  const field = folderField(content);
  if (!field) return null;
  const abs = join(projectRoot, field.replace(/^\.\//, ''));
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
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

function targetFolder(id: string, tasksDir: string, projectRoot: string): string | null {
  const taskFile = findTaskFile(tasksDir, id);
  return taskFile ? taskFolder(projectRoot, taskFile) : null;
}

function toTargets(ids: string[], folders: (string | null)[], survivors: string[][]): PurgeTarget[] {
  let next = 0;
  return ids.map((id, i) => {
    const folder = folders[i]!;
    return { id, folder, survivors: folder ? survivors[next++]!.length : 0 };
  });
}

/**
 * Il bersaglio, misurato ADESSO.
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
  const folders = ids.map((id) => targetFolder(id, tasksDir, projectRoot));
  const present = folders.filter((folder): folder is string => folder !== null);
  return toTargets(ids, folders, foldersSurvivors(projectRoot, present));
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
  const folders: (string | null)[] = [];
  for (const id of ids) {
    folders.push(targetFolder(id, tasksDir, projectRoot));
    await yieldToLoop();
  }
  const present = folders.filter((folder): folder is string => folder !== null);
  return toTargets(ids, folders, await foldersSurvivorsAsync(projectRoot, present));
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
