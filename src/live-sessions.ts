import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isWithin } from './project-path.js';
import { createWindowsLiveness, type Liveness, type WindowsLiveness } from './windows-liveness.js';

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
  /** T206 — quante delle `count` sono tab; le altre sono turni headless in
   *  corso. A zero tab la riga porta il glifo headless, altrimenti vince la
   *  tab: una tab è un posto dove tornare, ed è la cosa più utile da dire. */
  tabs: number;
}

export interface LiveSession {
  sessionId: string;
  pid: number;
  status: LiveStatus;
  /** T204 — lo `status` del registro così com'è scritto (`idle`, `busy`,
   *  `waiting`, `shell`, …), stringa vuota se assente. `status` lo appiattisce a
   *  due valori, e una guardia «chiudi solo una conversazione ferma» costruita
   *  su `status` tratterebbe come ferma una conversazione che esegue un comando
   *  (`shell`). Chi decide su questo valore lo confronta con una lista di valori
   *  ammessi, mai di valori esclusi: uno nuovo resta fuori finché qualcuno non
   *  lo ammette. */
  state: string;
  /** L'ora di avvio che il registro scrive (`procStart`): la guardia contro il
   *  pid riciclato. T204 — la chiusura la rimisura mentre aspetta la fine del
   *  processo. */
  procStart: string;
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
 * T204 — la riga di `/proc/<pid>/stat` dice che il processo è ancora quello
 * avviato a `procStart` E che non ha finito.
 *
 * Fra l'uscita di un processo e il momento in cui il padre lo raccoglie, la
 * riga esiste ancora con lo stesso `starttime` e lo stato `Z` (zombie): per chi
 * aspetta la fine di una conversazione chiusa da fuori quel processo è finito,
 * mentre la guardia del registro (`isAlive`) lo vede ancora vivo. Lo stato è il
 * campo 3, il primo token dopo l'ultima `)`.
 */
export function statRunning(statLine: string, procStart: string): boolean {
  if (procStartOf(statLine) !== procStart) return false;
  const state = statLine.slice(statLine.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
  return state !== 'Z' && state !== 'X';
}

/** `statRunning` sul processo vero; un processo senza `/proc/<pid>` è finito. */
export function procRunning(pid: number, procStart: string): boolean {
  try {
    return statRunning(readFileSync(`/proc/${pid}/stat`, 'utf8'), procStart);
  } catch {
    return false;
  }
}

/** La liveness via `/proc`: una lettura per pid, nessuno stato fra un giro e
 *  l'altro. */
const procLiveness: Liveness = (pairs) => pairs.map((p) => isAlive(p.pid, p.procStart));

let windowsLiveness: WindowsLiveness | null = null;

/**
 * T177 — la liveness della piattaforma VERA, non di quella delle funzioni
 * (`platform.ts`): `/proc` c'è o non c'è a seconda del sistema su cui il deck
 * gira, e `LOOM_DECK_PLATFORM` non lo fa comparire.
 *
 * Su Windows il verificatore è uno per processo, creato al primo uso: i suoi
 * verdetti valgono da un giro del poll all'altro, ed è quello che evita una
 * query di PowerShell a ogni giro (`windows-liveness.ts`).
 */
function platformLiveness(): Liveness {
  if (process.platform !== 'win32') return procLiveness;
  windowsLiveness ??= createWindowsLiveness();
  return windowsLiveness.check;
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
  const r = parseRegistryEntry(content, pid);
  if (!r) return null;
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
  // T206 — un turno `claude -p` (`sdk-cli`) resta fuori da qui: ha la sua
  // classe (`processClass`) e la sua mappa (`discoverProjectProcesses`).
  if (processClass(r) !== 'tab') return null;
  return { entry: r.entry, procStart: r.procStart };
}

/** Una entry del registry con i due campi che dicono CHE COSA è il processo. */
export interface RegistryEntry {
  entry: LiveSession;
  procStart: string;
  /** `cli` una tab, `sdk-cli` un `claude -p` (T205); `cli` se assente. */
  entrypoint: string;
  /** `interactive`, o `bg` un job in background; `interactive` se assente. */
  kind: string;
}

/**
 * T205 — una entry del registry SENZA il filtro di `parseLiveEntry`: tab,
 * headless, job in background. Serve a chi chiede se una conversazione ha un
 * processo qualunque — una risposta headless non parte mentre la conversazione
 * è aperta in una tab, né mentre un altro turno headless è in corso.
 */
export function parseRegistryEntry(content: string, pid: number): RegistryEntry | null {
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
  return {
    entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : 'cli',
    kind: typeof d.kind === 'string' ? d.kind : 'interactive',
    entry: {
      sessionId,
      pid,
      status: d.status === 'busy' ? 'busy' : 'idle',
      state: typeof d.status === 'string' ? d.status : '',
      procStart,
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
 * progetto risparmia così lo `stat` di `/proc` sui processi degli altri, e su
 * Windows la loro ora di avvio nella query.
 *
 * La liveness gira una volta sola, su tutte le entry tenute: su Windows le
 * coppie da verificare finiscono in una query sola (`windows-liveness.ts`).
 */
function liveEntries<T extends { entry: LiveSession; procStart: string }>(
  root: string,
  keep: (entry: LiveSession) => boolean = () => true,
  liveness: Liveness = platformLiveness(),
  parse: (content: string, pid: number) => T | null = parseLiveEntry as unknown as (c: string, p: number) => T | null,
): T[] {
  const kept: T[] = [];
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // registry assente (CLI mai avviato, o versione che non lo scrive)
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
    const parsed = parse(content, pid);
    if (!parsed || !keep(parsed.entry)) continue;
    kept.push(parsed);
  }
  const alive = liveness(kept.map(({ entry, procStart }) => ({ pid: entry.pid, procStart })));
  return kept.filter((_, i) => alive[i]);
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
  for (const { entry } of liveEntries(liveSessionsRoot(), (e) => isWithin(e.cwd, projectRoot))) {
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
 * chiesto. Dove `/proc` non esiste l'argv non si legge, e la lista esce vuota:
 * il lancio usa il nome base.
 */
export function liveRequestedNames(root: string = liveSessionsRoot()): string[] {
  const names: string[] = [];
  for (const { entry } of liveEntries(root)) {
    const argv = procArgv(entry.pid);
    const name = argv ? requestedNameIn(argv) : null;
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * T206 — che cosa è il processo di un'entry del registry, per il deck.
 *
 * `tab` — una conversazione in una tab (`cli` + `interactive`): la viva di
 * sempre, quella a cui il `⏎` porta davanti la tab.
 *
 * `headless` — un turno `claude -p` in corso (`sdk-cli` + `interactive`, T205):
 * un processo scrive sul transcript, ma non c'è nessuna tab a cui tornare.
 *
 * `null` — tutto il resto, job in background (`cli` + `bg`) compresi. Le due
 * classi si riconoscono IN POSITIVO, campo per campo: allargare il filtro delle
 * tab farebbe entrare anche i job in background, che scrivono `entrypoint:"cli"`
 * come una tab vera.
 */
export function processClass(r: Pick<RegistryEntry, 'entrypoint' | 'kind'>): 'tab' | 'headless' | null {
  if (r.kind !== 'interactive') return null;
  if (r.entrypoint === 'cli') return 'tab';
  if (r.entrypoint === 'sdk-cli') return 'headless';
  return null;
}

/** T206 — i processi vivi del progetto, divisi per classe. Due mappe e non un
 *  campo in più su `LiveSession`: tutto ciò che legge `live` (focus, restore,
 *  close dell'endpoint, marca nel sidecar) resta fermo sulle sole tab senza
 *  doverlo sapere, e una headless non può finire per errore in uno di quei rami. */
export interface ProjectProcesses {
  live: Map<string, LiveSession>;
  headless: Map<string, LiveSession>;
}

/**
 * T206 — le tab vive E i turni headless in corso del progetto corrente, in una
 * lettura sola del registry.
 *
 * Una conversazione che comparisse in tutte e due — una tab aperta mentre un
 * turno headless gira, cosa che `loom-deck-headless` rifiuta ma un `claude -p`
 * lanciato a mano no — sta solo fra le vive: c'è una tab a cui tornare, e la
 * tab è ciò che il `⏎` sa fare.
 */
export function discoverProjectProcesses(
  projectRoot: string,
  root: string = liveSessionsRoot(),
  liveness: Liveness = platformLiveness(),
): ProjectProcesses {
  const live = new Map<string, LiveSession>();
  const headless = new Map<string, LiveSession>();
  const kept = liveEntries(
    root,
    (e) => isWithin(e.cwd, projectRoot),
    liveness,
    (content, pid) => {
      const r = parseRegistryEntry(content, pid);
      return r && processClass(r) ? r : null;
    },
  );
  for (const r of kept) {
    if (processClass(r) === 'tab') live.set(r.entry.sessionId, r.entry);
  }
  for (const r of kept) {
    if (processClass(r) === 'headless' && !live.has(r.entry.sessionId)) headless.set(r.entry.sessionId, r.entry);
  }
  return { live, headless };
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

/** T205 — un processo vivo di una conversazione, con la sua forma. */
export interface SessionProcess {
  pid: number;
  entrypoint: string;
  kind: string;
  /** Lo `status` del registro com'è scritto (`busy`, `idle`, …). */
  state: string;
}

/**
 * T205 — i processi VIVI di una conversazione, di qualunque forma: una tab
 * (`cli`), un turno headless (`sdk-cli`), un job in background (`bg`).
 *
 * Nessun filtro per progetto né per forma: chi chiede vuole sapere se un
 * `--resume` su quel `sessionId` scriverebbe accanto a un altro processo, e
 * due scrittori sullo stesso transcript non devono esistere. Un processo `idle`
 * conta: un turno headless scrive `idle` negli ultimi istanti prima di uscire.
 */
export function sessionProcesses(
  sessionId: string,
  root: string = liveSessionsRoot(),
  liveness: Liveness = platformLiveness(),
): SessionProcess[] {
  return liveEntries(root, (e) => e.sessionId === sessionId, liveness, parseRegistryEntry).map((r) => ({
    pid: r.entry.pid,
    entrypoint: r.entrypoint,
    kind: r.kind,
    state: r.entry.state,
  }));
}
