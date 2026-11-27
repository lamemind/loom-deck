// T178 — il gate del sensore del gitlink: una firma letta dal filesystem, senza
// processi, davanti a `bump-gitlink.sh --dry-run`.
//
// Su Windows un giro del dry-run dura secondi (ogni sottoprocesso di Git Bash
// costa intorno ai 150 ms), e il sensore lo ripeteva ogni 30 secondi anche a
// repo fermi. Il dry-run legge solo file locali — il gitlink nel cappello, HEAD
// dei membri, i loro remote-tracking ref —, quindi una firma di quei file dice
// se il giro può dare un esito diverso dal precedente. Se la firma non cambia il
// giro si salta; un giro forzato a intervallo lungo copre ciò che la firma non
// vede.
//
// Modulo senza React. La firma è I/O sul filesystem, la decisione è pura.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Ogni quanto il giro parte anche a firma ferma.
 *
 * È la rete di sicurezza della firma: un ref che git riscrive con la stessa
 * mtime e la stessa dimensione, un layout dei ref che la firma non legge
 * (reftable), un cambio che arriva da una parte non prevista. Dieci minuti
 * contro i 30 secondi del tick: su Windows il costo a vuoto scende di venti
 * volte, e un cambio che la firma non vede si mostra comunque entro un tempo
 * che chi guarda la testata tollera.
 */
export const GITLINK_FORCE_INTERVAL_MS = 10 * 60 * 1000;

/** L'ultimo giro riuscito: la firma che aveva davanti e quando è partito. */
export interface GitlinkGateMemo {
  sig: string;
  at: number;
}

/**
 * Il giro serve. Sì quando non c'è un giro riuscito da confrontare, quando la
 * firma non si legge (`null`: il filesystem non basta e decide lo script),
 * quando la firma è cambiata, o quando il giro forzato è scaduto.
 */
export function gitlinkScanDue(memo: GitlinkGateMemo | null, sig: string | null, now: number): boolean {
  if (memo === null || sig === null) return true;
  if (sig !== memo.sig) return true;
  return now - memo.at >= GITLINK_FORCE_INTERVAL_MS;
}

async function readOr(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '-';
  }
}

/** mtime e dimensione: per i file che possono essere grandi (l'indice). */
async function stampOf(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

/** Il gitdir di `dir`, SENZA risalire: `.git` cartella, o file con
 *  `gitdir: <path>` relativo a `dir`. Un membro non inizializzato non ha `.git`,
 *  e risalire troverebbe quello del cappello. */
async function gitDirAt(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git');
  try {
    const st = await stat(dotGit);
    if (st.isDirectory()) return dotGit;
    if (!st.isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec((await readFile(dotGit, 'utf8')).trim());
    return m ? resolve(dir, m[1]!.trim()) : null;
  } catch {
    return null;
  }
}

/** I file sotto `dir`, ricorsivi, ordinati: i remote-tracking ref sciolti. */
async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(path)));
    else if (e.isFile()) out.push(path);
  }
  return out.sort();
}

/**
 * La firma di un repo: HEAD, il ref che HEAD nomina, `packed-refs`, e a
 * richiesta l'indice (il gitlink del cappello sta lì prima del commit) e i
 * remote-tracking ref (la guardia sul remote dei membri li legge).
 *
 * Contenuto per i file piccoli — uno sha non si confonde con un altro — e mtime
 * con dimensione per l'indice, che può pesare megabyte.
 */
async function repoSig(
  dir: string,
  opts: { index: boolean; remotes: boolean },
): Promise<string> {
  const gitDir = await gitDirAt(dir);
  if (gitDir === null) return '-';
  const common = await readOr(join(gitDir, 'commondir'));
  const commonDir = common === '-' ? gitDir : resolve(gitDir, common);
  const head = await readOr(join(gitDir, 'HEAD'));
  const parts = [head];
  const ref = /^ref:\s*(\S+)$/.exec(head);
  if (ref) parts.push(await readOr(join(commonDir, ...ref[1]!.split('/'))));
  parts.push(await readOr(join(commonDir, 'packed-refs')));
  if (opts.index) parts.push(await stampOf(join(gitDir, 'index')));
  if (opts.remotes) {
    for (const file of await filesUnder(join(commonDir, 'refs', 'remotes'))) {
      parts.push(`${file.slice(commonDir.length)}=${await readOr(file)}`);
    }
  }
  return parts.join('\n');
}

/** I path dei submodule dichiarati in `.gitmodules`. */
export function gitmodulePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) out.push(m[1]!);
  return out;
}

/**
 * La firma di ciò che il dry-run legge, o `null` se il filesystem non basta.
 *
 * Entra: `.gitmodules`; del cappello HEAD, il suo ref e l'indice; di ogni
 * membro HEAD, il suo ref e i remote-tracking ref. Una firma uguale alla
 * precedente vuol dire che il dry-run darebbe lo stesso esito.
 *
 * `GIT_DIR` e `GIT_COMMON_DIR` spostano il repo fuori da dove la firma guarda,
 * e senza `.git` nella root il repo sta più in alto: in entrambi i casi `null`,
 * e il giro parte.
 */
export async function gitlinkSignature(projectRoot: string): Promise<string | null> {
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR) return null;
  if ((await gitDirAt(projectRoot)) === null) return null;
  const modules = await readOr(join(projectRoot, '.gitmodules'));
  const parts = [modules, await repoSig(projectRoot, { index: true, remotes: false })];
  for (const path of gitmodulePaths(modules)) {
    parts.push(`[${path}]`, await repoSig(join(projectRoot, path), { index: false, remotes: true }));
  }
  return parts.join('\n');
}
