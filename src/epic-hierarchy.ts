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
import { readdirSync, readFileSync } from 'node:fs';
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
 * Lettura SINCRONA di tutti i task file sotto `tasksDir`: costo misurato in P2,
 * accettabile sul poll da 1,5s. Cartella illeggibile o singolo file non
 * apribile → entry saltata, mai un throw — un dato di rendering non può
 * rompere il deck, stessa regola di `archivableIds`/`commitTimes`.
 */
export function scanEpicHierarchy(tasksDir: string): EpicHierarchy {
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return EMPTY_EPIC_HIERARCHY;
  }
  const epicOf = new Map<string, string>();
  const epics = new Set<string>();
  for (const file of entries) {
    const m = TASK_FILE_RE.exec(file);
    if (!m) continue;
    const id = m[1]!;
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
  return { epicOf, epics };
}
