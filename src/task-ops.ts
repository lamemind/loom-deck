// Le operazioni su una TASK: crearla, editarla, potarla.
//
// T131 — nate insieme agli spawn dentro `cli.tsx` e separate da quelli qui,
// sulla linea di frattura che l'analisi dello split aveva indicato: ciò che
// apre una conversazione da una parte, ciò che ordina un lavoro sulla task list
// dall'altra. Il discriminante operativo è l'OGGETTO — una sessione contro una
// riga di `tasks.md` — e si vede dagli effetti: qui si scrive il task file, si
// committa, si delega a una skill headless.
//
// Il deck non rimuove e non riscrive mai la task list da sé: `createTask` e
// `purgeTasks` ordinano a `loom-works:create-task` e `loom-works:clean-tasks`,
// che quelle sequenze le implementano già una volta. Averne due significherebbe
// due creazioni e due rimozioni capaci di divergere.
//
// Le stringhe di `setNote` di questo file sono ASSERITE dal gate
// `test/modes-smoke.test.ts` (`eliminare N task?`, `nessun push`, `scartate`,
// `tasks.md`): si copiano verbatim, non si migliorano di passaggio.
import { randomUUID } from 'node:crypto';
import { loadTasks, type Task } from './tasks.js';
import { appendTaskBinding } from './task-index.js';
import { cut, sanitize } from './width.js';
import { idList } from './ui/modals.js';
import { purgeTargets, splitTargets } from './purge.js';
import { initialDetail, writeTaskEdit, PRI_GLYPH, PRI_LABEL } from './task-edit.js';
import { priName, progName } from './view.js';
import {
  commitTaskEdit,
  spawnCleanTasks,
  spawnCreateTask,
  CLAUDE_CMD,
} from './spawn.js';
import type { EditDraft, PurgeDraft } from './model.js';
import type { DeckModel } from './deck-model.js';

