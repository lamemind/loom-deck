// T204 — la TERMINAZIONE di una conversazione per piattaforma: il `Terminator`
// che il gestore della chiusura (`endpoint-close.ts`) riceve come dipendenza.
//
// Le due piattaforme non condividono niente oltre alla forma:
//
//  - Linux — un segnale al processo `claude`; la tab si chiude perché il suo
//    `bash -lc` esce insieme a lui, e Ptyxis applica l'`exit-action` del
//    profilo;
//  - Windows — non esistono i segnali POSIX, e `process.kill(pid)` termina il
//    processo di forza con un codice ≠ 0: la tab si chiude solo se il wrapper
//    della tab esce 0 (P5 preflight).
//
// Una piattaforma senza terminazione restituisce il motivo, e il gestore lo
// gira a chi ha chiesto: nessun processo toccato.
import type { Terminator } from './endpoint-close.js';
import { platformName } from './platform.js';

/** La terminazione della piattaforma su cui il deck gira, o il motivo per cui
 *  non c'è. */
export function platformTerminator(p: NodeJS.Platform = process.platform): Terminator | { off: string } {
  return { off: `chiusura delle conversazioni non ancora disponibile su ${platformName(p)}` };
}
