// T134 — la coda inbox come dato del deck.
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
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { pluginScript } from './plugin-cache.js';

const execFileAsync = promisify(execFile);

export const INBOX_METRICS_SCRIPT = 'scripts/docs/doc-metrics.sh';

/** Le tre nature che una skill sa consumare, più il file che non si parsa. */
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
 * `AGE_DAYS` si scarta di proposito: è troncato al giorno, e la soglia della
 * sirena è in ORE — con i giorni interi 47 e 49 ore sarebbero lo stesso numero.
 * L'età la ricalcola `ageHours` da `CREATED`.
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
  // Dal più vecchio in cima (D8): i più vecchi sono i più urgenti. Lo script
  // emette già in quest'ordine — riordinare qui costa nulla e toglie di mezzo
  // la dipendenza da una garanzia scritta altrove.
  return out.sort((a, b) => a.created - b.created);
}

/** Ore intere trascorse da `created` (epoch in secondi). */
export function ageHours(created: number, now: number): number {
  return Math.floor((now - created * 1000) / 3_600_000);
}

/**
 * Il file promette lavoro che una skill può prendere DA SOLA, senza che nessuno
 * lo nomini: `drainable` e nessun branch che lo congeli.
 *
 * Non è un criterio di ammissibilità dell'azione, ed è la distinzione che tiene
 * in piedi D5: le tre skill dichiarano tutte che un file NOMINATO si esegue
 * anche senza `drainable` — nominarlo è già la decisione che il token
 * dichiarerebbe. Replicare qui quel criterio come guardia impedirebbe ciò che
 * l'utente ha appena chiesto. Serve solo a decidere cosa entra nei contatori.
 */
export function isQueued(f: InboxFile): boolean {
  return f.drainable && !f.branch && f.natura !== 'malformato';
}

export type NaturaCounts = Record<Natura, number>;

/**
 * Un contatore per natura, sui soli file in coda. Un `malformato` non ha natura
 * e non entra in nessuno dei tre — ma resta in lista, perché nasconderlo
 * produrrebbe un contatore che mente al ribasso proprio quando qualcosa si è
 * rotto.
 */
export function countByNatura(files: readonly InboxFile[]): NaturaCounts {
  const counts: NaturaCounts = { nozioni: 0, derivazione: 0, sweep: 0 };
  for (const f of files) if (isQueued(f)) counts[f.natura as Natura]++;
  return counts;
}

export function totalQueued(counts: NaturaCounts): number {
  return counts.nozioni + counts.derivazione + counts.sweep;
}

/**
 * D10 — 48 ore. Un campionamento a 6 ore sbaglia al massimo di un ottavo, cioè
 * entro il rumore di una soglia scelta a mano.
 */
export const DEFAULT_INBOX_STALE_HOURS = 48;

/** Quanti file in coda hanno passato la soglia: è il numero accanto alla sirena. */
export function staleCount(
  files: readonly InboxFile[],
  hours: number,
  now: number,
): number {
  return files.filter((f) => isQueued(f) && ageHours(f.created, now) >= hours).length;
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
      { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 },
    );
    return { files: parseInboxTsv(stdout), ok: true };
  } catch {
    return { files: [], ok: false };
  }
}
