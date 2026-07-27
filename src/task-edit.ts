// T41 — Edit inline di priorità/stato dal deck.
// Le funzioni di rewrite sono PURE (stringa → stringa): la scrittura su disco è
// isolata in `writeTaskEdit`, così la grammatica delle sostituzioni è testabile
// senza toccare il filesystem.

import { readFileSync, writeFileSync } from 'node:fs';
import { TASK_ID_RE, findTaskFile } from './tasks.js';
import type { PriName, ProgName } from './view.js';

// Il task file scrive la priorità per NOME (`- **Priority**: Med`), tasks.md la
// scrive come GLIFO (colonna Pri). Due rappresentazioni dello stesso valore →
// due mappe, entrambe keyed sul nome canonico di view.ts (unica fonte del rango).
export const PRI_LABEL: Record<PriName, string> = { high: 'High', med: 'Med', low: 'Low' };
export const PRI_GLYPH: Record<PriName, string> = { high: '🔥', med: '⚡', low: '🔹' };

// `✔️` CON VS16: è la forma usata nelle righe Done già presenti in tasks.md e nei
// task file. view.ts normalizza via VS16 in lettura, quindi scrivere la forma
// lunga resta riconosciuto da priName/progName/isDone.
export const PROG_GLYPH: Record<ProgName, string> = {
  todo: '🔵',
  wip: '🟡',
  done: '✔️',
  locked: '🔒',
};

// Testo di default per stato, usato quando l'utente non digita un progresso
// arbitrario. Il campo `Progress` del task file è testo libero (`🟡 85%`,
// `🔵 Todo`, `✔️ Done at 2026-07-20`) → il glifo è il prefisso, il resto è prosa.
const PROG_DEFAULT: Record<ProgName, string> = {
  todo: 'Todo',
  wip: 'In Progress',
  done: 'Done',
  locked: 'Locked',
};

