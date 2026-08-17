// T61 — conteggio delle task Done potabili ("archiviabili").
//
// Il deck NON pota: mostra solo quante task Done hanno superato la soglia
// d'età, così la policy di retention — manuale per scelta, nessuna GC
// automatica — ha almeno un segnale che la renda esercitabile. La potatura
// resta `loom-works:clean-tasks`, invocata da un umano.
//
// D1 (preflight) — la regola d'età è RICALCOLATA qui, non delegata a
// `cleanup-done-tasks.sh`: il deck è un binario npm globale spawnato da Ptyxis,
// fuori dal processo Claude Code, quindi non riceve `CLAUDE_PLUGIN_ROOT` e non
// ha modo di ricavare il path dello script — che vive sotto
// `~/.claude/plugins/cache/…/<version>/`, version-pinned e riscritto a ogni
// `plugin update`. La duplicazione della regola fra i due è un costo accettato:
// è una data meno un'altra. Il prezzo è che le due implementazioni devono
// concordare sul confine — vedi `ageDays` e `DEFAULT_ARCHIVABLE_DAYS`.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { findTaskFile, parseTaskDetail } from './tasks.js';

const execFileAsync = promisify(execFile);

const MS_PER_DAY = 86_400_000;

/**
 * D3 (preflight) — metà della policy di purge (`cleanup-done-tasks.sh --days`
 * ha default 60). Il contatore fa quindi da PREAVVISO, non da predizione: chi
 * vede `N archiviabili` e lancia `clean-tasks` senza argomenti ne pota zero.
 * I due numeri sono deliberatamente diversi.
 */
export const DEFAULT_ARCHIVABLE_DAYS = 30;

/** Ogni 6 ore. L'età di una task cambia una volta al giorno: agganciare lo
 *  scan al poll da 1,5s di `tasks.md` costerebbe N letture di file al secondo
 *  per un dato che non si muove. Due scale di refresh distinte, stesso processo. */
export const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Un SHA che iniziasse per `-` verrebbe letto da git come flag: qui non passa. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DONE_AT_RE = /Done at (\d{4}-\d{2}-\d{2})/;

/**
 * Età in giorni interi di una data ISO. `null` se non parsabile.
 *
 * D5 (preflight) — allineata a `cleanup-done-tasks.sh`, che fa
 * `age_days=$(( (NOW_EPOCH - done_epoch) / 86400 ))` e poi `age_days < DAYS →
 * skip`: divisione intera troncata, confronto `>=`. Due implementazioni della
 * stessa regola (D1) devono almeno concordare su dove cade il confine.
 *
 * Una data NUDA (`2026-07-20`, la forma di `Done at`) si ancora alla mezzanotte
 * LOCALE, non UTC: è ciò che fa `date -d 2026-07-20` nello script. `Date.parse`
 * su una data nuda darebbe mezzanotte UTC, cioè fino a mezza giornata di
 * scarto — abbastanza per spostare di 1 il conteggio proprio sul confine.
 * I timestamp completi che arrivano da `git --format=%cI` portano l'offset e
 * passano invece da `Date.parse`.
 */
export function ageDays(iso: string, now: number): number | null {
  let t: number;
  if (DATE_ONLY_RE.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    t = new Date(y, m - 1, d).getTime();
  } else {
    t = Date.parse(iso);
  }
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / MS_PER_DAY);
}

export interface ScanOptions {
  tasksDir: string;
  projectRoot: string;
  days: number;
  now?: number;
}

/**
 * Data di chiusura di una task, per cascata a tre gradini + skip finale.
 * Ordine e semantica IDENTICI a `cleanup-done-tasks.sh` (D2 del preflight):
 * sul repo reale il solo gradino ① copriva 22 Done su 29, quindi un contatore
 * fermo al primo gradino avrebbe sottostimato di un quarto senza dirlo.
 *
 * Il gradino ③ è un'approssimazione già accettata dallo script: `git log -1`
 * dà la data dell'ULTIMO commit che tocca il file, non quella di chiusura —
 * una ri-edit post-done ringiovanisce la task e la fa uscire dal conteggio.
 * L'errore cade sempre dal lato sicuro (mai una task contata come più vecchia
 * di quel che è), che è la stessa ragione per cui il gradino ④ è uno skip.
 */
async function resolveDoneDate(
  id: string,
  content: string,
  taskFile: string,
  projectRoot: string,
): Promise<string | null> {
  // `fields` è first-match-wins come il `grep -m1` dello script: se un task
  // file ripete `Progress` nel body (residuo di template) vince quello header.
  const { fields } = parseTaskDetail(id, content);

  // ① `- **Progress**: ✔️ Done at YYYY-MM-DD` — sorgente deterministica.
  const doneAt = DONE_AT_RE.exec(fields['Progress'] ?? '');
  if (doneAt) return doneAt[1];

  // ② `- **Last tracked commit**: <sha>` → data del commit.
  // Primo token soltanto: il campo ammette un'annotazione inline dopo il valore.
  const sha = (fields['Last tracked commit'] ?? '').split(/\s+/)[0];
  if (SHA_RE.test(sha)) {
    const d = await gitOut(['show', '-s', '--format=%cI', sha], projectRoot);
    if (d) return d;
  }

  // ③ ultimo commit che tocca il task file. `--` protegge il path da un nome
  // che somigli a un flag.
  return gitOut(['log', '-1', '--format=%cI', '--', taskFile], projectRoot);
}

/** git muto (repo assente, sha sconosciuto, git non installato) → `null`, mai
 *  un throw: un contatore informativo non può rompere il deck. */
async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Quali fra le task Done passate sono oltre soglia. Le indeterminate (nessuno
 * dei tre gradini risolve) e le righe orfane (Done in tasks.md ma task file
 * assente) NON entrano: il deck non chiama "vecchia" una task di cui non sa
 * l'età.
 *
 * Riceve gli id già filtrati sul glifo Done invece della lista completa: lo
 * scan resta così proporzionale al vecchiume, non alla lunghezza della lista.
 *
 * T100 — ritorna gli ID e non più il solo conteggio: `archiviabili` è diventata
 * una vista navigabile del pane task, e il numero da solo non basta più a
 * disegnarne le righe. Il contatore dell'header è la lunghezza della lista, così
 * ciò che si conta e ciò che si mostra restano lo stesso insieme per
 * costruzione.
 */
export async function archivableIds(doneIds: string[], opts: ScanOptions): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const out: string[] = [];
  for (const id of doneIds) {
    const taskFile = findTaskFile(opts.tasksDir, id);
    if (!taskFile) continue;
    let content: string;
    try {
      content = readFileSync(taskFile, 'utf8');
    } catch {
      continue;
    }
    const iso = await resolveDoneDate(id, content, taskFile, opts.projectRoot);
    if (!iso) continue;
    const age = ageDays(iso, now);
    if (age !== null && age >= opts.days) out.push(id);
  }
  return out;
}
