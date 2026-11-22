// T134 — i file inbox come dato del deck.
//
// La misura non la fa il deck: la fa `doc-metrics.sh --inbox`, che per ogni file
// invoca `inbox.sh parse` e ne riporta natura e marcatori. È il contrario della
// scelta fatta per le task archiviabili (`archivable.ts`), dove il criterio —
// una data meno un'altra — era abbastanza piccolo da replicarlo: qui si
// replicherebbe la grammatica intera del marker inbox, e una divergenza fra le
// due copie non si vedrebbe finché non conta i file sbagliati.
//
// Lettore puro + spawn: nessun React, nessuna resa. È l'unico modo di provarlo
// senza pseudo-terminale.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { pluginScript } from './plugin-cache.js';
import { sanitize } from './width.js';

const execFileAsync = promisify(execFile);

export const INBOX_METRICS_SCRIPT = 'scripts/docs/doc-metrics.sh';

/**
 * Ogni 30 minuti — cadenza propria, staccata dai 6h di `SCAN_INTERVAL_MS`.
 *
 * Gli altri tre scan periodici misurano dati che si muovono al ritmo del
 * calendario (l'età di una task) o di una riscrittura di massa (l'hard-wrap dei
 * `.md`). La cartella inbox si muove invece a ogni checkpoint: un file nuovo
 * appare quando una sessione trasloca le sue nozioni, un file cambia stato
 * quando la sua task si chiude, e con la cadenza a 6h il contatore resterebbe
 * fermo per l'intera mattina di lavoro che lo ha mosso.
 * Il costo di un giro resta uno spawn di `doc-metrics.sh` su una cartella di
 * pochi file, quindi trascurabile anche a questa frequenza.
 */
export const INBOX_SCAN_INTERVAL_MS = 30 * 60 * 1000;

/** Le tre nature del marker inbox, più il file che non si parsa. */
export const NATURE = ['nozioni', 'derivazione', 'sweep'] as const;
export type Natura = (typeof NATURE)[number];
export type InboxNatura = Natura | 'malformato';

export interface InboxFile {
  /** Path come lo emette `doc-metrics`, relativo alla project root. */
  path: string;
  basename: string;
  natura: InboxNatura;
  indexed: boolean;
  /** Token `drainable` sulla riga marker. */
  drainable: boolean;
  /** Nome del branch che congela il file; stringa vuota = nessuno. */
  branch: string;
  nozioni: number;
  aperte: number;
  chars: number;
  /** Epoch in SECONDI, come lo emette lo script. */
  created: number;
  /** Cappello dichiarato nel marker: task parent o task stessa; può mancare. */
  cappello: string;
}

/**
 * `si`/`no` è la grafia dello script. Qualunque altra cosa (colonna vuota su un
 * file malformato) è `false`: un marcatore che non si è potuto leggere non vale
 * come presente.
 */
function flag(cell: string): boolean {
  return cell === 'si';
}

function num(cell: string): number {
  const n = Number(cell);
  return Number.isFinite(n) ? n : 0;
}

function natura(cell: string): InboxNatura {
  return (NATURE as readonly string[]).includes(cell) ? (cell as Natura) : 'malformato';
}

/**
 * Il TSV di `doc-metrics.sh --inbox --format tsv`, riga di intestazione
 * compresa. Colonne, nell'ordine emesso dallo script:
 *
 *   PATH · NATURA · INDEXED · DRAINABLE · BRANCH · NOZIONI · APERTE · CHAR ·
 *   CREATED · AGE_DAYS · CAPPELLO
 *
 * `AGE_DAYS` si scarta di proposito: è troncato al giorno, e l'età che la riga
 * mostra la rende `relTime` da `CREATED`, al minuto.
 */
export function parseInboxTsv(stdout: string): InboxFile[] {
  const out: InboxFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c[0] === 'PATH' || c.length < 11) continue;
    out.push({
      path: c[0],
      basename: basename(c[0]),
      natura: natura(c[1]),
      indexed: flag(c[2]),
      drainable: flag(c[3]),
      branch: c[4] ?? '',
      nozioni: num(c[5]),
      aperte: num(c[6]),
      chars: num(c[7]),
      created: num(c[8]),
      cappello: c[10] ?? '',
    });
  }
  // Dal più vecchio in cima (D8). Lo script emette già in quest'ordine —
  // riordinare qui costa nulla e toglie di mezzo la dipendenza da una garanzia
  // scritta altrove.
  return out.sort((a, b) => a.created - b.created);
}

/**
 * Il file descrive un RILASCIO CHIUSO: `drainable` e nessun branch che lo
 * congeli. È il criterio dei contatori del bottone di testata e delle tre viste
 * per natura.
 *
 * `drainable` lo accende il checkpoint che chiude la task: da lì il file è
 * congelato e resta in `inbox/` come nozione di un lavoro finito. Senza il token
 * il file è in lavorazione e appartiene alla task che lo scrive; con `branch:` è
 * congelato finché `pull-repos` non trova il branch su main.
 */
