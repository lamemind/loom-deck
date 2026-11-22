// T232 — il driver comune dei gate pty: i file che avviano il deck VERO sotto
// `test/pty-frame.py` e lo pilotano tasto per tasto.
//
// Perché un modulo. I gate pty erano due file oltre le 1.000 righe, ognuno col
// proprio lanciatore del deck. Il runner di `node:test` parallelizza per FILE e
// dentro un file le catture vanno in serie: spezzarli è ciò che accorcia la
// suite completa, e un lanciatore per file avrebbe moltiplicato le copie. Qui
// vive ciò che ogni gate pty condivide — dove sta il progetto, quale deck si
// avvia e con quale ambiente, il gate di salto, i nomi dei tasti. La lettura
// del frame resta per famiglia (`modes-kit.ts`, `frame-kit.ts`): le due
// famiglie leggono lo stesso buffer in due modi diversi.
//
// Non è un file di test (`*.test.ts`): il runner non lo esegue, lo importano.
// La dipendenza va in un verso solo — nessun modulo di `test/` importa un
// `*.test.ts`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyGate } from './platform-gates.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = dirname(HERE);
/** Progetto su cui girare: il cappello che contiene il deck come submodule. */
export const PROJECT = dirname(PKG);
export const TASKS = join(PROJECT, 'runtime', 'tasks.md');

/**
 * Il deck che i gate avviano è la BUILD, non i sorgenti: `tsx src/cli.tsx`
 * transpilava il deck a ogni cattura, e le catture sono centinaia per suite.
 *
 * Il prezzo: un file pty lanciato a mano senza `npm run build` misura la build
 * precedente, e può passare su codice che non esiste più. `npm test` e
 * `npm run test:full` buildano prima (`pretest`, `pretest:full`); chi lancia un
 * file a mano builda da sé. È la stessa trappola di `deck-run.test.ts`, che
 * esegue lo shim su `dist/`.
 */
export const DECK_CLI = join(PKG, 'dist', 'cli.js');
const DECK_CMD = [process.execPath, DECK_CLI];

// T175 — il motivo del salto lo dà `ptyGate`, e nomina la dipendenza vera: su
// Windows il gate non parte nemmeno con Python installato. T232 — nella suite
// rapida (`npm test`) non parte nessun gate pty, e senza build non c'è il deck
// da avviare.
export const SKIP = ptyGate(TASKS) || (existsSync(DECK_CLI) ? false : 'build assente: npm run build');
export const CAN_RUN = SKIP === false;

export interface DeckRun {
  cols: number;
  rows: number;
  keys: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Un deck vero in un pty di `cols`×`rows`, i tasti `keys` nella grammatica di
 * `pty-frame.py`, poi SIGKILL: torna il buffer grezzo del pty seguito dalla riga
 * `<<PROC alive|exit=N>>`.
 */
export function runDeck({ cols, rows, keys, cwd = PROJECT, env = {} }: DeckRun): string {
  return execFileSync(
    'python3',
    [join(HERE, 'pty-frame.py'), String(cols), String(rows), cwd, ...DECK_CMD, '--keys', keys],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // NO_SPAWN: il gate manda tasti a un deck VERO, e qui un tasto è
        // un'azione — `⏎` apre una tab Ptyxis, `t` un terminale, `⏎` nel modale
        // edit committa. Senza freno ogni run dei test aprirebbe finestre reali.
        LOOM_DECK_NO_SPAWN: '1',
        // La docs-root del progetto arriva da qui e non dal file config
        // (`resolveTasksPath` legge `LOOM_DECK_DOCS_ROOT`): senza, il deck
        // cerca `docs/tasks.md`, la lista task è vuota e i modi che richiedono
        // una task selezionata non si aprono affatto.
        LOOM_DECK_DOCS_ROOT: 'runtime',
        // T216 — un endpoint per deck: i deck degli scenari girano anche in
        // parallelo sullo stesso progetto, e con una cartella dei socket in
        // comune quello che resta aperto subentrerebbe a quello che muore, e la
        // nota del subentro coprirebbe la nota che lo scenario guarda.
        XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'rt-')),
        ...env,
      },
    },
  );
}

/** Toglie le sequenze CSI e OSC: resta il testo che occupa colonne. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ── I tasti ──────────────────────────────────────────────────────────────────
//
// I tasti CTRL non hanno voce nella mappa di `pty-frame.py`: si scrivono nudi
// dentro `keys`, perché ogni carattere fuori mappa viene digitato tale e quale.

export const ESC = '\x1b';
export const CTRL_A = '\x01';
export const CTRL_C = '\x03';
export const CTRL_F = '\x06';
/** T168 — `^L` apre la pagina delle voci launch. */
export const CTRL_L = '\x0c';
export const CTRL_R = '\x12';
/** T161 — `^S` apre la pagina delle azioni di spawn. È anche l'XOFF del
 *  flow-control: che arrivi al deck invece di essere mangiato dal terminale è
 *  ciò che i gate misurano. */
export const CTRL_S = '\x13';
/** T134 — `^W` apre la lista hard-wrap. */
export const CTRL_W = '\x17';
/** T112 — `CANC` nella mappa di `pty-frame.py`: la sequenza è di 4 byte e
 *  scritta nuda arriverebbe come quattro tasti separati. */
export const CANC = 'K';
