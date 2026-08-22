// T121 — il recap di progetto come ARTEFATTO invece che come conversazione.
//
// La skill `loom-works:recap-status-project` produce un testo che oggi vive
// solo dentro la sessione che l'ha chiesta: il deck la invoca in headless e ne
// scrive il risultato su disco, così un deck riaperto lo ritrova invece di
// ripartire da zero.
//
// Logica pura + accesso al file, zero React: gli stati dell'indicatore si
// collaudano senza pseudo-terminale.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fmtTime, WARN } from './glyphs.js';

/**
 * Cartella della cache, una per UTENTE.
 *
 * `/tmp` è condivisa e world-writable col solo sticky bit: un file a nome
 * prevedibile lì dentro può essere preceduto da un symlink piazzato da un altro
 * utente, e la scrittura lo seguirebbe. La cartella con `mode 0700` chiude il
 * caso senza rinunciare a `/tmp` (D7), e l'uid è stabile quanto il path del
 * progetto — la coordinata resta una funzione, non un registro.
 */
export function statusDir(): string {
  return join(tmpdir(), `loom-deck-status-${process.getuid?.() ?? 0}`);
}

/**
 * Coordinata del file di cache: derivata dal path del progetto con la stessa
 * trasformazione del transcript store di Claude Code (non-alnum → `-`).
 *
 * L'env override esiste per i test e per la verifica a mano: senza, provare il
 * viewer richiederebbe di spendere una generazione vera da minuti.
 */
export function statusFilePath(projectRoot: string): string {
  const env = process.env.LOOM_DECK_STATUS_FILE;
  if (env) return env;
  return join(statusDir(), `${projectRoot.replace(/[^a-zA-Z0-9]/g, '-')}.md`);
}

export interface StatusCache {
  text: string;
  /** Ora dell'ultima generazione riuscita: l'mtime del file, mai un campo
   *  scritto dentro il testo — un fatto scritto due volte diverge alla prima
   *  riscrittura parziale. */
  mtime: number;
}

/** File assente o illeggibile → nessuna cache. Mai un throw: `missing` non è
 *  un errore, è lo stato di partenza di ogni progetto. */
export function readStatusCache(path: string): StatusCache | null {
  try {
    const text = readFileSync(path, 'utf8');
    return { text, mtime: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Riporta a markdown gli heading scritti per la chat di Claude Code.
 *
 * L'output style del progetto impone lì un `#` in PIÙ (`# ## Sezione` per un
 * H2), perché quel terminale stila solo l'H1 e senza il trucco la gerarchia si
 * appiattirebbe. Il deck però rende markdown vero: lasciato com'è, ogni titolo
 * del recap comparirebbe come un H1 col testo letterale `## Sezione`.
 *
 * Il deck è il consumatore, quindi la traduzione la paga lui: la skill produce
 * per la chat, che resta il suo canale principale. La sostituzione è sicura
 * anche se la convenzione sparisse — richiede altri `#` dopo il primo, quindi
 * un heading markdown normale non la incontra mai.
 */
export function normalizeChatHeadings(text: string): string {
  return text.replace(/^# (#+ )/gm, '$1');
}

export function writeStatusCache(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, normalizeChatHeadings(text), { mode: 0o600 });
}

export const STATUS_MISSING = 'missing';

export interface StatusState {
  /** Ora dell'ultima generazione riuscita; `null` = nessuna cache. */
  mtime: number | null;
  /** Istante di spawn della generazione in corso; `null` = nessuna in corso. */
  startedAt: number | null;
  now: number;
  /** L'ultimo tentativo è fallito e nessuno riuscito l'ha ancora azzerato. */
  failed: boolean;
}

/**
 * Il campo fra parentesi della testata, nei suoi tre stati.
 *
 * Il marker di fallimento è un'AGGIUNTA e non un quarto stato (D5): un tentativo
 * fallito non riscrive la cache, quindi il dato precedente resta vero e ancora
 * apribile — sostituirlo con `failed` butterebbe via un'informazione che c'è.
 * I due fatti (cosa c'è in cache, com'è andato l'ultimo tentativo) sono sempre
 * entrambi veri nello stesso istante.
 */
export function statusLabel(s: StatusState): string {
  const base =
    s.startedAt !== null
      ? `building ${Math.max(0, Math.floor((s.now - s.startedAt) / 1000))}...`
      : s.mtime !== null
        ? fmtTime(s.mtime)
        : STATUS_MISSING;
  return s.failed ? `${base} ${WARN}` : base;
}
