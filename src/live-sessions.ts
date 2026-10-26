import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isWithin } from './project-path.js';

// ADAPTER ISOLATO sul registry dei processi Claude Code vivi (T62).
//
// Gemello di `sessions.ts`, che legge lo STORICO (`~/.claude/projects/…`, un
// transcript JSONL per conversazione, presente anche mesi dopo la chiusura).
// Qui si legge invece l'ADESSO: `~/.claude/sessions/<pid>.json`, un file per
// processo CLI in esecuzione, scritto e aggiornato dal CLI stesso. È la sola
// fonte locale che dica se una conversazione è aperta ora — l'SDK ufficiale
// (`listSessions`) elenca lo store su disco, dove questa informazione non c'è.
//
// Stessa natura dello store JSONL: schema INTERNO, nessuna documentazione
// ufficiale, può cambiare a un update (il file porta un campo `version`). Tutto
// l'accesso vive QUI — se lo schema rompe, si fixa questo solo file.
//
// PERCHÉ NON L'ARGV. `ps` mostra `--session-id`/`--resume`, ma è l'id ALLO
// SPAWN, congelato: un `/clear` (o una compattazione) apre un transcript nuovo
// DENTRO lo stesso processo, e gli spawn non pinnati (`claude --name …` nudo)
// in argv non portano nessun id. Il registry tiene invece l'id CORRENTE, ed è
// per questo l'unica chiave che si può joinare con la lista del deck.

/** Stato del processo, normalizzato a due valori: il registry scrive
 *  `idle`/`busy`, ma un terzo valore introdotto da una versione futura non deve
 *  poter significare «viva» senza che nessuno lo decida qui. */
export type LiveStatus = 'idle' | 'busy';

/**
 * T124 — rollup della liveness sulle N conversazioni di UNA task, per la riga
 * del pane task.
 *
 * `status` vince su `busy`: fra più vive a stato misto, quella che sta
 * lavorando è la ragione per cui si guarda la riga. Assente dalla mappa =
 * nessuna conversazione viva, che è diverso da `count: 0` — l'assenza è il
 * predicato unico da cui dipendono tutte e tre le evidenze della riga.
 */
export interface TaskLive {
  count: number;
  status: LiveStatus;
}

export interface LiveSession {
  sessionId: string;
  pid: number;
  status: LiveStatus;
  /** Label della tab (`🧵 loom-works · T62 «…»`). Il deck la mostra solo nel
   *  blocco preview: in lista sarebbe la colonna che `sessionTitle` già ripulisce. */
  name: string;
  cwd: string;
  /** Epoch ms dell'avvio del processo, `0` se il registro non lo scrive. T181 —
   *  ordina le conversazioni che entrano nell'insieme vivo nello stesso tick:
   *  le tab si aprono in quest'ordine, quindi è l'ordine che il restore ricalca. */
  startedAt: number;
}

/** La cartella del registry. `LOOM_DECK_LIVE_SESSIONS_ROOT` la sposta, per i
 *  test che costruiscono un registro finto invece di leggere quello vero. */
export function liveSessionsRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.LOOM_DECK_LIVE_SESSIONS_ROOT || join(homedir(), '.claude', 'sessions');
}

/**
 * Campo 22 (`starttime`) di `/proc/<pid>/stat`, o null se la riga non è
 * parsabile.
 *
 * Il taglio è sull'ULTIMA `)` e non su uno split ingenuo: il campo 2 (`comm`) è
 * il nome dell'eseguibile fra parentesi e può contenere spazi e parentesi a sua
 * volta, quindi tokenizzare da inizio riga sfasa tutti i campi successivi. Dopo
 * l'ultima `)` il primo token è il campo 3 → `starttime` è l'indice 19.
 */
export function procStartOf(statLine: string): string | null {
  const at = statLine.lastIndexOf(')');
  if (at < 0) return null;
  const fields = statLine.slice(at + 1).trim().split(/\s+/);
  return fields[19] ?? null;
}

