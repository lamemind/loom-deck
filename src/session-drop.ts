// Eliminazione di una conversazione dal disco — il pezzo PURO, senza React e
// senza selezione: riceve il path del transcript e rimuove ciò che CC tiene per
// quella conversazione. La decisione (quale, se viva, se pinnata) sta in
// `actions.ts`; la conferma nell'overlay `drop`.
import { existsSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Gli artefatti su disco di una conversazione: il transcript `<sid>.jsonl` e,
 * quando esiste, la cartella omonima accanto (`<sid>/`) dove CC scrive i
 * transcript dei subagent e gli output dei tool. Il sidecar del deck
 * (`session-tasks.jsonl`) NON è fra questi: è nostro, non di CC, e i suoi
 * record restano — chi elimina spinna da sé, così non nasce una riga stale.
 *
 * Il path deve finire in `.jsonl`: è l'unica forma che questo modulo accetta di
 * rimuovere, e un path qualunque passato per errore non deve diventare un
 * `rm -rf`.
 */
export function sessionArtifacts(transcriptPath: string): string[] {
  if (!transcriptPath.endsWith('.jsonl')) {
    throw new Error(`non è un transcript: ${transcriptPath}`);
  }
  const sibling = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'));
  const out = [transcriptPath];
  if (existsSync(sibling) && statSync(sibling).isDirectory()) out.push(sibling);
  return out;
}

/** Rimuove gli artefatti e restituisce i path toccati. Irreversibile: i
 *  transcript non stanno in git, e non esiste un cestino. */
export function dropSessionFiles(transcriptPath: string): string[] {
  const targets = sessionArtifacts(transcriptPath);
  for (const t of targets) rmSync(t, { recursive: true, force: true });
  return targets;
}
