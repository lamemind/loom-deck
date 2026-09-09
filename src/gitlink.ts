// T155 — il gitlink dei submodule come dato del deck.
//
// Il cappello pinna ogni membro a un commit fisso (gitlink `160000`). Quando un
// submodule avanza — un commit nel deck, nel plugin, in compass — il gitlink
// resta indietro finché qualcuno non lo bumpa a mano.
//
// LA CLASSIFICAZIONE NON STA QUI (P1 preflight). Il deck spawna
// `bump-gitlink.sh --dry-run` del plugin e mostra il TSV che ne esce: la stessa
// sequenza che poi committa è quella che ha misurato, quindi il sensore non può
// dire «bumpabile» in base a un criterio diverso da quello del bump. Replicarla
// in TypeScript darebbe due implementazioni delle due guardie — quella sul verso
// e quella sul remote — e una divergenza fra le due si vedrebbe solo come un
// cappello pinnato su un commit sbagliato, giorni dopo, nel clone di qualcun
// altro. Stesso confine di `inbox.ts` e `wrap-scan.ts`, e non quello di
// `purge.ts`, che passa da una sessione Claude: qui non c'è nessun prompt, solo
// un `execFile` con esito sincrono.
//
// Lettore puro + spawn: nessun React, nessuna resa. È l'unico modo di provarlo
// senza pseudo-terminale.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pluginScript } from './plugin-cache.js';

const execFileAsync = promisify(execFile);

export const GITLINK_SCRIPT = 'scripts/utils/bump-gitlink.sh';

/**
 * Ogni 30 secondi (P2 preflight).
 *
 * Il gate che regge gli altri poll stretti del deck qui NON funziona: il
 * disallineamento nasce da un commit dentro il submodule, che lascia fermi sia
 * `HEAD` del cappello (`commit-times.ts`) sia la mtime dei task file
 * (`epic-hierarchy.ts`) — non c'è niente di economico da misurare prima. Resta
 * il costo nudo, misurato sul cappello a tre submodule: 0,03s per giro, dentro
 * il budget che T153 ha fissato per il loop.
 *
 * Il dry-run NON contatta la rete (P11): la guardia col `fetch` gira solo nel
 * bump. Ne discende che il sensore può contare «bumpabile» un commit che il
 * bump poi salta perché sparito dal remote — la guardia sta sull'AZIONE, e un
 * contatore non è un'autorizzazione.
 */
export const GITLINK_SCAN_INTERVAL_MS = 30 * 1000;

/**
 * Gli stati che lo script emette, più `sconosciuto` che è del solo lettore.
 *
 * I primi tre vengono dai prefissi di `git submodule status`; gli altri
 * spacchettano il prefisso `+`, che da solo NON dice il verso — `man
 * git-submodule`: «`+` if the currently checked out submodule commit does not
 * match the SHA-1 found in the index». Un checkout più vecchio del gitlink
 * (cappello pullato senza `git submodule update`) porta lo stesso `+` di un
 * commit nuovo nel membro, e le due situazioni hanno rimedi opposti.
 *
 * `bumpato` esiste solo nell'output del bump: nel dry-run un membro idoneo resta
 * `avanti`. Sono due fatti diversi — «lo bumperei» e «l'ho bumpato» — e un solo
 * nome per entrambi renderebbe la riga di stato indistinguibile da un'anteprima.
 */
export const GITLINK_STATES = [
  'allineato',
  'non-inizializzato',
  'conflitto',
  'avanti',
  'indietro',
  'non-pushato',
  'remote-irraggiungibile',
  'bumpato',
] as const;

export type GitlinkState = (typeof GITLINK_STATES)[number] | 'sconosciuto';

export interface GitlinkMember {
  /** Path del submodule, relativo alla project root. */
  path: string;
  state: GitlinkState;
  /** Il gesto che manca, o lo sha vecchio→nuovo su un bump riuscito. */
  detail: string;
}

const KNOWN = new Set<string>(GITLINK_STATES);

/**
 * Il TSV di `bump-gitlink.sh`: una riga per submodule, `path ⇥ stato ⇥ dettaglio`.
 * Nessuna riga di intestazione — il primo campo è già un path.
 *
 * Uno stato che il deck non conosce diventa `sconosciuto` invece di sparire: la
 * riga la si è comunque ricevuta, e scartarla farebbe calare il contatore ogni
 * volta che lo script guadagna uno stato nuovo — cioè proprio quando il deck ha
 * più bisogno di dirlo. Il dettaglio è l'ULTIMO campo e si ricompone: può
 * contenere un comando, e un comando può contenere un tab.
 */
export function parseGitlinkTsv(stdout: string): GitlinkMember[] {
  const out: GitlinkMember[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 2 || !c[0]) continue;
    out.push({
      path: c[0],
      state: KNOWN.has(c[1]!) ? (c[1] as GitlinkState) : 'sconosciuto',
      detail: c.slice(2).join('\t'),
    });
  }
  return out;
}

/**
 * Gli stati che il contatore somma: i membri il cui checkout non coincide col
 * gitlink, in entrambi i versi.
 *
 * `non-inizializzato` e `conflitto` restano FUORI per decisione: nessun bump li
 * sistema — il primo vuole un `git submodule update --init`, il secondo la
 * risoluzione di un merge — e sommarli darebbe un numero che il tasto non può
 * portare a zero. Un contatore che non arriva mai a zero smette di essere letto
 * (stessa regola di `misto` nell'indicatore hard-wrap). Si dicono comunque, col
 * glifo di allerta accanto al numero.
 */
