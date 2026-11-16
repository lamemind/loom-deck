// T196 — l'endpoint del deck cablato nel deck: avviato al mount, chiuso allo
// smontaggio, e ogni richiesta consegnata al gestore del suo verbo — `spawn` allo
// spawn del tasto, `close` (T204) alla chiusura di una conversazione viva.
//
// Non è un overlay — non apre nessuna schermata e non entra in `MODE_KEYS`. Sta
// qui per la stessa ragione di `useGitlink`: un hook con un ciclo di vita
// proprio e un'azione verso l'esterno, e `hooks.ts` è già oltre le 800 righe.
//
// Il gestore legge le azioni da un ref aggiornato a ogni render: `spawnForTask`
// chiude su override, catalogo e larghezza del terminale, e una richiesta deve
// partire coi valori di adesso, non con quelli del primo render.
import { useEffect, useRef } from 'react';
import { listenEndpoint } from '../endpoint-server.js';
import { handleCloseRequest } from '../endpoint-close.js';
import { handleSpawnRequest } from '../endpoint-spawn.js';
import { platformTerminator } from '../close-terminate.js';
import { discoverLiveSessions } from '../live-sessions.js';
import { endpointFor, type CloseReply } from '../spawn-endpoint.js';
import { isAvailable, offText } from '../platform.js';
import { appendLive, loadSessionIndex, ORIGIN_ENDPOINT } from '../task-index.js';
import { loadTaskFileText, loadTasks } from '../tasks.js';
import type { DeckActions } from '../actions.js';

export interface EndpointDeps {
  /** La project root del deck: da lei viene l'indirizzo. */
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  actions: Pick<DeckActions, 'spawnForTask' | 'spawnTaskDefaults'>;
  setNote: (s: string) => void;
}

export function useSpawnEndpoint(deps: EndpointDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  const { cwd } = deps;
  // T204 — le chiusure in corso, condivise fra le richieste: una seconda
  // richiesta sulla stessa conversazione si rifiuta invece di ri-terminarla.
  const closing = useRef(new Set<string>());

  useEffect(() => {
    let closed = false;
    let close: (() => void) | null = null;
    const ep = endpointFor(cwd);
    void listenEndpoint(ep, {
      spawn: (req) => {
        const d = latest.current;
        return handleSpawnRequest(req, {
          spawnOff: () => (isAvailable('spawn') ? null : offText('spawn')),
          taskExists: (id) => {
            try {
              return loadTasks(d.tasksPath).some((t) => t.id === id);
            } catch {
              return false;
            }
          },
          taskText: (id) => loadTaskFileText(d.tasksDir, id),
          defaults: (kind, taskId) => d.actions.spawnTaskDefaults(kind, taskId),
          // T204 — la conversazione nasce marcata `origin: endpoint`: è ciò che
          // la rende chiudibile da un'altra conversazione (D2 preflight).
          spawn: (id, model, note, prompt) => d.actions.spawnForTask(id, model, note, prompt, false, ORIGIN_ENDPOINT),
        });
      },
      close: async (req) => {
        const r = await handleCloseRequest(req, {
          // La guardia di CANC (`actions.ts`): dove la liveness manca la mappa
          // delle vive è vuota per costruzione, e «nessuna viva» sarebbe falso.
          closeOff: () =>
            isAvailable('liveSessions') ? null : offText('liveSessions', 'chiusura delle conversazioni'),
          terminator: () => platformTerminator(),
          live: () => discoverLiveSessions(cwd),
          sidecar: () => loadSessionIndex(cwd),
          retire: (sid) => appendLive(cwd, sid, false),
          inFlight: closing.current,
        });
        noteClose(r, latest.current.setNote);
        return r;
      },
    }).then((r) => {
      if (r.state === 'listening') {
        // Smontato mentre `listen` era in volo: si chiude subito.
        if (closed) r.close();
        else close = r.close;
        return;
      }
      // Un deck senza endpoint resta un deck intero: lo si dice e basta. Le
      // richieste di spawn di questo progetto arriveranno all'altro deck.
      latest.current.setNote(
        r.state === 'busy'
          ? `⚠ endpoint di spawn già in ascolto da un altro deck su questo progetto (${ep.name})`
          : `⚠ endpoint di spawn non avviato: ${r.reason}`,
      );
    });
    return () => {
      closed = true;
      close?.();
    };
  }, [cwd]);
}

/** La riga di stato del deck dopo una chiusura chiesta da fuori: solo quando un
 *  processo è stato toccato. Un rifiuto non tocca niente, e lo legge chi ha
 *  chiesto. */
function noteClose(r: CloseReply, setNote: (s: string) => void) {
  if (r.ok) {
    setNote(`✔ ${r.sessionId.slice(0, 8)} chiusa su richiesta di una conversazione${r.warning ? ` (⚠ ${r.warning})` : ''}`);
  } else if (r.sessionId) {
    setNote(`⚠ ${r.reason}`);
  }
}
