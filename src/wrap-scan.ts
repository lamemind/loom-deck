// T134 — l'hard-wrap dei `.md` come dato del deck.
//
// Lo scanner è `scripts/docs/md-wrap.py` del plugin, e resta lì per intero: il
// riconoscimento del wrap sta in tre euristiche tarate su un collaudo (la
// colonna è una banda con tolleranza, si stima sul 90° percentile, lo
// srotolamento itera a colonna ferma) e replicarle qui darebbe due misure
// destinate a divergere in silenzio.
//
// A differenza della coda inbox, questa misura è CARA: cammina l'albero del
// progetto intero, submodule compresi. Da qui la forma già in casa per il
// project status — generare e aprire su due tasti distinti, con una cache su
// disco in mezzo — invece di uno scan all'avvio che rallenterebbe proprio il
// momento in cui si vuole vedere qualcosa subito.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pluginScript } from './plugin-cache.js';

const execFileAsync = promisify(execFile);

export const WRAP_SCRIPT = 'scripts/docs/md-wrap.py';

/** Solo `WRAP` entra nel contatore; `misto` compare in lista e resta fuori. */
export type WrapVerdict = 'WRAP' | 'misto';

export interface WrapFile {
  verdict: WrapVerdict;
  /** Path relativo alla radice dello scan. */
  path: string;
  /** Colonna di wrap stimata; `null` quando le candidate erano troppo poche. */
  column: number | null;
  ratio: number;
  breaks: number;
  prose: number;
}

const FIELD_RE = /^(col|ratio|breaks|prose)=(.*)$/;

/**
 * Il TSV di `md-wrap.py --scan`: una riga per file NON `libero`, nella forma
 * `verdetto ⇥ path ⇥ col=N ⇥ ratio=N ⇥ breaks=N ⇥ prose=N`.
 *
 * I campi si leggono per nome e non per posizione: sono già etichettati
 * nell'output, e leggerli per indice trasformerebbe una colonna aggiunta in
 * fondo in numeri sbagliati invece che in un campo ignorato.
 */
export function parseWrapTsv(stdout: string): WrapFile[] {
  const out: WrapFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const verdict = cells[0];
    if (verdict !== 'WRAP' && verdict !== 'misto') continue;
    if (!cells[1]) continue;
    const fields: Record<string, string> = {};
    for (const cell of cells.slice(2)) {
      const m = FIELD_RE.exec(cell.trim());
      if (m) fields[m[1]] = m[2];
    }
    const column = Number(fields.col);
    out.push({
      verdict,
      path: cells[1],
      column: Number.isFinite(column) ? column : null,
      ratio: Number(fields.ratio) || 0,
      breaks: Number(fields.breaks) || 0,
      prose: Number(fields.prose) || 0,
    });
  }
  // I peggiori in cima: chi apre la lista srotola da lì.
  return out.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === 'WRAP' ? -1 : 1;
    return b.breaks - a.breaks;
  });
}

/**
 * D4 — il contatore conta i soli `WRAP`.
 *
 * `misto` ospita il falso allarme strutturale: file di note scritte una riga per
 * pensiero, che nessuno vuole srotolare. Sommarlo darebbe un numero che non si
 * può portare a zero, e un contatore che non arriva mai a zero smette di essere
 * letto.
 */
export function wrapCount(files: readonly WrapFile[]): number {
  return files.filter((f) => f.verdict === 'WRAP').length;
}

/**
 * Cartella della cache, una per utente e con `mode 0700` — stessa ragione del
 * project status: `/tmp` è condivisa, e un file a nome prevedibile può essere
 * preceduto dal symlink di un altro utente.
 */
export function wrapCacheDir(): string {
  return join(tmpdir(), `loom-deck-wrap-${process.getuid?.() ?? 0}`);
}

export function wrapCacheFile(projectRoot: string): string {
  const env = process.env.LOOM_DECK_WRAP_FILE;
  if (env) return env;
  return join(wrapCacheDir(), `${projectRoot.replace(/[^a-zA-Z0-9]/g, '-')}.tsv`);
}

export interface WrapCache {
  files: WrapFile[];
  /** Ora dell'ultimo scan riuscito: l'mtime del file, mai un campo nel testo. */
  mtime: number;
}

/** File assente o illeggibile → nessuna cache: `missing` è lo stato di partenza. */
export function readWrapCache(path: string): WrapCache | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return { files: parseWrapTsv(raw), mtime: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Lo scan, in headless. `false` = guasto — plugin assente, `python3` assente,
 * script in errore: i tre casi collassano, perché a schermo non cambiano la
 * prima mossa di chi li vede.
 *
 * La cache si riscrive SOLO su successo: un tentativo fallito lascia in piedi
 * l'esito dell'ultimo scan riuscito, che resta vero e ancora apribile.
 */
export async function runWrapScan(projectRoot: string): Promise<boolean> {
  const script = pluginScript(WRAP_SCRIPT);
  if (!script) return false;
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [script, '--root', projectRoot, '--scan'],
      { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const path = wrapCacheFile(projectRoot);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, stdout, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