/** Data locale `YYYY-MM-DD` (non UTC: `toISOString` sposterebbe il giorno la sera). */
export function today(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Riga `Progress` del task file. `detail` è il progresso ARBITRARIO digitato
 * dall'utente: se c'è vince sempre (anche su done/locked — nessuna forma è
 * preclusa), se manca si cade sul default dello stato. Solo `done` senza detail
 * data-stampa, coerente con le righe già presenti (`✔️ Done at YYYY-MM-DD`).
 */
export function progressText(prog: ProgName, detail: string, date: string = today()): string {
  const glyph = PROG_GLYPH[prog];
  const d = detail.trim();
  if (d) return `${glyph} ${d}`;
  if (prog === 'done') return `${glyph} Done at ${date}`;
  return `${glyph} ${PROG_DEFAULT[prog]}`;
}

/**
 * Toglie il glifo di testa da un valore `Progress` (`🟡 85%` → `85%`).
 * Il glifo lo ri-deriva `progressText` dallo stato selezionato.
 */
export function stripProgGlyph(s: string): string {
  return s.replace(/^[\p{Extended_Pictographic}✔️\s]+/u, '').trim();
}

/**
 * Valore iniziale del campo "progresso arbitrario" all'apertura del modale.
 *
 * NON è semplicemente il testo corrente spogliato del glifo: se quel testo è
 * esattamente ciò che il default già produrrebbe (`🔵 Todo`, `🟡 In Progress`)
 * non c'è nulla di custom da preservare, e pre-riempirlo lo renderebbe
 * APPICCICOSO — cambiando stato la scritta vecchia resterebbe attaccata al
 * glifo nuovo (`🔵 Todo` → wip → `🟡 Todo`). Si parte quindi da vuoto e il
 * default segue lo stato scelto.
 *
 * Un testo che il default NON sa riprodurre è invece informazione dell'utente e
 * va tenuta: `🟡 85%` → `85%`, e `✔️ Done at 2026-07-14` → `Done at 2026-07-14`
 * (la data storica sopravvive, non viene ri-stampata a oggi).
 */
export function initialDetail(current: string, prog: ProgName, date: string = today()): string {
  const s = current.trim();
  if (!s || s === progressText(prog, '', date)) return '';
  return stripProgGlyph(s);
}

/**
 * Riscrive le celle Pri (col 2), Prog (col 4) e — se `desc` è passata — la
 * descrizione (col 5) della riga `| Tnn | … |` in tasks.md. Solo la PRIMA riga
 * con quell'id — l'overview è unica, un secondo match sarebbe un duplicato da
 * non propagare. Le celle non toccate restano i token grezzi originali: nessun
 * re-flow della tabella, il diff resta di una riga. `ok:false` = id assente →
 * il chiamante non scrive nulla.
 *
 * `desc` undefined ≠ `desc` vuota: la prima non tocca la cella (chiamata
 * legacy, solo pri/prog), la seconda la svuota davvero.
 *
 * La descrizione è l'ULTIMA colonna e può contenere `|` — che in una tabella
 * markdown spezza la cella. Riscriverla significa quindi collassare tutte le
 * celle da 5 fino alla penultima in una sola (`splice`), altrimenti i pezzi
 * della vecchia descrizione resterebbero appesi in coda alla nuova.
 *
 * L'id deve rispettare `TASK_ID_RE` (importato da tasks.ts — stesso gate di
 * `parseTasks`, non una copia): senza, un id arbitrario matcherebbe la riga di
 * HEADER (`| ID | Pri | K | Prog |`) o quella di separatore, riscrivendone le
 * celle e sfondando la tabella.
 */
export function updateTasksMdRow(
  content: string,
  id: string,
  priGlyph: string,
  progGlyph: string,
  desc?: string,
): { content: string; ok: boolean } {
  if (!TASK_ID_RE.test(id)) return { content, ok: false };
  let ok = false;
  const lines = content.split('\n').map((line) => {
    if (ok) return line;
    if (!line.trim().startsWith('|')) return line;
    const cells = line.split('|');
    if ((cells[1] ?? '').trim() !== id) return line;
    if (cells.length < 6) return line; // riga malformata → non toccarla
    ok = true;
    cells[2] = ` ${priGlyph} `;
    cells[4] = ` ${progGlyph} `;
    if (desc !== undefined) {
      // Da cells[5] fino alla penultima: l'ultima è la coda dopo il `|` finale
      // (stringa vuota su una riga ben formata) e va conservata, o la riga
      // perderebbe il proprio bordo destro.
      cells.splice(5, cells.length - 6, ` ${sanitizeCell(desc)} `);
    }
    return cells.join('|');
  });
  return { content: ok ? lines.join('\n') : content, ok };
}

/**
 * Rende un testo scrivibile dentro una CELLA di tabella markdown. Due caratteri
 * la romperebbero e non sono rappresentabili altrimenti su una riga sola:
 * il `|` (chiude la cella) e l'a-capo (chiude la riga). Il primo va escapato,
 * il secondo collassato a spazio. È l'unico posto dove il titolo viene toccato:
 * nel task file, che è markdown libero, va scritto verbatim.
 */
function sanitizeCell(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Riscrive i bullet header `- **Priority**:` e `- **Progress**:` del task file,
 * più — se `title` è passato — l'H1 di testa.
 * First-match-wins per chiave, stessa regola di `parseTaskDetail`: se un campo
 * ricompare nel body (residuo template) vince quello dell'header — così ciò che
 * il deck mostra e ciò che scrive restano la stessa riga.
 *
 * L'H1 conserva il proprio CAPPELLO (`# Task: …` code, `# Doc Task: …` doc):
 * `parseTaskDetail` lo strippa in lettura, quindi il titolo che arriva dal
 * modale non ce l'ha e riscrivere la riga nuda perderebbe la categoria. Il
 * prefisso si rilegge dalla riga esistente e si ri-antepone tale e quale — così
 * una T resta `# Task:` e una D resta `# Doc Task:` senza doverlo sapere qui.
 */
export function updateTaskFileFields(
  content: string,
  priLabel: string,
  progress: string,
  title?: string,
): { content: string; ok: boolean } {
  let priDone = false;
  let progDone = false;
  let titleDone = false;
  const lines = content.split('\n').map((line) => {
    if (title !== undefined && !titleDone && /^#\s+/.test(line)) {
      titleDone = true;
      const prefix = line.match(/^#\s+((?:Doc\s+)?Task:\s*)/)?.[1] ?? '';
      return `# ${prefix}${title.replace(/\s+/g, ' ').trim()}`;
    }
    if (!priDone && /^-\s*\*\*Priority\*\*:/.test(line)) {
      priDone = true;
      return `- **Priority**: ${priLabel}`;
    }
    if (!progDone && /^-\s*\*\*Progress\*\*:/.test(line)) {
      progDone = true;
      return `- **Progress**: ${progress}`;
    }
    return line;
  });
  const ok = priDone || progDone || titleDone;
  return { content: ok ? lines.join('\n') : content, ok };
}

export interface EditWriteInput {
  tasksPath: string;
  tasksDir: string;
  id: string;
  pri: PriName;
  prog: ProgName;
  detail: string;
  /** Titolo nuovo, già trimmato dal chiamante. `undefined` = non toccarlo
   *  (nessuna modifica in bozza); una stringa vuota NON è un titolo valido e
   *  viene scartata a monte — una riga senza descrizione renderebbe la task
   *  irriconoscibile in overview. */
  title?: string;
}

export interface EditWriteResult {
  /** Path effettivamente riscritti — sono anche quelli da passare al commit. */
  paths: string[];
  rowUpdated: boolean;
  fileUpdated: boolean;
  progress: string;
}

/**
 * Scrive i DUE lati della task: la riga di tasks.md (vista d'insieme) e i campi
 * del task file (dettaglio). Sono due fonti che devono restare allineate — il
 * deck legge la prima e mostra la seconda — quindi si toccano insieme.
 * Un lato mancante (id fuori overview, o nessun task file) non blocca l'altro:
 * si scrive ciò che esiste e il risultato dice cosa è stato toccato.
 */
export function writeTaskEdit(input: EditWriteInput): EditWriteResult {
  const { tasksPath, tasksDir, id, pri, prog, detail, title } = input;
  const progress = progressText(prog, detail);
  const paths: string[] = [];

  const row = updateTasksMdRow(
    readFileSync(tasksPath, 'utf8'),
    id,
    PRI_GLYPH[pri],
    PROG_GLYPH[prog],
    title,
  );
  if (row.ok) {
    writeFileSync(tasksPath, row.content, 'utf8');
    paths.push(tasksPath);
  }

  let fileUpdated = false;
  const taskFile = findTaskFile(tasksDir, id);
  if (taskFile) {
    const upd = updateTaskFileFields(readFileSync(taskFile, 'utf8'), PRI_LABEL[pri], progress, title);
    if (upd.ok) {
      writeFileSync(taskFile, upd.content, 'utf8');
      paths.push(taskFile);
      fileUpdated = true;
    }
  }

  return { paths, rowUpdated: row.ok, fileUpdated, progress };
}