/**
 * Il processo `pid` è ANCORA quello che ha scritto il file di registry?
 *
 * Il registry è keyed su pid, e i pid si riciclano: senza questo confronto un
 * pid riusato da un altro programma marcherebbe «aperta» una conversazione
 * morta, e un'entry stale lasciata da un `kill -9` (il CLI non fa in tempo a
 * ripulire) resterebbe viva per sempre. Il guard sta dentro il file stesso —
 * `procStart` è esattamente il campo 22 di `/proc/<pid>/stat`, verificato — e
 * quel campo è il tempo di avvio in tick dal boot: irripetibile per un pid
 * riciclato, che parte per definizione dopo.
 */
function isAlive(pid: number, procStart: string): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false; // processo finito → nessun /proc/<pid>
  }
  return procStartOf(stat) === procStart;
}

/**
 * Semantica di UNA entry del registry, separata dalla lettura del disco: qui
 * c'è solo cosa rende un record utilizzabile, ed è l'unica parte che vale la
 * pena testare (su una stringa, senza inventare un finto `~/.claude`).
 *
 * `pid` arriva dal NOME del file e non dal campo omonimo: è il nome che decide
 * quale `/proc/<pid>/stat` interrogare, e far divergere le due cose renderebbe
 * il guard verificabile su un processo diverso da quello controllato.
 */
export function parseLiveEntry(
  content: string,
  pid: number,
): { entry: LiveSession; procStart: string } | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(content);
  } catch {
    return null;
  }
  const sessionId = typeof d.sessionId === 'string' ? d.sessionId : '';
  const procStart = typeof d.procStart === 'string' ? d.procStart : '';
  const cwd = typeof d.cwd === 'string' ? d.cwd : '';
  // Senza uno dei tre l'entry non è utilizzabile: `sessionId` è la chiave del
  // join con la lista, `procStart` è il guard anti-pid-riciclato (assente →
  // non si può stabilire la liveness, e assumerla sarebbe il falso positivo che
  // il guard esiste per escludere), `cwd` è il filtro di progetto.
  if (!sessionId || !procStart || !cwd) return null;
  // Il registry tiene un file anche per i processi che NON sono una
  // conversazione dell'utente: subagent SDK, fork parkeggiati in background,
  // spare pty host. Hanno lo stesso `cwd` del progetto e un pid davvero vivo —
  // quindi `isAlive` non li scarta — ma nessuna tab a cui tornare: elencarli
  // conta più conversazioni di quante ne siano aperte, e `--resume` su una di
  // esse non riporta l'utente da nessuna parte.
  //
  // Servono DUE campi perché uno solo non discrimina: un job in background di
  // Claude Code scrive `entrypoint:"cli"` come una sessione vera e si distingue
  // solo per `kind:"bg"`. Entrambi assenti valgono come sessione interattiva —
  // una versione del CLI che non li scrivesse non deve svuotare la lista.
  if ((typeof d.entrypoint === 'string' ? d.entrypoint : 'cli') !== 'cli') return null;
  if ((typeof d.kind === 'string' ? d.kind : 'interactive') !== 'interactive') return null;
  return {
    entry: {
      sessionId,
      pid,
      status: d.status === 'busy' ? 'busy' : 'idle',
      name: typeof d.name === 'string' ? d.name : '',
      cwd,
      startedAt: typeof d.startedAt === 'number' ? d.startedAt : 0,
    },
    procStart,
  };
}

/**
 * Le entry VIVE del registry, nell'ordine di `readdir`.
 *
 * `keep` scarta un'entry PRIMA del controllo di liveness: chi filtra per
 * progetto risparmia così lo `stat` di `/proc` sui processi degli altri.
 */
