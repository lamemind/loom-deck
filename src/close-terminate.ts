// T204 — la TERMINAZIONE di una conversazione per piattaforma: il `Terminator`
// che il gestore della chiusura (`endpoint-close.ts`) riceve come dipendenza.
//
// Le due piattaforme non condividono niente oltre alla forma:
//
//  - Linux — SIGHUP al processo `claude`, il segnale che riceve quando l'utente
//    chiude la tab: è il percorso su cui il restore del deck riprende già le
//    conversazioni (P4 preflight). Misurato su una sessione vera: `claude` esce
//    in circa un secondo con codice 129, toglie il proprio file dal registro
//    delle vive, e il transcript resta riprendibile con lo stesso `sessionId`.
//    La tab si chiude perché il suo `bash -lc` esce insieme a `claude`, e
//    Ptyxis applica l'`exit-action` del profilo. Nessun SIGKILL dopo l'attesa:
//    lascerebbe il file orfano nel registro, e la risposta deve dire che il
//    processo non è finito, non finirlo;
//  - Windows — non esistono i segnali POSIX, e `process.kill(pid)` termina il
//    processo di forza con un codice ≠ 0: la tab si chiude solo se il wrapper
//    della tab esce 0 (P5 preflight).
//
// Una piattaforma senza terminazione restituisce il motivo, e il gestore lo
// gira a chi ha chiesto: nessun processo toccato.
import type { Terminator } from './endpoint-close.js';
import { procRunning } from './live-sessions.js';
import { platformName } from './platform.js';

/** Linux: SIGHUP, e la fine verificata con la guardia del registro più lo
 *  stato del processo (`procRunning`: uno zombie è finito). */
export const linuxTerminator: Terminator = {
  how: 'SIGHUP',
  terminate: (t) => {
    // La guardia rimisurata subito prima del segnale: fra la lettura del
    // registro e qui il processo può essere finito, e il pid riusato da un
    // programma che non è la conversazione.
    if (!procRunning(t.pid, t.procStart)) return 'ESRCH';
    try {
      process.kill(t.pid, 'SIGHUP');
      return null;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code ?? String(e);
    }
  },
  alive: (t) => procRunning(t.pid, t.procStart),
};

/** La terminazione della piattaforma su cui il deck gira — quella VERA, come
 *  la liveness (`live-sessions.ts`): `/proc` e i segnali ci sono o non ci sono
 *  a seconda del sistema, e `LOOM_DECK_PLATFORM` non li fa comparire. */
export function platformTerminator(p: NodeJS.Platform = process.platform): Terminator | { off: string } {
  if (p === 'linux') return linuxTerminator;
  return { off: `chiusura delle conversazioni non ancora disponibile su ${platformName(p)}` };
}
