// T196 — l'endpoint del deck cablato nel deck: avviato al mount, chiuso allo
// smontaggio, e ogni richiesta consegnata allo spawn del tasto.
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
import { handleSpawnRequest } from '../endpoint-spawn.js';
import { endpointFor } from '../spawn-endpoint.js';
import { isAvailable, offText } from '../platform.js';
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

  useEffect(() => {
    let closed = false;
    let close: (() => void) | null = null;
    const ep = endpointFor(cwd);
    void listenEndpoint(ep, (req) => {
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
        spawn: (id, model, note, prompt) => d.actions.spawnForTask(id, model, note, prompt),
      });
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