function liveEntries(root: string, keep: (entry: LiveSession) => boolean = () => true): LiveSession[] {
  const out: LiveSession[] = [];
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // registry assente (CLI mai avviato, o versione che non lo scrive)
  }

  for (const f of files) {
    const pid = Number(basename(f, '.json'));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let content: string;
    try {
      content = readFileSync(join(root, f), 'utf8');
    } catch {
      continue; // il processo può finire fra readdir e read
    }
    const parsed = parseLiveEntry(content, pid);
    if (!parsed) continue;
    const { entry, procStart } = parsed;
    if (!keep(entry)) continue;
    if (!isAlive(pid, procStart)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Le sessioni VIVE del solo progetto corrente, indicizzate per `sessionId` —
 * la stessa chiave del sidecar `session-tasks.jsonl` e di `deck-run --resume`,
 * quindi il join con la riga di lista è diretto.
 *
 * Il filtro per `cwd` è d'EFFICIENZA, non di correttezza: risparmia lo `stat`
 * di `/proc` sui processi degli altri progetti (il registry è globale, non
 * per-progetto). Il match resta sul `sessionId`.
 *
 * Nessuna cache mtime-keyed come in `sessions.ts`: le entry sono poche e di
 * poche centinaia di byte, mentre `status` cambia a ogni turno — una cache qui
 * mostrerebbe `idle` su una sessione che sta lavorando, cioè il difetto che la
 * colonna esiste per non avere.
 */
export function discoverLiveSessions(projectRoot: string): Map<string, LiveSession> {
  const out = new Map<string, LiveSession>();
  // T175 — `isWithin` regge le grafie di Windows: il registry scrive `C:\…`,
  // e la root del deck può arrivare con la lettera del drive in un altro case.
  for (const entry of liveEntries(liveSessionsRoot(), (e) => isWithin(e.cwd, projectRoot))) {
    out.set(entry.sessionId, entry);
  }
  return out;
}

/**
 * Il nome CHIESTO in un argv di `claude` — il valore di `--name` o del suo alias
 * `-n`, staccato o con `=` — oppure `null` se l'argv non ne chiede uno.
 *
 * Non è il campo `name` del registry, ed è la ragione per cui serve: il registry
 * porta il nome EFFETTIVO, e quando il nome chiesto è già preso il CLI rinomina
 * la sessione (`🧵 loom-works` → `🧵 loom-works-cryptic-hopper`, con
 * `nameSource: "collision"`), mentre il titolo della tab resta il nome chiesto.
 *
 * GEMELLA di `procRequestedName` in `loom-compass/compass@lamemind/model.js`:
 * le due letture devono riconoscere le stesse quattro forme.
 */
export function requestedNameIn(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--name' || a === '-n') return argv[i + 1] ?? null;
    if (a.startsWith('--name=')) return a.slice('--name='.length);
    if (a.startsWith('-n=')) return a.slice('-n='.length);
  }
  return null;
}

/** Gli argomenti del processo: `/proc/<pid>/cmdline` li separa con NUL e ne
 *  mette uno anche in coda. Ogni argomento arriva intero, spazi compresi. */
function procArgv(pid: number): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return null; // processo finito fra la liveness e la lettura
  }
  const argv = raw.split('\0');
  if (argv.length && argv[argv.length - 1] === '') argv.pop();
  return argv;
}

/**
 * T182 — i nomi chiesti con `--name` dalle conversazioni vive di TUTTI i
 * progetti: l'ingresso di `twinTitle` (`src/twin-title.ts`).
 *
 * Nessun filtro per `cwd`, al contrario di `discoverLiveSessions`: chi cerca la
 * tab per titolo la cerca in tutte le finestre Ptyxis, quindi una conversazione
 * dello stesso progetto aperta da un worktree di lane (altro `cwd`, stesso
 * titolo) è un gemello a tutti gli effetti. Il titolo porta già la label del
 * progetto, e il confronto per uguaglianza intera non scambia un progetto con
 * un altro.
 *
 * Una viva senza `--name` non entra: il suo titolo di tab non è un nome
 * chiesto. Dove `/proc` non esiste nessuna entry risulta viva, e la lista
 * esce vuota: il lancio usa il nome base.
 */
export function liveRequestedNames(root: string = liveSessionsRoot()): string[] {
  const names: string[] = [];
  for (const entry of liveEntries(root)) {
    const argv = procArgv(entry.pid);
    const name = argv ? requestedNameIn(argv) : null;
    if (name !== null) names.push(name);
  }
  return names;
}

/** Signature del poll: cambia quando cambia l'insieme delle vive O lo stato di
 *  una di esse. Il `pid` ci sta dentro perché un `/clear` sposta lo stesso
 *  `sessionId` su un processo diverso senza toccare né insieme né stato. */
export function liveSig(live: Map<string, LiveSession>): string {
  return [...live.values()]
    .map((l) => `${l.sessionId}:${l.pid}:${l.status}`)
    .sort()
    .join(',');
}