const DISALIGNED = new Set<GitlinkState>([
  'avanti',
  'indietro',
  'non-pushato',
  'remote-irraggiungibile',
]);

/** Quanti membri hanno il checkout diverso dal gitlink: è il numero a schermo. */
export function disalignedCount(members: readonly GitlinkMember[]): number {
  return members.filter((m) => DISALIGNED.has(m.state)).length;
}

/** Quanti sono bumpabili adesso: il solo `avanti` passa entrambe le guardie. */
export function bumpableCount(members: readonly GitlinkMember[]): number {
  return members.filter((m) => m.state === 'avanti').length;
}

/**
 * Qualcosa richiede attenzione ma nessun bump lo sistema: un membro non
 * inizializzato, un conflitto di merge, uno stato che questo deck non conosce.
 * Vale il glifo di allerta, mai una cifra nel contatore.
 */
export function attentionCount(members: readonly GitlinkMember[]): number {
  return members.filter(
    (m) => m.state === 'non-inizializzato' || m.state === 'conflitto' || m.state === 'sconosciuto',
  ).length;
}

/**
 * Gli stati che il bump ha SALTATO: il membro è disallineato ma una delle due
 * guardie l'ha fermato, e il rimedio non è un bump ma il gesto che il dettaglio
 * nomina.
 */
const SKIPPED = new Set<GitlinkState>(['indietro', 'non-pushato', 'remote-irraggiungibile']);

/**
 * La riga di stato dopo un bump: un esito per membro, non un totale.
 *
 * Il caso che rende necessario nominarli è il MISTO — un membro pushato e uno
 * no. Lì un messaggio riassuntivo direbbe «1 bumpato» e lascerebbe fuori proprio
 * l'informazione che serve ad agire: quale membro è rimasto indietro e con quale
 * comando lo si sblocca. Il gesto arriva già scritto dallo script, che è dove la
 * guardia lo ha deciso: comporlo qui darebbe due frasi da tenere allineate.
 *
 * I bumpati vengono per primi — è l'esito che il tasto prometteva — e i saltati
 * dopo, ognuno col proprio glifo di allerta. I membri allineati non compaiono:
 * la riga di stato dice cosa è successo, non cosa esiste.
 */
export function gitlinkNote(members: readonly GitlinkMember[]): string {
  const done = members
    .filter((m) => m.state === 'bumpato')
    .map((m) => `✔ ${m.path} ${m.detail}`.trim());
  const skipped = members
    .filter((m) => SKIPPED.has(m.state))
    .map((m) => `⚠ ${m.path}: ${m.detail}`);
  return [...done, ...skipped].join(' · ');
}

/**
 * Il progetto ha submodule da misurare.
 *
 * È il gate di ATTIVAZIONE dell'intero sensore (DLV2): senza `.gitmodules` non
 * parte nessun timer, non si spawna niente e l'indicatore non compare affatto —
 * non «0», che occuperebbe colonne per dire che la funzione non si applica.
 *
 * Il file, non `git submodule status`: rispondere alla domanda «ci sono
 * submodule?» con lo stesso spawn che si vuole evitare sarebbe la misura che il
 * gate esiste per non pagare.
 */
export function hasGitmodules(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.gitmodules'));
}

export interface GitlinkScan {
  members: GitlinkMember[];
  /** Lo script è stato trovato ed è uscito bene. */
  ok: boolean;
}

/**
 * Invoca lo script e ne parsa l'output.
 *
 * I modi di non avere il dato — plugin non installato su questa macchina,
 * script in errore, git muto — collassano in un solo `ok: false`, come per la
 * coda inbox: a schermo non cambiano la prima mossa di chi li vede. Nessuno dei
 * due è un throw, un indicatore informativo non può rompere il deck.
 *
 * Lo stdout si legge ANCHE quando l'exit è non-zero: lo script classifica tutti
 * i membri prima di agire, quindi su un errore parziale (un `git` che fallisce
 * su un membro) le righe già emesse restano vere e dicono più di una schermata
 * vuota.
 */
async function run(projectRoot: string, args: string[]): Promise<GitlinkScan> {
  const script = pluginScript(GITLINK_SCRIPT);
  if (!script) return { members: [], ok: false };
  try {
    const { stdout } = await execFileAsync(script, args, {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024,
    });
    return { members: parseGitlinkTsv(stdout), ok: true };
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout ?? '';
    return { members: parseGitlinkTsv(stdout), ok: false };
  }
}

/** La misura, senza toccare niente: nessun fetch, nessun commit. */
export function scanGitlink(projectRoot: string): Promise<GitlinkScan> {
  return run(projectRoot, ['--dry-run']);
}

/**
 * Il bump vero: fetch, due guardie, commit unico coi soli membri idonei. Il
 * cappello NON viene pushato — quel gesto resta al flusso normale, perché un
 * gitlink committato per sbaglio si annulla con un `git reset` che non tocca
 * nessun remote, mentre uno pushato è già nella copia di chiunque abbia pullato.
 */
export function bumpGitlink(projectRoot: string): Promise<GitlinkScan> {
  return run(projectRoot, []);
}
