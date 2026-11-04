// T136 — data dell'ultimo commit che ha toccato ogni task file, in UNA
// passata di `git log` invece di uno spawn per file (vedi Description T136).
//
// `--format=#%ct` mette un prefisso che nessun path porta: la riga vuota
// compare anche FRA il timestamp e i path (non solo a fine blocco), quindi non
// può fare da separatore, e «tutte cifre» sarebbe una regola che un path
// potrebbe violare. Un merge commit senza `-m` non elenca path e produce un
// blocco senza righe path: si salta da sé, nessun ramo dedicato serve.
//
// git log esce in ordine cronologico DISCENDENTE: il primo hit di un path è
// già il suo ultimo commit, quindi si tiene solo il primo e si ignorano gli
// hit successivi dello stesso id.
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FORMAT_RE = /^#(\d+)$/;
// Il basename del task file, non il path intero (che cambia con la docs-root)
// e non `TASK_ID_RE` di tasks.ts (ancorata all'id nudo, non matcha `T136-x.md`).
const TASK_FILE_RE = /^(T\d+)-.*\.md$/;

const EMPTY_MAP: ReadonlyMap<string, number> = new Map();

/**
 * T153 — gate module-level: `git log` gira solo se lo sha di HEAD è cambiato
 * dall'ultima chiamata su questa stessa coppia (tasksDir, projectRoot). Le
 * date di ultimo commit cambiano SOLO se HEAD si muove (§Implementation
 * Notes T153): uno sha non risolvibile degrada come degradava il log, mai un
 * throw. `key` tiene le due coppie separate — un test che passa tmpdir
 * diversi a chiamate successive non deve leggere la cache dell'altro.
 */
let cache: { key: string; sha: string; map: ReadonlyMap<string, number> } | null = null;
let logSpawns = 0;

/** T153/DLV6 — quante volte è partito lo spawn COSTOSO (`git log`), non il
 *  gate. Il gate (`rev-parse`) gira a ogni chiamata per costruzione: contarlo
 *  renderebbe il numero inutile a dimostrare il no-op. */
export function commitLogSpawnCount(): number {
  return logSpawns;
}

let headSpawns = 0;

/** T191 — quante volte il gate ha dovuto chiedere lo sha a `git rev-parse`
 *  invece di leggerlo dal filesystem. Su un repo ordinario resta fermo: è il
 *  numero che dimostra «nessun processo per tick». */
export function headSpawnCount(): number {
  return headSpawns;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Ref che git tiene nel gitdir del worktree invece che nella cartella comune
// (`git help worktree`, §Details). Un ref di branch sta sempre nella comune.
const PER_WORKTREE_REF_RE = /^refs\/(?:bisect|worktree|rewritten)\//;
// Catena di ref simbolici: HEAD → refs/heads/x è un passo; oltre, git stesso
// rifiuta presto (`SYMREF_MAXDEPTH` = 5).
const SYMREF_MAX_DEPTH = 5;

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Il gitdir del repo che contiene `start`, risalendo come fa git: `.git`
 *  cartella, oppure `.git` file con `gitdir: <path>` (worktree di lane,
 *  submodule), relativo alla cartella del file. */
async function findGitDir(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    const dotGit = join(dir, '.git');
    try {
      const st = await stat(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec((await readFile(dotGit, 'utf8')).trim());
        return m ? resolve(dir, m[1]!.trim()) : null;
      }
    } catch {
      // nessun `.git` qui: si sale
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Lo sha di `refname`: file sciolto prima, `packed-refs` poi — lo stesso
 *  ordine di git, perché un ref sciolto batte la sua copia impacchettata. */
async function readRef(gitDir: string, commonDir: string, refname: string): Promise<string | null> {
  const base = PER_WORKTREE_REF_RE.test(refname) ? gitDir : commonDir;
  const loose = await readTrimmed(join(base, ...refname.split('/')));
  if (loose !== null) return loose;
  const packed = await readTrimmed(join(commonDir, 'packed-refs'));
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp > 0 && line.slice(sp + 1).trim() === refname) return line.slice(0, sp);
  }
  return null;
}

/**
 * T191 — lo sha di HEAD letto dal filesystem, senza processi: `.git` (o il
 * gitdir che il file `.git` nomina), `HEAD`, il ref che HEAD nomina nella
 * cartella comune (`commondir` di un worktree), `packed-refs`. `null` = il
 * filesystem non basta: unborn branch, reftable, file a metà scrittura, env che
 * sposta il repo. Il chiamante allora chiede a git.
 */
async function headShaFromFs(projectRoot: string): Promise<string | null> {
  // GIT_DIR / GIT_COMMON_DIR spostano il repo fuori da dove la risalita guarda.
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR) return null;
  let start: string;
  try {
    // git risale dal path fisico (getcwd), non da quello col symlink.
    start = await realpath(projectRoot);
  } catch {
    return null;
  }
  const gitDir = await findGitDir(start);
  if (gitDir === null) return null;
  const common = await readTrimmed(join(gitDir, 'commondir'));
  const commonDir = common ? resolve(gitDir, common) : gitDir;

  let value = await readTrimmed(join(gitDir, 'HEAD'));
  for (let depth = 0; value !== null && depth <= SYMREF_MAX_DEPTH; depth++) {
    if (SHA_RE.test(value)) return value;
    const m = /^ref:\s*(\S+)$/.exec(value);
    if (!m) return null;
    value = await readRef(gitDir, commonDir, m[1]!);
  }
  return null;
}

