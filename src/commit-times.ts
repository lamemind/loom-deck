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
import { basename } from 'node:path';
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
 * Notes T153): un rev-parse fallito degrada come degradava il log, mai un
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

async function headSha(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
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
 * T153 — gate su `rev-parse HEAD` (un ordine di grandezza più economico
 * dello spawn del log che sostituisce, cifre misurate nel Progress Log): a
 * sha invariato torna la STESSA istanza di mappa, non una ricostruita — è
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
      { cwd: projectRoot },
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
