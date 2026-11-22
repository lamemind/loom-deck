// T160 — l'albero della doc come dato del deck.
//
// Gemello di `src/inbox.ts` per forma e per ragione: la misura non la fa il
// deck, la fa `doc-metrics.sh` nel suo modo principale. Il deck ne legge le
// colonne e i flag, e non ne ricalcola nessuno: due calcoli dello stesso dato
// divergerebbero in silenzio.
//
// Lettore puro + spawn: nessun React, nessuna resa. È l'unico modo di provarlo
// senza pseudo-terminale.
//
// COSTO. Questa misura non è quella degli inbox, benché lo script sia lo
// stesso: `--inbox` apre una cartella di poche decine di file e costa
// millisecondi, il modo principale apre ogni `.md` sotto la docs-root, ne conta
// i caratteri e aggrega per cartella — secondi di wall clock su un cappello come
// loom-works. Da qui la cadenza propria e il divieto di entrare nel poll da
// 1,5 s (T153).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pluginScript } from './plugin-cache.js';
import { sanitize } from './width.js';

const execFileAsync = promisify(execFile);

export const DOC_METRICS_SCRIPT = 'scripts/docs/doc-metrics.sh';

/**
 * Ogni 30 minuti, e SOLO mentre il modo doc è montato (P3 preflight).
 *
 * La cifra coincide con quella dello scan inbox ma la ragione è opposta. Lì
 * l'intervallo è stretto perché il dato si muove a ogni checkpoint e costa
 * niente misurarlo; qui è largo perché l'albero della doc cambia di rado e ogni
 * giro costa secondi di CPU. Sono due numeri uguali per caso: se uno dei due
 * cambia, l'altro non lo segue.
 *
 * Il gate vero non è l'intervallo ma l'interruttore: il timer è acceso solo
 * finché qualcuno guarda l'albero. Un periodico che girasse in modo task
 * pagherebbe quei secondi per nessuno.
 */