export function useTaskOps({
  cwd,
  tasksPath,
  tasksDir,
  model,
  setNote,
  selectedTaskOr,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  model: DeckModel;
  setNote: (s: string) => void;
  /** La guardia di selezione, che vive in `actions.ts` e ha due chiamanti. */
  selectedTaskOr: (keyLabel: string, verb: string) => Task | null;
}) {
  // T30 — il taskId nasce DOPO create-task (lo assegna la skill scrivendo
  // tasks.md) → non è noto allo spawn. Il sessionId invece è pinnato qui:
  // snapshot degli id PRIMA, poi al completamento re-leggo tasks.md e il diff dà
  // il nuovo id → appendTaskBinding lega la sessione (scoped).
  function createTask(text: string) {
    if (!text) {
      setNote('C → create annullato (vuoto)');
      return;
    }
    const sid = randomUUID();
    const beforeIds = new Set(model.tasks.map((t) => t.id));
    setNote(`⏳ creando task… "${cut(text, 40)}" (sid ${sid.slice(0, 8)})`);
    const child = spawnCreateTask(text, cwd, sid, (ok) => {
      if (!ok) {
        setNote(`⚠ create-task fallito (${CLAUDE_CMD} -p)`);
        return;
      }
      let newId: string | undefined;
      try {
        newId = loadTasks(tasksPath).find((t) => !beforeIds.has(t.id))?.id;
      } catch {
        // tasks.md illeggibile → id non rilevato, sotto
      }
      if (newId) {
        appendTaskBinding(cwd, sid, newId);
        setNote(`✔ ${newId} creata · sessione scoped (sid ${sid.slice(0, 8)})`);
      } else {
        setNote(`✔ task creata (id non rilevato) · sid ${sid.slice(0, 8)}`);
      }
    });
    child.on('error', () => setNote(`⚠ create-task: '${CLAUDE_CMD}' non lanciabile`));
  }

  // T41 — scrive tasks.md + task file, poi committa. Il commit è immediato e non
  // confermato (scelta esplicita: l'edit è una micro-modifica, la storia
  // granulare vale più di un batch). Se nessuno dei due lati è stato scritto non
  // si committa nulla — `paths` vuoto renderebbe `git commit --` un commit di
  // TUTTO il working tree, che è l'opposto di ciò che vogliamo.
  function writeEdit(task: Task, draft: EditDraft) {
    // Il titolo si scrive solo se è CAMBIATO davvero: rimandarlo identico
    // riscriverebbe comunque la cella (collassando spazi ed escape) e sporcherebbe
    // il diff di una riga per un edit di sola priorità. Vuoto → scartato: una
    // task senza descrizione in overview non è più riconoscibile.
    const title = draft.title.trim();
    const titleChanged = title.length > 0 && title !== task.rawDesc.trim();

    let res: ReturnType<typeof writeTaskEdit>;
    try {
      res = writeTaskEdit({
        tasksPath,
        tasksDir,
        id: task.id,
        pri: draft.pri,
        prog: draft.prog,
        detail: draft.detail,
        title: titleChanged ? title : undefined,
      });
    } catch (e) {
      setNote(`⚠ ${task.id}: scrittura fallita (${(e as Error).message})`);
      return;
    }
    if (res.paths.length === 0) {
      setNote(`⚠ ${task.id}: nessun campo aggiornabile (riga o task file assenti)`);
      return;
    }

    const summary = `${PRI_GLYPH[draft.pri]} ${PRI_LABEL[draft.pri]} · ${res.progress}${
      titleChanged ? ` · "${cut(sanitize(title), 32)}"` : ''
    }`;
    setNote(`⏳ ${task.id} → ${summary} · commit…`);
    commitTaskEdit(
      cwd,
      res.paths,
      `chore(${task.id}): pri ${PRI_LABEL[draft.pri]} · stato ${res.progress}${
        titleChanged ? ' · titolo' : ''
      }`,
      (ok, err) => {
        setNote(
          ok
            ? `✔ ${task.id} → ${summary} · committato`
            : `⚠ ${task.id} salvato, commit fallito: ${err}`,
        );
      },
    );
  }

  /**
   * La bozza di conferma per `CANC`, o `null` se non c'è niente da confermare
   * (in tal caso la nota dice già perché).
   *
   * Il tasto è uno e il bersaglio ha due taglie: la task selezionata, o
   * l'insieme intero della vista `archiviabili`. A discriminare è `purgeBulk` —
   * la selezione prima della vista.
   *
   * Il bersaglio del bulk si legge da `paneTasks`, cioè dalla stessa fonte che
   * disegna le righe e alimenta il contatore in header (D6): mai il `Set` grezzo
   * di `archivable.ts`, mai un secondo filtro sullo stato. T100 ha fissato che
   * ciò che si conta e ciò che si mostra siano lo stesso insieme per
   * costruzione; qui l'invariante si estende a ciò che si pota.
   */
  function purgeDraftFor(): PurgeDraft | null {
    // La guardia di focus sta QUI e non solo dentro `selectedTaskOr`: il ramo
    // bulk non passa da quella, perché il suo oggetto è la vista e non la
    // selezione. Senza, `CANC` col focus sulle sessioni potrebbe potare in
    // blocco senza che nessuna task fosse selezionata.
    if (model.focus !== 'tasks') {
      setNote('CANC → eliminare: seleziona una task (← per il pane)');
      return null;
    }
    const bulk = model.purgeBulk;
    const ids = bulk ? model.paneTasks.map((t) => t.id) : [];
    if (!bulk) {
      const task = selectedTaskOr('CANC', 'eliminare');
      if (!task) return null;
      ids.push(task.id);
    }
    if (ids.length === 0) {
      setNote('CANC → nessuna task in vista da eliminare');
      return null;
    }
    // Ricalcolo al momento dell'AZIONE, non lettura del campionamento in lista:
    // una folder sporcata dopo l'ultimo scan si presenterebbe come eliminabile.
    const { clean, dirty } = splitTargets(purgeTargets(ids, tasksDir, cwd));
    if (bulk) {
      // Il gate del plugin esce 2 PRIMA di toccare qualsiasi cosa, quindi una
      // sola folder sporca annullerebbe il purge di tutte le altre: si scartano
      // a monte e il modale nomina sia le potate sia le scartate.
      if (clean.length === 0) {
        setNote(
          `CANC → ${dirty.length} task con file non tracciati in folder: eliminale una per una`,
        );
        return null;
      }
      return {
        ids: clean.map((t) => t.id),
        skipped: dirty.map((t) => t.id),
        bulk: true,
        ignored: null,
        survivors: 0,
      };
    }
    // Singola con superstiti → conferma a TRE uscite (D3): la scelta keep/purge
    // è rara e distruttiva in modo diverso dal purge normale, e qui è visibile
    // invece di stare davanti a ogni potatura.
    const one = clean[0] ?? dirty[0]!;
    return {
      ids: [one.id],
      skipped: [],
      bulk: false,
      ignored: one.survivors > 0 ? 'keep' : null,
      survivors: one.survivors,
    };
  }

  // ⏎ nella conferma: ordina la potatura a `loom-works:clean-tasks` e la
  // osserva. Il deck non rimuove niente da sé — nessun `git rm`, nessuna
  // riscrittura di tasks.md, nessuna `unlink`: quella sequenza è già
  // implementata una volta, e averne due significherebbe due rimozioni capaci
  // di divergere.
  //
  // La lista si riallinea al primo tick del poll e il set delle archiviabili
  // allo scan che `doneSig` fa scattare quando la popolazione Done cambia; la
  // selezione, keyed su id, cade sulla prima riga della vista (effect di
  // validità) invece che su una posizione residua.
  function purgeTasks(draft: PurgeDraft) {
    const sid = randomUUID();
    setNote(`⏳ eliminando ${draft.ids.length} task… ${idList(draft.ids, 6)}`);
    const child = spawnCleanTasks(draft.ids, cwd, sid, draft.ignored, (ok, detail) => {
      // L'esito si misura su `tasks.md`, NON sul solo `is_error`. Misurato: col
      // gate `--ignored-files` che blocca, la skill spiega il blocco e chiude
      // comunque `is_error: false` — un successo dichiarato su zero rimozioni.
      // Il segnale robusto è quali degli ID bersaglio non hanno più una riga:
      // deterministico, e indipendente da come la skill racconta sé stessa.
      let survived = draft.ids;
      try {
        const now = new Set(loadTasks(tasksPath).map((t) => t.id));
        survived = draft.ids.filter((id) => now.has(id));
      } catch {
        // tasks.md illeggibile → nessuna verifica possibile, e allora si dice
        // che non è stata fatta invece di dedurre un esito.
        setNote(`⚠ ${draft.ids.length} task: esito non verificabile (tasks.md illeggibile)`);
        return;
      }
      const removed = draft.ids.length - survived.length;
      if (removed === draft.ids.length) {
        // Il push non c'è, per scelta della skill: finché nessuno pusha, un
        // altro worktree continua a vedere le task potate in tasks.md. Non
        // dirlo lascerebbe leggere l'assenza di push come «fatto».
        setNote(`✔ ${removed} task eliminate · commit locali, nessun push`);
      } else {
        // Il gate `--ignored-files` (exit 2) può scattare lo stesso: la
        // dirtiness è un dato campionato e una folder può sporcarsi fra il
        // ricalcolo e l'apply. Il testo del result event è l'unica cosa che dice
        // PERCHÉ, quindi entra nella riga invece di un ⚠ muto.
        setNote(
          `⚠ ${removed}/${draft.ids.length} eliminate · restano ${idList(survived, 4)} · ${cut(
            detail || (ok ? '' : `${CLAUDE_CMD} -p`),
            56,
          )}`,
        );
      }
    });
    child?.on('error', () => setNote(`⚠ clean-tasks: '${CLAUDE_CMD}' non lanciabile`));
  }

  /** T41 — la bozza dell'edit seminata dai valori ATTUALI della task. */
  function editDraftFor(task: Task): EditDraft {
    // La priorità arriva dal glifo di tasks.md (già in `selTask`), lo stato dal
    // suo glifo Prog; il progresso arbitrario dal campo `Progress` del task file
    // — ma solo se è davvero custom (vedi `initialDetail`).
    //
    // Il titolo si semina dalla riga di tasks.md e non dall'H1 del task file per
    // due ragioni: è la fonte che esiste SEMPRE (un task file può mancare), ed è
    // il testo che l'utente sta guardando in lista quando preme `E`. Grezzo
    // (`rawDesc`), non sanificato: rimandare a disco la forma sanificata
    // riscriverebbe i glifi anche senza toccare il campo.
    const prog = progName(task.prog) ?? 'todo';
    return {
      pri: priName(task.pri) ?? 'med',
      prog,
      detail: initialDetail(model.detail?.fields['Progress'] ?? '', prog),
      title: task.rawDesc,
    };
  }
  return { createTask, editDraftFor, writeEdit, purgeDraftFor, purgeTasks };
}

export type TaskOps = ReturnType<typeof useTaskOps>;
