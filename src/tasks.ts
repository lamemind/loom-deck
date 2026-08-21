import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitize } from './width.js';

/**
 * Forma di un ID task: `T` + numero. FONTE UNICA del gate — `parseTasks` lo usa
 * per scartare header/separatore della tabella, `task-edit` per non riscrivere
 * per sbaglio quelle stesse righe. Tenerlo in un posto solo evita che i due gate
 * divergano (uno accetterebbe righe che l'altro rifiuta).
 */
export const TASK_ID_RE = /^T\d+$/;

export interface Task {
  id: string;
  pri: string;
  prog: string;
  desc: string;
  /** `desc` NON sanificata — la forma esatta che sta su tasks.md.
   *  Serve al modale edit: pre-riempire il campo titolo con la versione
   *  sanificata e poi riscriverla su disco sostituirebbe i glifi discordi
   *  (`✔` → `✅`, `❤` → `·`) anche quando l'utente non ha toccato il campo. */
  rawDesc: string;
}

// Dettaglio letto dal task file singolo (Q1+B T20): campi header + description.
// `fields` è un dizionario grezzo dei bullet `- **Campo**: valore` così che
// futuri consumer (T21/T22) possano leggere chiavi nuove senza toccare il parser.
export interface TaskDetail {
  id: string;
  title: string;
  fields: Record<string, string>;
  description: string;
}

// D1 (preflight T20): default docs/tasks.md, override della docs-root via env
// LOOM_DECK_DOCS_ROOT (es. questo progetto usa `runtime`). No auto-detect.
export function resolveTasksPath(cwd: string = process.cwd()): string {
  const docsRoot = process.env.LOOM_DECK_DOCS_ROOT || 'docs';
  return join(cwd, docsRoot, 'tasks.md');
}

// I task file vivono in `<docsRoot>/tasks/` — sibling di tasks.md. Derivo la
// dir dallo stesso path per rispettare l'override LOOM_DECK_DOCS_ROOT.
export function resolveTasksDir(cwd: string = process.cwd()): string {
  return join(dirname(resolveTasksPath(cwd)), 'tasks');
}

/** Posizione delle celle dentro `line.split('|')`, presa dall'header. */
export interface TaskColumns {
  pri: number;
  prog: number;
  /** Prima cella della descrizione — le successive vanno rijoinate, può contenere `|`. */
  desc: number;
}

/**
 * Indici di colonna della Tasks Overview letti dall'HEADER, non cablati.
 *
 * Cablarli lega il parser al NUMERO di colonne invece che al loro nome: toglierne
 * una fa scivolare tutto di uno e il deck legge la cella sbagliata **senza
 * sollevare un errore** — la descrizione finisce dove si cerca il glifo di
 * progresso, e `updateTasksMdRow` riscrive quella posizione su disco. È la stessa
 * trappola già nota sull'indice di RIGA (selezione keyed su id, mai su posizione),
 * applicata all'indice di colonna.
 *
 * Solo `pri` e `prog` si cercano per nome; la descrizione è per costruzione la
 * colonna successiva a Prog, quindi rinominarla non rompe il parse. `null` = la
 * riga non è l'header — l'header della tabella Lane (`| Lane | …`) cade qui.
 */
export function headerColumns(line: string): TaskColumns | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t.split('|').map((c) => c.trim().toLowerCase());
  if (cells[1] !== 'id') return null;
  const pri = cells.indexOf('pri');
  const prog = cells.indexOf('prog');
  if (pri < 0 || prog < 0) return null;
  return { pri, prog, desc: prog + 1 };
}

// Estrae le righe `| Tnn | Pri | Prog | Task |` della Tasks Overview. Righe
// header/separatore non matchano `^T\d+$` → scartate.
//
// Le righe si parsano solo DOPO aver incontrato l'header: senza indici derivati
// non si tira a indovinare, la lista resta vuota. Un fallimento visibile invece
// di una cella letta al posto sbagliato.
export function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  let cols: TaskColumns | null = null;
  for (const line of content.split('\n')) {
    const header = headerColumns(line);
    if (header) {
      cols = header;
      continue;
    }
    if (!cols) continue;
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    // cells[0] = '' (prima del primo |), cells[last] = '' (dopo l'ultimo |)
    const id = cells[1];
    if (!TASK_ID_RE.test(id)) continue;
    const pri = cells[cols.pri] ?? '';
    const prog = cells[cols.prog] ?? '';
    // desc = colonna finale; join per resistere a eventuali `|` nella descrizione.
    const desc = cells.slice(cols.desc, -1).join('|').trim();
    // Sanificazione AL CONFINE: tutto ciò che entra da tasks.md è testo
    // arbitrario e può contenere glifi che Ink e il terminale misurano in modo
    // diverso (vedi `width.ts`). Farlo qui invece che a ogni sito di render è
    // ciò che impedisce di dimenticarne uno.
    //
    // `pri` e `prog` sono l'eccezione: NON si sanificano qui perché sono chiavi
    // SEMANTICHE, non testo — `isDone()` e le lookup di `view.ts` confrontano
    // il glifo, e `task-edit` lo riscrive in tasks.md. Sanificarli qui
    // renderebbe `✔` un `✅` anche su disco, cambiando il formato di famiglia.
    // La sanificazione di quei due avviene al display (`displayProg`).
    tasks.push({ id, pri, prog, desc: sanitize(desc), rawDesc: desc });
  }
  return tasks;
}

