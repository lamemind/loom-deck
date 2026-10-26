// T175 — i confronti di path che il deck fa sulla root del progetto, per
// piattaforma.
//
// Tre punti confrontavano path come stringhe POSIX: il filtro delle
// conversazioni del progetto (`sessions.ts`), quello delle sessioni vive
// (`live-sessions.ts`) e il nome del progetto (`deck-model.ts`). Su Linux la
// stringa È il path; su Windows no, per tre ragioni misurate (verdetto 1 di T174):
//
//  - NTFS non distingue le maiuscole, e Claude Code non normalizza la grafia
//    della cwd: VS Code passa `c:\…`, Windows Terminal `C:\…`. La cartella di
//    transcript del progetto è una sola, ma il suo nome porta la grafia di chi
//    l'ha creata (`c--…` o `C--…`);
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
 * le maiuscole: per NTFS `c--…` e `C--…` sono la stessa cartella, ma `readdir`
 * ne restituisce il nome con la grafia di chi l'ha creata — `c--…` se la prima
 * conversazione è nata da VS Code (`c:\…`) — mentre il nome cercato il deck lo
 * ricava dalla propria root, che può avere l'altra grafia. Un confronto esatto
 * non troverebbe la cartella.
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
 * Su Linux la root del progetto, come prima. Su win32 la cwd di avvio che la
 * conversazione ha registrato, in forma Windows e con la grafia del drive
 * d'origine (P7 preflight). La ragione non è trovare il transcript: per NTFS
 * `c--…` e `C--…` sono la stessa cartella, e `claude --resume` lo trova da tutte
 * e due le grafie (misurato in T176 con Claude Code 2.1.310, anche con
 * `--fork-session`). La ragione è la fiducia della cartella: Claude Code la
 * tiene in `~/.claude.json` per grafia esatta del path (`c:/…` e `C:/…` sono due
 * voci), e una sessione interattiva in una grafia mai approvata si ferma sulla
 * domanda di fiducia prima di caricare la conversazione. Una conversazione nata
 * interattiva ha già la fiducia nella grafia in cui è nata.
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
