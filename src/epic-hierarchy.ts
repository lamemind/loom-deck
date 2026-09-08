// T67 — mappa cappello/figlie per il grouping del Tasks pane, letta con UNA
// passata sui task file sotto `tasksDir`, gemella di `commitTimes` ma dal
// filesystem invece che da `git log`.
//
// P2 (preflight): sullo STESSO poll di `tasks.md` (`POLL_MS`), non su una scala
// propria come `useArchivable` — read+parse di 106 task file costa 7,86 ms,
// meno dei ~33 ms di `git log` che `useCommitTimes` paga già ogni tick. La
// parentela si edita anche a mano dentro un task file già in tabella, non solo
// alla nascita di una riga: un trigger sulla sola firma degli id (come
// `useArchivable`) lascerebbe quell'edit stale fino al prossimo giro largo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { taskEpicOf, taskIsEpic } from './tasks.js';

// Stesso pattern di `TASK_FILE_RE` in commit-times.ts: il basename del task
// file, non `TASK_ID_RE` di tasks.ts (ancorata all'id nudo, non matcha
// `T142-nome.md`).
const TASK_FILE_RE = /^(T\d+)-.*\.md$/;

export interface EpicHierarchy {
  /** figlia → cappello dichiarato (`**Parent Task**`). Validità NON verificata
   *  qui (cappello esistente? nella vista? non un ciclo?): la giudica il
   *  grouping in `view.ts` (D3/P6), che ha la lista intera sotto gli occhi. */
  epicOf: ReadonlyMap<string, string>;
  /** id il cui proprio task file porta `Size: Epic`. */
  epics: ReadonlySet<string>;
}

export const EMPTY_EPIC_HIERARCHY: EpicHierarchy = { epicOf: new Map(), epics: new Set() };

/**
 * T153 — gate module-level: il read+parse dei task file gira solo se la mtime
 * MASSIMA fra i file `T<N>-*.md` di `tasksDir` è cambiata da ultima chiamata
 * (un ordine di grandezza più economico del parse pieno che sostituisce,
 * cifre misurate nel Progress Log). Sulla SOLA mtime e non su una firma
 * degli id: deve intercettare un edit a mano di
 * `**Parent Task**` DENTRO un file già in tabella, che non aggiunge né toglie
 * nessun id (Testing Notes T153). A gate scattato torna la STESSA istanza —
 * `useEpicHierarchy` non ha più bisogno di una firma propria per lo stesso
 * motivo di `useCommitTimes` (P1 preflight).
 */
let cache: { key: string; maxMtime: number; hierarchy: EpicHierarchy } | null = null;

/**
 * Lettura SINCRONA di tutti i task file sotto `tasksDir`: costo del gate
 * accettabile sul poll da 1,5s anche a scan pieno (mai il caso in regime).
 * Cartella illeggibile o singolo file non apribile → entry saltata, mai un
 * throw — un dato di rendering non può rompere il deck, stessa regola di
 * `archivableIds`/`commitTimes`.
 */
export function scanEpicHierarchy(tasksDir: string): EpicHierarchy {
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    cache = null;
    return EMPTY_EPIC_HIERARCHY;
  }

  let maxMtime = 0;
  const files: string[] = [];
  for (const file of entries) {
    if (!TASK_FILE_RE.test(file)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(tasksDir, file)).mtimeMs;
    } catch {
      continue;
    }
    files.push(file);
    if (mtime > maxMtime) maxMtime = mtime;
  }

  if (cache && cache.key === tasksDir && cache.maxMtime === maxMtime) {
    return cache.hierarchy;
  }

  const epicOf = new Map<string, string>();
  const epics = new Set<string>();
  for (const file of files) {
    const id = TASK_FILE_RE.exec(file)![1]!;
    let content: string;
    try {
      content = readFileSync(join(tasksDir, file), 'utf8');
    } catch {
      continue;
    }
    if (taskIsEpic(id, content)) epics.add(id);
    const parent = taskEpicOf(id, content);
    if (parent) epicOf.set(id, parent);
  }
  const hierarchy = { epicOf, epics };
  cache = { key: tasksDir, maxMtime, hierarchy };
  return hierarchy;
}
