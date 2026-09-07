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
 */
export async function commitTimes(
  tasksDir: string,
  projectRoot: string,
): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=#%ct', '--name-only', '--', tasksDir],
      { cwd: projectRoot },
    );
    return parseCommitLog(stdout);
  } catch {
    return new Map();
  }
}
