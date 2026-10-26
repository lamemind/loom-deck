// T175 — i confronti di path che il deck fa sulla root del progetto, per
// piattaforma.
//
// Tre punti confrontavano path come stringhe POSIX: il filtro delle
// conversazioni del progetto (`sessions.ts`), quello delle sessioni vive
// (`live-sessions.ts`) e il nome del progetto (`deck-model.ts`). Su Linux la
// stringa È il path; su Windows no, per tre ragioni misurate (verdetto 1 di T174):
//
//  - NTFS non distingue le maiuscole, e Claude Code non normalizza la grafia
//    della cwd: VS Code passa `c:\…`, Windows Terminal `C:\…`, e lo stesso
//    progetto ha due cartelle di transcript (`c--…` e `C--…`);
//  - `\` e `/` sono entrambi separatori;
//  - nei transcript `cwd` compare anche in forma MSYS (`/c/…`), quella di Git
//    Bash.
//
// Modulo PURO. La piattaforma è un parametro con default quella VERA, e non
// quella di `LOOM_DECK_PLATFORM` (`platform.ts`): qui si descrive il filesystem
// su cui il deck gira, non una funzione che si può spegnere.
import { posix, win32 } from 'node:path';

/**
 * La forma di un path su cui si confronta, mai quella che si mostra.
 *
 * Su win32: separatori portati a `\`, forma MSYS `/c/…` riportata a `C:\…`,
 * tutto minuscolo, nessun separatore in coda (tranne la radice del drive, dove
 * `C:` da solo vorrebbe dire «la cartella corrente di C:»). Altrove il path così
 * com'è, senza il separatore in coda: il confronto resta case-sensitive come il
 * filesystem.
 */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p.length > 1 ? p.replace(/\/+$/, '') : p;
  let s = p.replace(/\//g, '\\');
  // `\c\Users\…` (la forma MSYS dopo la sostituzione dei separatori) →
  // `c:\Users\…`. Un UNC (`\\server\…`) non matcha: il secondo carattere è `\`.
  const msys = /^\\([a-zA-Z])(?:\\|$)/.exec(s);
  if (msys) s = `${msys[1]}:\\${s.slice(msys[0].length)}`;
  s = s.replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  return s.toLowerCase();
}

/** `path` è la root stessa o sta sotto di lei. Mai un prefisso di nome: la root
 *  `C:\a\loom` non contiene `C:\a\loom-works`. */
export function isWithin(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = comparablePath(path, platform);
  const r = comparablePath(root, platform);
  if (p === r) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Il nome della cartella del progetto: l'ultimo segmento della root, con i
 *  separatori della piattaforma. Root senza segmenti (`/`, `C:\`) → la root. */
export function projectBaseName(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).basename(cwd) || cwd;
}

/**
 * Le cartelle di transcript del progetto, fra i nomi di `~/.claude/projects/`.
 *
 * Su Linux una sola, il nome esatto. Su win32 ogni nome che coincide ignorando
 * le maiuscole: la stessa root avviata da VS Code (`c:\…`) e da Windows
 * Terminal (`C:\…`) scrive in `c--…` e in `C--…`, e leggerne una sola perde le
 * conversazioni dell'altra.
 */
export function matchingDirNames(
  entries: readonly string[],
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return entries.filter((e) => e === name);
  const want = name.toLowerCase();
  return entries.filter((e) => e.toLowerCase() === want);
}

/**
 * T176 — la cartella in cui nasce la tab che riprende o forka una conversazione.
 *
 * Su Linux la root del progetto, come prima. Su win32 la cwd che la
 * conversazione ha registrato, in forma Windows (P7 preflight): `claude
 * --resume` cerca il transcript nella cartella che ricava dalla PROPRIA cwd, e
 * Claude Code non normalizza la lettera del drive (T174 verdetto 1) — una
 * conversazione nata da VS Code (`c:\…`) sta in `c--…`, e un `claude` partito in
 * `C:\…` la cercherebbe in `C--…`, senza trovarla.
 *
 * Una cwd in forma MSYS (`/c/…`) non dice la grafia del drive: la dice il nome
 * della cartella del transcript, che Claude Code ha derivato dalla cwd vera
 * (`c--…` o `C--…`). Una cwd che non è un path assoluto Windows ricade sulla
 * root.
 */
export function conversationCwd(
  sessionCwd: string,
  transcriptPath: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return root;
  if (/^[a-zA-Z]:[\\/]/.test(sessionCwd)) return sessionCwd.replace(/\//g, '\\');
  if (sessionCwd.startsWith('\\\\')) return sessionCwd;
  const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(sessionCwd);
  if (!msys) return root;
  const folder = win32.basename(win32.dirname(transcriptPath));
  const letter =
    folder.length > 2 && folder.slice(1, 3) === '--' && folder[0]!.toLowerCase() === msys[1]!.toLowerCase()
      ? folder[0]!
      : msys[1]!.toUpperCase();
  return `${letter}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`;
}