export const DOC_SCAN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * I flag che `doc-metrics.sh` emette. Tre, tutti DESCRITTIVI: `ONLINE` (file
 * @-importato da `CLAUDE.md`), `INBOX` (file della cartella inbox), `GEN`
 * (l'indice generato). Nessuno invita a un'operazione, quindi il pane non ha
 * viste per flag né righe colorate: la colonna dice cos'è un file, non cosa
 * farne.
 *
 * I nomi sono quelli dello script, LETTERALI: un rename qui li staccherebbe
 * dalla misura senza che niente lo dica, e il pane mostrerebbe una colonna vuota
 * su file che un flag ce l'hanno. Lo stesso accade, per costruzione, davanti a
 * un plugin di versione diversa che emette un flag che il deck non conosce:
 * `parseFlags` lo scarta, e la colonna resta vuota su quel file senza errori.
 */
export const DOC_FLAGS = ['ONLINE', 'INBOX', 'GEN'] as const;

export type DocFlag = (typeof DOC_FLAGS)[number];

const FLAG_SET = new Set<string>(DOC_FLAGS);

/**
 * L'ordine in cui i flag entrano nella colonna di riga e nella preview.
 *
 * `DOC_FLAGS` resta l'ordine dello script e questo è quello di lettura: tenerli
 * separati costa una costante e toglie di mezzo la tentazione di riordinare
 * l'elenco che deve combaciare con la misura.
 */
const FLAG_ORDER: readonly DocFlag[] = ['ONLINE', 'INBOX', 'GEN'];

/**
 * Le short a tre lettere della colonna di riga.
 *
 * CHIESTE e non derivate con uno `slice(0,3)`, come le short dei modelli e
 * quelle delle nature inbox: una regola di troncamento collide al primo flag
 * che condivida le iniziali con un altro. I nomi interi stanno nel blocco
 * preview.
 */
export const DOC_FLAG_SHORT: Record<DocFlag, string> = {
  ONLINE: 'ONL',
  INBOX: 'INB',
  GEN: 'GEN',
};

/** Quante short entrano nella colonna. Un flag oltre il terzo diventerebbe il
 *  `+` in coda alla cella: la cella resta a larghezza fissa, e su un pane largo
 *  la metà del terminale ogni colonna in più la paga la cella del nome, che è
 *  l'unica con cui si riconosce un file. */
const FLAG_SLOTS = 3;

/** Larghezza COSTANTE della colonna: tre short da 3, due separatori, una cella
 *  per il `+` dell'overflow. Il dominio è chiuso e le short sono tutte larghe 3,
 *  quindi misurarla a ogni render calcolerebbe un numero già noto. */
export const DOC_FLAG_W = FLAG_SLOTS * 3 + (FLAG_SLOTS - 1) + 1;

/**
 * La cella dei flag di una riga, già a larghezza `DOC_FLAG_W`.
 *
 * Tutto ASCII per costruzione (le short sono lettere maiuscole, il riempimento
 * spazi), quindi `padEnd` conta esattamente le colonne disegnate e non serve la
 * contabilità di `width.ts` — che esiste per i glifi su cui le due misure
 * divergono, e qui non ce n'è nessuno.
 */
export function flagCell(flags: readonly DocFlag[]): string {
  const ordered = FLAG_ORDER.filter((f) => flags.includes(f));
  const shown = ordered.slice(0, FLAG_SLOTS).map((f) => DOC_FLAG_SHORT[f]);
  const more = ordered.length > FLAG_SLOTS ? '+' : '';
  return (shown.join(' ').padEnd(FLAG_SLOTS * 3 + (FLAG_SLOTS - 1)) + more).padEnd(DOC_FLAG_W);
}

/** I nomi interi, nell'ordine di lettura: è ciò che il blocco preview mostra al
 *  posto delle short. Vuoto → nessun flag, e chi lo rende lo dice a parole. */
export function flagNames(flags: readonly DocFlag[]): string[] {
  return FLAG_ORDER.filter((f) => flags.includes(f));
}

export interface DocFile {
  /** Path come lo emette `doc-metrics`, relativo alla project root. */
  path: string;
  chars: number;
  /** Lunghezza in caratteri del TLDR di riga 3; `0` = assente. */
  tldr: number;
  flags: DocFlag[];
}

export interface DocDir {
  /** Path della cartella, relativo alla project root. */
  path: string;
  /** Quanti `.md` la cartella aggrega (i suoi diretti, non l'albero sotto). */
  files: number;
  chars: number;
  flags: DocFlag[];
}

export interface DocScanData {
  files: DocFile[];
  dirs: DocDir[];
  /**
   * La seconda tabella c'era.
   *
   * Il deck esegue lo script dalla cache installata del plugin, quindi può
   * incontrare una versione che emette la sola tabella dei file: in quel caso
   * l'albero si costruisce lo stesso — le cartelle si deducono dai path — e resta
   * senza i flag di cartella. L'header lo dice invece di far sembrare che nessuna
   * cartella sia da riorganizzare.
   */
  hasDirs: boolean;
}

/** Colonna FLAGS → i flag noti. `-` è il vuoto dello script; un token che il
 *  deck non conosce si scarta invece di finire in colonna, perché la sua short
 *  non esisterebbe e la cella uscirebbe di larghezza. */
function parseFlags(cell: string | undefined): DocFlag[] {
  if (!cell || cell === '-') return [];
  return cell.split(' ').filter((t): t is DocFlag => FLAG_SET.has(t));
}

function num(cell: string | undefined): number {
  const n = Number(cell);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Le DUE tabelle del modo principale, dallo stesso stream.
 *
 *   PATH · CHAR · TLDR · FLAGS        (i file, char decrescente)
 *   <riga vuota>
 *   DIR · FILES · CHAR · FLAGS        (le cartelle, char decrescente)
 *
 * Il discriminante è l'header, non la posizione: un parser che contasse le righe
 * si romperebbe al primo `# soglie:` in testa (che compare sotto override) o a
 * una riga vuota in più. Le righe fuori da una tabella aperta si ignorano.
 */
export function parseDocTsv(stdout: string): DocScanData {
  const files: DocFile[] = [];
  const dirs: DocDir[] = [];
  let hasDirs = false;
  let table: 'none' | 'files' | 'dirs' = 'none';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c[0] === 'PATH') {
      table = 'files';
      continue;
    }
    if (c[0] === 'DIR') {
      table = 'dirs';
      hasDirs = true;
      continue;
    }
    if (table === 'files' && c.length >= 4) {
      files.push({ path: c[0]!, chars: num(c[1]), tldr: num(c[2]), flags: parseFlags(c[3]) });
    } else if (table === 'dirs' && c.length >= 4) {
      dirs.push({ path: c[0]!, files: num(c[1]), chars: num(c[2]), flags: parseFlags(c[3]) });
    }
  }
  return { files, dirs, hasDirs };
}

