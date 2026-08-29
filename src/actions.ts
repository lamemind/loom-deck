// L'ATTUATORE del deck: ciò che parte da una selezione e finisce fuori dal
// processo — una tab spawnata, un record nel sidecar, una riga riscritta su
// disco, un commit.
//
// T131 — è la casella che l'asse di T104 non aveva. `spawn.ts` è la fase
// «effetti esterni» ed è PURA: compone argv, lancia, restituisce il figlio, e
// il suo test non conosce React. Portarci dentro `setNote` e la selezione
// metterebbe React nella fase più a monte e ucciderebbe quel test. Gli overlay
// non possono ospitarli per la deroga di T104: un hook di overlay non esce dal
// deck, chiama un callback. Resta lo scalino in mezzo, ed è questo file: sa
// cosa è selezionato e cosa deve partire, non sa come si compone un argv né
// cosa c'è a schermo.
//
// Le stringhe di `setNote` di questo file sono ASSERITE dal gate
// `test/modes-smoke.test.ts` (`seleziona una task`, `terminale su`, `deck-run`,
// `nessun push`, `eliminare N task?`, `scartate`): si copiano verbatim, non si
// migliorano di passaggio.
import { useRef } from 'react';
import { randomUUID } from 'node:crypto';
import { loadTasks, type Task } from './tasks.js';
import {
  appendNote,
  appendPin,
  appendSessionRecord,
  appendTaskBinding,
} from './task-index.js';
import { neighborId } from './session-list.js';
import { cut, cutMiddle, sanitize } from './width.js';
import { idList } from './ui/modals.js';
import { purgeTargets, splitTargets } from './purge.js';
import { initialDetail, writeTaskEdit, PRI_GLYPH, PRI_LABEL } from './task-edit.js';
import { priName, progName } from './view.js';
import { saveView, viewFilePath } from './view-store.js';
import {
  commitTaskEdit,
  onInTabCommand,
  runLaunch,
  spawnClaudeEmpty,
  spawnCleanTasks,
  spawnCreateTask,
  spawnDeck,
  spawnDeckFork,
  spawnDeckResume,
  spawnTerminal,
  CLAUDE_CMD,
  DECK_RUN,
  MODEL_DEFAULT,
  type ModelKind,
  type PromptKind,
  type Spawned,
} from './spawn.js';
import { useTaskOps } from './task-ops.js';
import type { DeckModel } from './deck-model.js';

