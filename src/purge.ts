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

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findTaskFile } from './tasks.js';

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

/**
 * I file di una folder che `git rm` non rimuove — ignorati da un `.gitignore` o
 * mai tracciati.
 *
 * Stesso comando di `lw_folder_survivors` in `lib.sh` (`git ls-files -o`, senza
 * `--exclude-standard`, quindi ignorati inclusi): replicare il predicato del
 * gate ha senso solo se è LO STESSO predicato.
 *
 * Git muto (non installato, repo assente) → lista vuota, cioè "conforme". La
 * direzione dell'errore è deliberata: il gate a valle resta comunque la rete,
 * e il chiamante ne riporta il fallimento invece di dichiarare successo.
 */
export function folderSurvivors(projectRoot: string, folder: string): string[] {
  const rel = relative(projectRoot, folder);
  if (!rel || rel.startsWith('..')) return [];
  try {
    const out = execFileSync('git', ['ls-files', '-o', '--', rel], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Il bersaglio, misurato ADESSO.
 *
 * Sincrono apposta: la dirtiness è un dato campionato (la vista `archiviabili`
 * lo mostra da uno scan periodico) e nell'istante in cui si preme il tasto può
 * essere stale — una folder sporcata dopo l'ultimo scan si presenterebbe come
 * eliminabile. Ricalcolarlo al momento dell'azione costa uno spawn di git per
 * le sole task che dichiarano una folder, cioè quasi nulla.
 */
export function purgeTargets(ids: string[], tasksDir: string, projectRoot: string): PurgeTarget[] {
  return ids.map((id) => {
    const taskFile = findTaskFile(tasksDir, id);
    const folder = taskFile ? taskFolder(projectRoot, taskFile) : null;
    return {
      id,
      folder,
      survivors: folder ? folderSurvivors(projectRoot, folder).length : 0,
    };
  });
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