export function loadTasks(path: string): Task[] {
  return parseTasks(readFileSync(path, 'utf8'));
}

// ID → path del task file: `<id>-<slug>.md` nella tasks dir. Il dash dopo l'ID
// disambigua i prefissi (`T20-` non matcha `T2-…`). Se più file matchano, primo
// in ordine. `null` se la dir non è leggibile o nessun file matcha.
export function findTaskFile(dir: string, id: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${id}-`;
  const match = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()[0];
  return match ? join(dir, match) : null;
}

// Estrae title (H1, `Task:` prefix strippato), bullet header e blocco
// `## Description`. First-match-wins per chiave: se un campo compare due volte
// (es. T15 ha una riga Progress `yyyy-MM-dd` residuo template nel body) vince la
// prima — quella dell'header. La description si ferma al successivo `## `.
export function parseTaskDetail(id: string, content: string): TaskDetail {
  let title = '';
  const fields: Record<string, string> = {};
  const descLines: string[] = [];
  let inDesc = false;

  for (const line of content.split('\n')) {
    if (!title && line.startsWith('# ')) {
      // Il cappello `Task:` del template va via: il titolo mostrato è la
      // descrizione, non la categoria (già data dall'id).
      title = line.replace(/^#\s+/, '').replace(/^Task:\s*/, '').trim();
      continue;
    }
    if (line.startsWith('## ')) {
      inDesc = /^##\s+Description\b/.test(line);
      continue;
    }
    if (inDesc) {
      descLines.push(line);
      continue;
    }
    const f = line.match(/^-\s*\*\*(.+?)\*\*:\s*(.*)$/);
    if (f) {
      const key = f[1].trim();
      if (!(key in fields)) fields[key] = f[2].trim();
    }
  }

  // Stessa normalizzazione dell'overview: il task file è testo libero, e la
  // descrizione finisce nel pannello dettaglio dove un glifo mal misurato
  // allarga la riga oltre il bordo del pane.
  const normFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) normFields[k] = sanitize(v);
  return {
    id,
    title: sanitize(title),
    fields: normFields,
    description: sanitize(descLines.join('\n').trim()),
  };
}

/**
 * La task è un cappello (epica)?
 *
 * Il marker è `Size: Epic`, e sta sul CAPPELLO perché la parentela la dichiara
 * la figlia (`**Parent Task**`): un padre non sa di averne senza scandagliare
 * tutti gli altri task file, cosa che il deck non può fare nel loop di poll.
 *
 * Legge dal testo INTEGRALE del task file, l'unico posto dove il `Size` esiste:
 * in `tasks.md` quella colonna non c'è, quindi la lista non può rispondere e la
 * domanda ha senso solo dove il file è già stato aperto (il detail).
 *
 * Riusa `parseTaskDetail` invece di una regex propria: la grammatica dei bullet
 * header (`- **Campo**: valore`) è già scritta lì, e una seconda copia
 * divergerebbe al primo campo che cambia forma. Confronto case-insensitive — il
 * valore lo scrive un umano nel file, non uno script.
 *
 * Testo assente (`null`, task file non ancora letto) → `false`: la mancanza di
 * prova non è prova di cappello, e degradare sul caso comune è l'esito benigno.
 */
export function taskIsEpic(id: string, text: string | null): boolean {
  if (!text) return false;
  return (parseTaskDetail(id, text).fields['Size'] ?? '').trim().toLowerCase() === 'epic';
}

/**
 * Testo INTEGRALE del task file (T66 · detail).
 *
 * Distinto da `loadTaskDetail`, che estrae header e Description per il blocco
 * preview: qui si legge la task per intero — Acceptance, Deliverables,
 * Implementation Notes — e un parse che tenesse solo le sezioni note
 * nasconderebbe proprio ciò per cui si apre l'overlay.
 *
 * `sanitize` al confine come per il detail parsato: il task file è testo libero
 * e porta glifi che Ink e il terminale misurano diversamente. Non torna mai su
 * disco da qui, quindi la sostituzione non ha il rischio di `pri`/`prog`.
 */
export function loadTaskFileText(dir: string, id: string): string | null {
  const path = findTaskFile(dir, id);
  if (!path) return null;
  try {
    return sanitize(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function loadTaskDetail(dir: string, id: string): TaskDetail | null {
  const path = findTaskFile(dir, id);
  if (!path) return null;
  try {
    return parseTaskDetail(id, readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