export function isReleased(f: InboxFile): boolean {
  return f.drainable && !f.branch && f.natura !== 'malformato';
}

/**
 * Abbreviazione a larghezza fissa della natura, per la colonna della riga.
 *
 * CHIESTE e non derivate con uno `slice(0,3)`, come le short dei modelli:
 * `der` e `swp` non coincidono col troncamento (`der`/`swe`), e una regola che
 * sbaglia su due voci su quattro non è una regola.
 */
export const NATURA_SHORT: Record<InboxNatura, string> = {
  nozioni: 'noz',
  derivazione: 'der',
  sweep: 'swp',
  malformato: '???',
};

/** Larghezza COSTANTE della colonna natura: il dominio è chiuso e le short
 *  sono tutte larghe 3, quindi misurarla a ogni render calcolerebbe un numero
 *  già noto. */
export const NATURA_W = 3;

/**
 * Lo stato di un file inbox. Quattro casi, in ordine di precedenza — ognuno
 * esclude quelli sotto:
 *
 *  - `broken`   — nessuna natura leggibile: il marker va riparato a mano;
 *  - `branched` — `branch:<nome>`, congelato finché il branch non è su main: lo
 *                 sblocca `pull-repos`, non chi guarda il deck;
 *  - `wip`      — senza il token `drainable`: in lavorazione, appartiene alla
 *                 task che lo scrive;
 *  - `released` — `drainable`: il rilascio è chiuso e il file è congelato.
 */
export type InboxMark = 'broken' | 'branched' | 'wip' | 'released';

export function inboxMark(f: InboxFile): InboxMark {
  if (f.natura === 'malformato') return 'broken';
  if (f.branch) return 'branched';
  if (!f.drainable) return 'wip';
  return 'released';
}

/** Lo stato a parole, per la testata del detail: il glifo della lista dice
 *  QUALE stato, la parola lo nomina. */
export const INBOX_MARK_LABEL: Record<InboxMark, string> = {
  broken: 'marker illeggibile',
  branched: 'congelato su branch',
  wip: 'in lavorazione',
  released: 'rilascio chiuso',
};

export type NaturaCounts = Record<Natura, number>;

/**
 * Un contatore per natura, sui soli file a rilascio chiuso. Un `malformato` non
 * ha natura e non entra in nessuno dei tre — ma resta in lista, perché
 * nasconderlo produrrebbe un contatore che mente al ribasso proprio quando
 * qualcosa si è rotto.
 */
export function countByNatura(files: readonly InboxFile[]): NaturaCounts {
  const counts: NaturaCounts = { nozioni: 0, derivazione: 0, sweep: 0 };
  for (const f of files) if (isReleased(f)) counts[f.natura as Natura]++;
  return counts;
}

/**
 * Il testo del file inbox, per il detail fullscreen. `null` = illeggibile, e il
 * detail lo dice.
 *
 * `sanitize` AL CONFINE DI CARICAMENTO, come `loadTaskFileText` e il gemello
 * `loadDocText`: la catena dichiarata in `markdown.ts` è `sanitize →
 * parseMarkdown → wrapWithOffsets`, e la prima non conserva la lunghezza —
 * applicarla più a valle sposterebbe gli offset degli span appena calcolati. Un
 * file di nozioni è testo libero e porta glifi su cui Ink e il terminale
 * divergono: senza la sanificazione il wrap conta una colonna in meno di quante
 * Ink ne disegna, e la riga esce dal box mangiandone il bordo.
 */
export function loadInboxText(projectRoot: string, relPath: string): string | null {
  try {
    return sanitize(readFileSync(join(projectRoot, relPath), 'utf8'));
  } catch {
    return null;
  }
}

export interface InboxScan {
  files: InboxFile[];
  ok: boolean;
}

/**
 * Invoca la misura e ne parsa l'output.
 *
 * I modi di non avere il dato — plugin non installato su questa macchina,
 * script che esce male — collassano in un solo `ok: false` (D2): chi vede
 * l'allerta chiede a Claude di indagare, e distinguerli a schermo non
 * cambierebbe la prima mossa. Nessuno dei due è un throw: un contatore
 * informativo non può rompere il deck.
 */
export async function scanInbox(projectRoot: string, docsRoot: string): Promise<InboxScan> {
  const script = pluginScript(INBOX_METRICS_SCRIPT);
  if (!script) return { files: [], ok: false };
  try {
    const { stdout } = await execFileAsync(
      script,
      ['--docs-root', docsRoot, '--inbox', '--format', 'tsv'],
      { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return { files: parseInboxTsv(stdout), ok: true };
  } catch {
    return { files: [], ok: false };
  }
}