export function useDeckActions({
  cwd,
  tasksPath,
  tasksDir,
  columns,
  model,
  setNote,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  columns: number;
  model: DeckModel;
  setNote: (s: string) => void;
}) {
  // La riga di stato di OGNI spawn di sessione Claude: il comando esatto, come
  // lo si scriverebbe in bash, invece di una parafrasi.
  //
  // Non è un di più sulla nota descrittiva, la sostituisce: task, sessionId,
  // prompt-kind, modello e nota del titolo sono già tutti argomenti del comando,
  // quindi elencarli a parole li direbbe una seconda volta in una grafia che non
  // si può ricopiare in un terminale. Ciò che va perso è il tasto premuto
  // (`^K`, `⏎`, `f`), che è ciò che l'utente ha appena fatto e non ciò che il
  // deck ha fatto per lui.
  //
  // Il taglio è al MEZZO (`cutMiddle`, non `cut`): in un comando di spawn è la
  // coda a distinguere un'invocazione dall'altra, e un taglio dalla coda la
  // butterebbe via per intero. Si taglia QUI, alla composizione, e non al
  // render: la riga di stato porta anche messaggi normali, dove è la testa a
  // contare. Ne discende che un resize successivo non ricalcola l'elisione — la
  // nota è transitoria e `wrap="truncate-end"` resta come rete.
  function noteCommand(cmd: string) {
    // 4 = bordo + padding della cornice esterna, 2 = il prompt `$ `. Sbagliare
    // il budget non produce un errore visibile: la `truncate-end` di Ink taglia
    // il resto dalla CODA, e il comando esce col mezzo eliso E la fine persa —
    // cioè con entrambi i pezzi che l'elisione al mezzo voleva salvare.
    setNote(`$ ${cutMiddle(cmd, Math.max(8, columns - 6))}`);
  }

  // Le due note di uno spawn, in quest'ordine: il comando di `deck-run` subito,
  // e appena arriva l'annuncio quello della sessione `claude` che gira DENTRO
  // la tab — che è ciò che si vuole vedere davvero (`deck-run` è l'involucro,
  // l'invocazione vera la compone lui).
  //
  // La prima non è un ripiego di stile: è l'unica che esiste quando l'annuncio
  // non arriva (spawn inerte nei test, argomenti rifiutati, `deck-run` morto
  // prima dell'exec), ed è anche il comando da ripetere a mano per vedere
  // l'errore. Il salto fra le due dura i millisecondi che `deck-run` impiega a
  // comporre.
  const spawnSeq = useRef(0);
  function noteSpawn(spawned: Spawned) {
    noteCommand(spawned.cmd);
    const mine = ++spawnSeq.current;
    onInTabCommand(spawned.child, (inTab) => {
      // Due spawn ravvicinati: gli annunci sono asincroni e possono tornare
      // fuori ordine, e senza guardia il più vecchio scriverebbe sopra il più
      // recente — la riga di stato mostrerebbe un comando che non è l'ultimo
      // partito.
      if (spawnSeq.current === mine) noteCommand(inTab);
    });
  }

  // T66 — la guardia dello spawn bound, con due chiamanti: gli acceleratori
  // della lista e l'apertura del detail. Le tre uscite sono le stesse (pane
  // sbagliato, riga meta, task sparita), e duplicarle vorrebbe dire tenerne
  // allineati i messaggi a mano. `verb` è l'unica cosa che cambia fra i due usi.
  function selectedTaskOr(keyLabel: string, verb: string): Task | null {
    if (model.focus !== 'tasks') {
      setNote(`${keyLabel} → ${verb}: seleziona una task (← per il pane)`);
      return null;
    }
    // T59 — la guardia è "non è una task", non "è spot": le righe meta sono due
    // e nessuna delle due ha una task da aprire. Il messaggio dice quale delle
    // due, perché il motivo è diverso (vista di sola lettura vs sessioni libere).
    if (model.isAll || model.isSpot) {
      setNote(
        model.isAll
          ? `tutte: vista di sola lettura, nessuna task da ${verb}`
          : `spot: sessioni libere, nessuna task da ${verb}`,
      );
      return null;
    }
    return model.selTask;
  }

  // Lo spawn vero, su una task GIÀ risolta. Separato dalla guardia perché il
  // detail passa l'id fotografato all'apertura e non la selezione corrente: la
  // lista lì sotto non è più a schermo, quindi non è più la fonte dell'oggetto.
  // T111 — `spawnNote` arriva dal campo sempre attivo del detail ed è vuota per
  // ogni altro percorso. Si scrive nel sidecar PRIMA dello spawn, accanto al
  // binding e per la stessa ragione: la conversazione deve risultare figlia
  // della task e portare la propria maniglia appena il suo JSONL compare, o per
  // il tempo di un tick la riga in lista comparirebbe nuda. Due record separati
  // sullo stesso `sessionId` sono la forma normale di un file append-only
  // last-wins, non una scrittura da fondere.
  // T117 — `prompt` è il testo LETTERALE quando lo spawn arriva dal detail, dove
  // il campo è editabile: quello che l'utente legge è quello che parte. Assente
  // per gli acceleratori della lista, che non hanno un campo da cui prenderlo e
  // viaggiano col simbolo.
  function spawnForTask(
    id: string,
    kind: PromptKind,
    modelKind: ModelKind,
    spawnNote = '',
    prompt?: string,
  ) {
    const sid = randomUUID();
    appendTaskBinding(cwd, sid, id);
    if (spawnNote) appendNote(cwd, sid, spawnNote);
    const spawned = spawnDeck(id, cwd, sid, kind, modelKind, spawnNote, prompt);
    spawned.child.on('error', () => setNote(`⚠ spawn ${id} fallito (${DECK_RUN})`));
    // Il modello resta SEMPRE visibile anche quando è il default, perché è un
    // argomento esplicito del comando (T108): gli acceleratori della lista non
    // passano dal selettore del detail e usano il default fisso, quindi senza
    // vederlo l'utente crederebbe di aver ereditato la scelta dell'ultimo
    // detail aperto.
    noteSpawn(spawned);
  }

  // T56 — i quattro tasti (⏎/^K/^P/^R) passano tutti di qui: fra loro cambia
  // solo il prompt iniziale, tutto il resto è identico. Quattro copie sarebbero
  // quattro posti dove dimenticare il `child.on('error')`, e uno spawn fallito è
  // async: senza handler diventa uncaughtException e ucciderebbe il deck, che
  // invece deve restare vivo.
  function spawnTaskSession(kind: PromptKind, keyLabel: string) {
    const task = selectedTaskOr(keyLabel, 'spawnare');
    if (task) spawnForTask(task.id, kind, MODEL_DEFAULT);
  }

  // T49 — resume di una conversazione in una nuova tab. Unico punto: lo chiamano
  // il `⏎` della lista sessioni e quello sulla riga-sessione della ricerca, che
  // devono restare la stessa azione.
  function resumeSession(sessionId: string) {
    const bound = model.bindings.get(sessionId) ?? null;
    const spawned = spawnDeckResume(bound, cwd, sessionId, model.sessionNotes.get(sessionId));
    spawned.child.on('error', () => setNote(`⚠ resume fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }


  // T53 — scrive il sidecar e ricarica subito, senza attendere il tick del poll
  // (stesso feedback immediato del pin).
  //
  // Il campo VUOTO non è un annullamento: è la CANCELLAZIONE della nota. Sono
  // due intenzioni diverse e hanno due tasti diversi — `esc` lascia tutto com'è,
  // `⏎` su campo svuotato toglie la nota. Trattare il vuoto come un no-op (come
  // fa `createTask`, dove però una task senza titolo non esiste) renderebbe
  // impossibile disannotare una conversazione se non con un editor sul JSONL.
  function writeNote(sid: string, text: string) {
    appendNote(cwd, sid, text);
    model.reloadSessions();
    setNote(
      text
        ? `✎ titolo su ${sid.slice(0, 8)}: "${cut(text, 40)}"`
        : `✎ titolo rimosso da ${sid.slice(0, 8)}`,
    );
  }




  // T57 — riscrive il binding nel sidecar e ricarica subito.
  //
  // Il binding retroattivo governa il FUTURO della conversazione, non il suo
  // passato: il titolo della tab è stato deciso allo spawn da `claude --name` e
  // vive nel transcript, la `LOOM_TASK` di un processo già partito non si
  // reinietta. Cambia cosa fa il prossimo `⏎ resume`, che rilegge il binding dal
  // sidecar. La nota lo dice: senza, la promessa implicita è «ho spostato la
  // conversazione» e il titolo che non cambia sembra un bug.
  //
  // Dove atterra la selezione (D6): il pane task non si muove, quindi la
  // sessione appena assegnata esce dal gruppo contestuale → si scende alla riga
  // SUCCESSIVA, catturata PRIMA della riscrittura (dopo, la riga non c'è più).
  // Due eccezioni in cui invece resta dov'è, perché non sparisce affatto: una
  // pinnata (esente dal contesto) e un'assegnazione al parent già selezionato.
  function assignSession(sid: string, target: string | null) {
    const stays = model.pinned.has(sid) || target === model.selectedTaskId;
    const next = stays ? sid : neighborId(model.sessionRows, sid);
    appendTaskBinding(cwd, sid, target ?? '');
    model.reloadSessions();
    model.setSelSessionId(next);
    setNote(
      target
        ? `A ${sid.slice(0, 8)} → ${target} · vale dal prossimo ⏎ resume (titolo tab invariato)`
        : `A ${sid.slice(0, 8)} → spot · binding rimosso`,
    );
  }

  // T28 — fork della sessione selezionata. Vive solo sul pane sessioni: il fork
  // ha per oggetto una conversazione, e senza focus lì non ce n'è una
  // selezionata su cui agire.
  function forkSession() {
    if (model.focus !== 'sessions') {
      setNote('f → fork: seleziona una sessione (→ per il pane)');
      return;
    }
    const s = model.selSessionObj;
    if (!s) {
      setNote(
        model.selSessionId
          ? 'f → pin stale: niente da forkare'
          : 'f → nessuna sessione da forkare',
      );
      return;
    }
    // L'id del ramo nasce qui, prima dello spawn: pinnandolo posso scrivere
    // subito binding e lineage. Il binding task si eredita dall'origine (un ramo
    // appartiene alla stessa task), il lineage registra la provenienza che il
    // transcript non porta.
    const newId = randomUUID();
    const bound = model.bindings.get(s.sessionId) ?? null;
    appendSessionRecord(cwd, {
      sessionId: newId,
      ...(bound ? { taskId: bound } : {}),
      forkOf: s.sessionId,
    });
    const spawned = spawnDeckFork(bound, cwd, s.sessionId, newId);
    spawned.child.on('error', () => setNote(`⚠ fork fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  // T50 — pin/unpin della conversazione selezionata, gemella di `f`. Vale anche
  // su una pinnata STALE (l'unico modo di spinnarla). Scrive il sidecar e
  // ricarica subito, senza attendere il tick del poll.
  function togglePin() {
    if (model.focus !== 'sessions') {
      setNote('p → pin: seleziona una sessione (→ per il pane)');
      return;
    }
    const sid = model.selSessionId;
    if (!sid) {
      setNote('p → nessuna sessione da pinnare');
      return;
    }
    const isPinned = model.pinned.has(sid);
    // T133 D12 — il caret si sposta solo quando la riga ESCE dalla lista, e
    // succede nella sola vista `📌` (spinnare toglie la riga dall'insieme che
    // la vista mostra). Altrove pin e unpin non riordinano niente: la riga è
    // in lista perché è figlia del parent, e ci resta al suo posto. Il vicino
    // va calcolato PRIMA di riscrivere il sidecar, quando la riga c'è ancora.
    const landing =
      isPinned && model.sessionViewId === 'pinned' ? neighborId(model.sessionRows, sid) : null;
    appendPin(cwd, sid, !isPinned);
    model.reloadSessions();
    if (landing) model.setSelSessionId(landing);
    setNote(`${isPinned ? 'unpin' : '📌 pin'} ${sid.slice(0, 8)}`);
  }

  /** `t` — terminale a project root, con un titolo che il matcher di compass riconosce. */
  function openTerminal() {
    const title = model.identity ? `🖥️ ${model.identity.name} [term]` : null;
    const child = spawnTerminal(cwd, title);
    child.on('error', () => setNote('⚠ t → ptyxis non lanciabile'));
    setNote(`t → terminale su ${model.projectName}`);
  }

  /** `c` — sessione claude a mani nude, senza task e senza prompt. */
  function openClaude() {
    const spawned = spawnClaudeEmpty(cwd);
    spawned.child.on('error', () => setNote(`⚠ c → spawn claude fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  // Salvataggio ESPLICITO: comporre una vista non tocca il disco, così
  // sperimentare non sporca lo stato persistito.
  function saveCurrentView() {
    try {
      saveView(cwd, model.view);
      setNote(`w → vista salvata (${viewFilePath(cwd)})`);
    } catch {
      setNote('⚠ salvataggio vista fallito');
    }
  }

  /** `1`-`9` — le voci launch del progetto, per indice base-1. */
  function runLaunchAt(input: string) {
    const entry = model.launch[Number(input) - 1];
    if (!entry) {
      setNote(`${input} → nessuna voce launch (${model.launch.length} configurate)`);
      return;
    }
    const child = runLaunch(entry, cwd);
    child.on('error', () => setNote(`⚠ ${entry.label}: '${entry.command}' non lanciabile`));
    setNote(`${input} → ${entry.label} su ${model.projectName}`);
  }

  // Le operazioni sulla task list vivono in `task-ops.ts` e si ricompongono
  // qui, non nel chiamante: chi consuma gli attuatori ne vuole uno solo, e la
  // divisione fra spawn e task è di questo strato, non della schermata.
  // `selectedTaskOr` scende come argomento perché la guardia ha due chiamanti
  // su due lati della frattura — la dipendenza resta in un verso solo.
  const taskOps = useTaskOps({ cwd, tasksPath, tasksDir, model, setNote, selectedTaskOr });

  return {
    ...taskOps,
    selectedTaskOr,
    spawnForTask,
    spawnTaskSession,
    resumeSession,
    writeNote,
    assignSession,
    forkSession,
    togglePin,
    openTerminal,
    openClaude,
    saveCurrentView,
    runLaunchAt,
  };
}

export type DeckActions = ReturnType<typeof useDeckActions>;