/**
 * Lo sha di HEAD per il gate. T191: dal filesystem, perché su Windows un
 * `git rev-parse HEAD` lanciato da node sono due processi e circa un decimo di
 * secondo di CPU, e il gate gira a ogni tick. Quando il filesystem non risolve,
 * decide git, come prima di T191: il ripiego costa come il gate di T153, mai
 * di più, e non produce mai uno sha diverso da quello di git.
 */
async function headSha(projectRoot: string): Promise<string | null> {
  const fromFs = await headShaFromFs(projectRoot);
  if (fromFs !== null) return fromFs;
  headSpawns++;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Parsing puro dell'output `git log --format=#%ct --name-only`. Isolato da
 * `commitTimes` perché è l'unica parte che vale la pena collaudare: invocare
 * git davvero misurerebbe la storia di QUESTO repo, un valore che si muove a
 * ogni commit.
 */
export function parseCommitLog(output: string): Map<string, number> {
  const out = new Map<string, number>();
  let epoch: number | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const m = FORMAT_RE.exec(line);
    if (m) {
      epoch = Number(m[1]);
      continue;
    }
    if (!line || epoch === null) continue;
    const idm = TASK_FILE_RE.exec(basename(line));
    if (!idm) continue;
    const id = idm[1]!;
    if (!out.has(id)) out.set(id, epoch); // primo hit = il più recente
  }
  return out;
}

/**
 * `Map<taskId, epoch>` dell'ultimo commit di ogni task file sotto `tasksDir`.
 *
 * git muto (repo assente, path fuori dal repo, git non installato) → mappa
 * vuota, mai un throw, come `archivable.ts`: un dato di ordinamento non può
 * rompere il deck. Nessun `--since`/`-n`: un cap renderebbe la mappa
 * incompleta proprio per le task vecchie mai più toccate, quelle che sotto
 * `desc` finiscono in coda — dove un timestamp assente e uno vecchio si
 * confonderebbero.
 *
 * T153 — gate sullo sha di HEAD, letto dal filesystem da T191 (`headSha`:
 * nessun processo per tick, `git rev-parse` solo dove il filesystem non
 * basta): a sha invariato torna la STESSA istanza di mappa, non una ricostruita — è
 * ciò che rende inutile il confronto per firma in `useCommitTimes` (P1
 * preflight).
 */
export async function commitTimes(
  tasksDir: string,
  projectRoot: string,
): Promise<ReadonlyMap<string, number>> {
  const key = `${projectRoot}\u0000${tasksDir}`;
  const sha = await headSha(projectRoot);
  if (sha !== null && cache && cache.key === key && cache.sha === sha) {
    return cache.map;
  }
  let map: ReadonlyMap<string, number>;
  try {
    // Il contatore sale PRIMA dell'await: conta gli spawn partiti, e uno
    // spawn fallito costa comunque la fork del processo.
    logSpawns++;
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=#%ct', '--name-only', '--', tasksDir],
      { cwd: projectRoot, windowsHide: true },
    );
    map = parseCommitLog(stdout);
  } catch {
    map = EMPTY_MAP;
  }
  // sha === null (git muto): non si cachea uno stato che il prossimo giro
  // potrebbe smentire in silenzio (repo che ricompare) senza mai vedersi
  // ricontrollato.
  cache = sha !== null ? { key, sha, map } : null;
  return map;
}