/**
 * Una riga del pane doc, cartella o file.
 *
 * Un tipo solo e non un'unione discriminata sul rendering: le due nature
 * condividono ogni colonna a schermo (caret, flag, nome, char) e differiscono
 * per la sola cella che il pane NON mostra — il TLDR di un file, il conteggio
 * file di una cartella, entrambi nel blocco preview. Un'unione obbligherebbe
 * ogni consumatore a un ramo per una differenza che nella riga non si vede.
 */
export interface DocRow {
  kind: 'dir' | 'file';
  /** Chiave della selezione e file che il detail apre: il path come lo emette
   *  lo script, mai il nome mostrato. */
  path: string;
  /** Il testo della cella nome: l'ultimo segmento del path. */
  name: string;
  /** Rientro nell'albero. */
  depth: number;
  chars: number;
  /** File: lunghezza del TLDR. Cartella: `0`. */
  tldr: number;
  /** Cartella: quanti `.md` aggrega. File: `0`. */
  files: number;
  flags: DocFlag[];
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '' : path.slice(0, at);
}

function lastSegment(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

interface Tree {
  /** Ogni cartella dell'albero, intermedie comprese. */
  dirs: Map<string, DocDir>;
  /** Cartella → sue sottocartelle dirette, ordinate. */
  subdirs: Map<string, string[]>;
  /** Cartella → suoi file diretti, ordinati. */
  files: Map<string, DocFile[]>;
  /** Le cartelle senza un padre nell'albero: normalmente una sola, la docs-root. */
  roots: string[];
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const at = m.get(k);
  if (at) at.push(v);
  else m.set(k, [v]);
}

/**
 * L'albero, dalle due tabelle.
 *
 * Due sorgenti di cartelle, ed è deliberato: quelle della tabella (col loro
 * conteggio e il loro flag) più quelle DEDOTTE dai path — una cartella
 * intermedia che non contiene `.md` propri non compare nella misura, perché lo
 * script aggrega per `dirname` dei file, ma l'albero la deve attraversare o le
 * sue figlie resterebbero irraggiungibili. Una dedotta nasce a zero file, zero
 * char e nessun flag: è una riga di struttura, non una misura mancante.
 */
function assemble(data: DocScanData): Tree {
  const dirs = new Map<string, DocDir>();
  for (const d of data.dirs) dirs.set(d.path, d);

  const files = new Map<string, DocFile[]>();
  for (const f of data.files) push(files, parentOf(f.path), f);

  // Chiusura verso l'alto: ogni antenato di una cartella nota è una cartella.
  for (const p of [...dirs.keys(), ...files.keys()]) {
    let cur = p;
    while (cur) {
      if (!dirs.has(cur)) dirs.set(cur, { path: cur, files: 0, chars: 0, flags: [] });
      cur = parentOf(cur);
    }
  }

  const subdirs = new Map<string, string[]>();
  const roots: string[] = [];
  for (const p of dirs.keys()) {
    const parent = parentOf(p);
    if (parent && dirs.has(parent)) push(subdirs, parent, p);
    else roots.push(p);
  }

  const byName = (a: string, b: string) => (lastSegment(a) < lastSegment(b) ? -1 : 1);
  for (const list of subdirs.values()) list.sort(byName);
  for (const list of files.values()) list.sort((a, b) => (a.path < b.path ? -1 : 1));
  roots.sort(byName);

  return { dirs, subdirs, files, roots };
}

/**
 * Le righe dell'albero, in pre-ordine: una cartella, poi le sue sottocartelle,
 * poi i suoi file.
 *
 * Cartelle PRIMA dei file a ogni livello, ed è l'ordine dei file manager, non
 * una preferenza: un elenco misto alfabetico spezza i rami: una sottocartella
 * finisce fra due file e chi scorre non vede più dove comincia il livello sotto.
 *
 * Nessun espandi/comprimi (P7): l'albero scorre a finestra come le altre liste.
 */
export function buildDocTree(data: DocScanData): DocRow[] {
  const tree = assemble(data);
  const out: DocRow[] = [];

  const walk = (dirPath: string, depth: number) => {
    const d = tree.dirs.get(dirPath)!;
    out.push({
      kind: 'dir',
      path: dirPath,
      name: lastSegment(dirPath),
      depth,
      chars: d.chars,
      tldr: 0,
      files: d.files,
      flags: d.flags,
    });
    for (const sub of tree.subdirs.get(dirPath) ?? []) walk(sub, depth + 1);
    for (const f of tree.files.get(dirPath) ?? []) {
      out.push({
        kind: 'file',
        path: f.path,
        name: lastSegment(f.path),
        depth: depth + 1,
        chars: f.chars,
        tldr: f.tldr,
        files: 0,
        flags: f.flags,
      });
    }
  };

  for (const root of tree.roots) walk(root, 0);
  return out;
}

/**
 * Il testo di un file doc, per il detail fullscreen. `null` = illeggibile, e il
 * detail lo dice.
 *
 * `sanitize` AL CONFINE DI CARICAMENTO, come `loadTaskFileText`: la catena
 * dichiarata in `markdown.ts` è `sanitize → parseMarkdown → wrapWithOffsets`, e
 * la prima non conserva la lunghezza (timbra col VS16 i BMP larghi 2, sostituisce
 * i discordi) — applicarla più a valle sposterebbe gli offset degli span appena
 * calcolati. Qui non è una precauzione teorica: un `.md` della doc porta glifi
 * che Ink e il terminale misurano diversamente (`↔` in una testata, `⚡`/`✔️` in
 * una tabella), e senza la sanificazione il wrap conta una colonna in meno di
 * quante Ink ne disegna — la riga esce dal box e ne mangia il bordo.
 */
export function loadDocText(projectRoot: string, relPath: string): string | null {
  try {
    return sanitize(readFileSync(join(projectRoot, relPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * P10 — `⏎` su una CARTELLA apre lo stesso sheet, con l'elenco dei suoi file al
 * posto del testo.
 *
 * Il gesto è identico su file e cartella, quindi anche la schermata deve
 * esserlo: cambia cosa si legge nel corpo, non cosa si preme. Per un file è il
 * suo testo, per una cartella l'elenco dei suoi file diretti — quanti, quanto
 * pesano, quali portano un flag. Senza, `⏎` su una cartella aprirebbe un corpo
 * vuoto.
 *
 * Markdown perché lo sheet lo rende (`parseMarkdown`): il titolo diventa un
 * heading e i backtick una cella di codice, senza che questa funzione sappia
 * niente della resa.
 */
export function dirListing(data: DocScanData, dirPath: string): string {
  const dir = data.dirs.find((d) => d.path === dirPath);
  const own = data.files
    .filter((f) => parentOf(f.path) === dirPath)
    .sort((a, b) => b.chars - a.chars);
  const head = [
    `# ${dirPath}`,
    '',
    `${dir?.files ?? own.length} file · ${dir?.chars ?? 0} char${
      dir && dir.flags.length > 0 ? ` · ${flagNames(dir.flags).join(' · ')}` : ''
    }`,
    '',
  ];
  if (own.length === 0) {
    return [...head, 'Nessun file direttamente in questa cartella: il peso viene dalle sottocartelle.'].join('\n');
  }
  const rows = own.map((f) => {
    const flags = f.flags.length > 0 ? ` — ${flagNames(f.flags).join(' · ')}` : '';
    return `- \`${lastSegment(f.path)}\` · ${f.chars} char · TLDR ${f.tldr || 'assente'}${flags}`;
  });
  return [...head, ...rows].join('\n');
}

export interface DocScan extends DocScanData {
  ok: boolean;
}

/**
 * Invoca la misura e ne parsa l'output.
 *
 * I modi di non avere il dato — plugin non installato su questa macchina, script
 * che esce male, timeout — collassano in un solo `ok: false`, come per lo scan
 * degli inbox: chi vede l'allerta chiede a Claude di indagare, e distinguerli a
 * schermo non cambierebbe la prima mossa. Nessuno dei due è un throw: un pane
 * informativo non può rompere il deck.
 *
 * `maxBuffer` largo il doppio di quello dello scan inbox: qui l'output è una
 * riga per `.md` del progetto più una per cartella, non una quindicina di righe.
 */
export async function scanDocTree(projectRoot: string, docsRoot: string): Promise<DocScan> {
  const script = pluginScript(DOC_METRICS_SCRIPT);
  if (!script) return { files: [], dirs: [], hasDirs: false, ok: false };
  try {
    const { stdout } = await execFileAsync(
      script,
      ['--docs-root', docsRoot, '--format', 'tsv'],
      { cwd: projectRoot, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    return { ...parseDocTsv(stdout), ok: true };
  } catch {
    return { files: [], dirs: [], hasDirs: false, ok: false };
  }
}
