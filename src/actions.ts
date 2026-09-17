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
import { loadTasks, taskSlug, type Task } from './tasks.js';
import type { CatalogEntry } from './prompt-catalog.js';
import {
  appendNote,
  appendPin,
  appendPriority,
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
  spawnBare,
  spawnCreateTask,
  spawnDeck,
  spawnDeckFork,
  spawnDeckResume,
  spawnTerminal,
  CLAUDE_CMD,
  DECK_RUN,
  type Spawned,
} from './spawn.js';
import { type ModelKind, type PromptKind, type SpawnActionId } from './spawn-catalog.js';
import { resolveSpawnId, type ResolvedSpawn, type SpawnOverrides } from './spawn-config.js';
import { useTaskOps } from './task-ops.js';
import { inboxPrompt, inboxWords, type InboxFile } from './inbox.js';
import { docTargetKind, docWords, type DocRow } from './doc-tree.js';
import { wrapWords } from './wrap-scan.js';
import type { DeckModel } from './deck-model.js';

export function useDeckActions({
  cwd,
  tasksPath,
  tasksDir,
  columns,
  model,
  overrides,
  catalog,
  setNote,
}: {
  cwd: string;
  tasksPath: string;
  tasksDir: string;
  columns: number;
  model: DeckModel;
  /** T161 — gli override di spawn del progetto e il catalogo dati dei prompt: i
   *  due gradini del default di ogni azione. Scendono qui come VALORI e non si
   *  rileggono da disco a ogni spawn — la pagina che li scrive vive nello stesso
   *  processo, e il suo saver ricarica. */
  overrides: SpawnOverrides;
  catalog: Map<string, CatalogEntry>;
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

  /**
   * T161 — la TERNA di un'azione: default del deck ← override di progetto, coi
   * buchi già riempiti.
   *
   * Un punto solo. Prima di questa task ogni sede di chiamata sceglieva da sé —
   * `MODEL_DEFAULT` dentro `drainInbox`, `'sonnet'` dentro `unwrapPath`,
   * `modelFor(catalog, kind)` dentro `spawnTaskSession`, `PROJECT_STATUS_MODEL`
   * dentro `spawnProjectStatus` — e nessuna delle quattro poteva essere
   * indirizzata da una configurazione, perché non esisteva un nome con cui
   * nominarla.
   */
  function spawnDefaults(
    id: SpawnActionId,
    holes: Readonly<Record<string, string>> = {},
  ): ResolvedSpawn {
    return resolveSpawnId(id, overrides, catalog, holes);
  }

  /** I buchi di un'azione su task. Lo slug viene dal NOME del task file, non
   *  dalla descrizione di `tasks.md`: il nome è già dentro l'alfabeto di
   *  `_sane_note` per costruzione — minuscolo, separato da trattini, senza
   *  punteggiatura — mentre la descrizione porta apostrofi e `/` che la riduzione
   *  toglie senza sostituto, saldando le parole. Task file assente → slug vuoto,
   *  e il titolo si spegne invece di ridursi al solo prefisso. */
  function taskHoles(id: string): Record<string, string> {
    return { TASK: id, slug: taskSlug(tasksDir, id) };
  }

  /** La terna di un'azione SU UNA TASK, per chi ha in mano l'id e non i buchi:
   *  il detail. Derivare i buchi dal chiamante sarebbe la seconda copia della
   *  regola, e diverge il giorno che un template ne guadagna uno terzo. */
  function spawnTaskDefaults(id: SpawnActionId, taskId: string): ResolvedSpawn {
    return spawnDefaults(id, taskHoles(taskId));
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
  // T150 — il vuoto si riempie QUI, prima che i due canali si separino: il
  // sidecar (`appendNote`, sotto) e il titolo tab (`--title-note`, dentro
  // `spawnDeck`) devono vedere lo STESSO valore, o le due superfici mostrano
  // nomi diversi per la stessa conversazione. Vale anche sugli acceleratori
  // della lista (^K/^P/^R), che passano di qui con `spawnNote` sul proprio
  // default '' (P1 preflight) — nascono quindi titolati anche loro.
  function spawnForTask(
    id: string,
    modelKind: ModelKind,
    spawnNote = '',
    prompt = '',
    priority = false,
  ) {
    const sid = randomUUID();
    const note = spawnNote;
    appendTaskBinding(cwd, sid, id);
    if (note) appendNote(cwd, sid, note);
    // T158 — la marca si appende NELLO STESSO momento del binding, prima che la
    // tab esista: il `sessionId` è già noto (lo pinna `deck-run`), quindi il primo
    // cambio di stato della conversazione trova la marca già su disco. Scriverla
    // dopo lo spawn sarebbe una corsa contro il primo `Stop`.
    //
    // Solo il ramo acceso scrive: un `priority:false` allo spawn di ogni sessione
    // riempirebbe il sidecar di smarcature di conversazioni mai marcate.
    if (priority) appendPriority(cwd, sid, true);
    const spawned = spawnDeck(id, cwd, sid, modelKind, note, prompt);
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
    if (!task) return;
    // T161 — stessa risoluzione del detail, sullo stesso id di catalogo: senza,
    // `^R` e l'azione `run` del detail partirebbero su due terne diverse per lo
    // stesso comando. Il kind NON si specializza qui: gli acceleratori leggono
    // solo `tasks.md`, dove il `Size` non c'è, quindi `recap` resta il
    // dispatcher — che è la riga di catalogo giusta per chi non sa se la task è
    // un cappello.
    const d = spawnDefaults(kind, taskHoles(task.id));
    spawnForTask(task.id, d.model, d.title ?? '', d.prompt ?? '');
  }

  // T49 — resume di una conversazione in una nuova tab. Unico punto: lo chiamano
  // il `⏎` della lista sessioni e quello sulla riga-sessione della ricerca, che
  // devono restare la stessa azione.
  // T148 — il modello lo decide il CHIAMANTE, non questa funzione: la lista
  // principale passa il selettore della preview (`model.resumeModel`), la
  // ricerca passa il modello ereditato dalla sessione senza superficie di
  // scelta (D1 preflight). I due chiamanti restano la stessa azione perché è
  // lo spawn a essere identico, non la sorgente del valore.
  function resumeSession(sessionId: string, modelKind: ModelKind) {
    const bound = model.bindings.get(sessionId) ?? null;
    const spawned = spawnDeckResume(
      bound,
      cwd,
      sessionId,
      modelKind,
      model.sessionNotes.get(sessionId),
    );
    spawned.child.on('error', () => setNote(`⚠ resume fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  /** T148/T154(P2,P3) — `m` col bersaglio RESUME: `input.ts` instrada qui solo
   *  quando il focus è sulle sessioni E una riga è selezionata (P2), quindi il
   *  solo caso residuo è il pin STALE — l'id c'è ma il transcript no, quindi
   *  non c'è un bottone da cambiare (P3): resta sul selettore di resume con la
   *  propria nota, invece di spostare di soppiatto il selettore della nuda
   *  mentre il caret è su una riga sessione.
   *
   *  La nota sul SUCCESSO nomina bersaglio e valore (`m → resume: opus`, P2):
   *  rovescia la scelta di T148 di non scriverne nessuna, perché lì `m` aveva
   *  un bersaglio solo e il bottone che cambiava era l'unico a schermo — da
   *  T154 i due selettori possono stare a schermo insieme. */
  function cycleResumeModel() {
    if (!model.selSessionObj) {
      setNote('m → pin stale: nessun modello da cambiare');
      return;
    }
    const next = model.cycleResumeModel();
    setNote(`m → resume: ${next}`);
  }

  /** T154 — `m` col bersaglio NUDA (`c`): il selettore che governa sta sempre
   *  a schermo sulla riga launch, quindi il tasto non è mai inerte qui. */
  function cycleBareModel() {
    const next = model.cycleBareModel();
    setNote(`m → nuda: ${next}`);
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
    // T148 — il fork è l'altra continuità che condivide la stessa riga
    // selezionata: porta via lo stesso `model.resumeModel` del resume, non un
    // default fisso (P2 preflight).
    const spawned = spawnDeckFork(bound, cwd, s.sessionId, newId, model.resumeModel);
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

  /**
   * T158 — `a`: marca/smarca la conversazione selezionata come PRIORITARIA.
   *
   * Gemella di `togglePin` nella forma (azione immediata, scrive il sidecar,
   * ricarica subito) ma non nell'effetto: la marca non sposta e non filtra
   * niente, quindi non c'è nessun vicino su cui atterrare — la riga resta dov'è
   * e cambia solo il glifo.
   *
   * Vale anche su una pinnata STALE: il transcript non c'è più, ma la marca è un
   * attributo del `sessionId` e non del transcript, e l'unico posto da cui
   * toglierla resta quella riga.
   */
  function togglePriority() {
    if (model.focus !== 'sessions') {
      setNote('a → priorità: seleziona una sessione (→ per il pane)');
      return;
    }
    const sid = model.selSessionId;
    if (!sid) {
      setNote('a → nessuna sessione da marcare');
      return;
    }
    const on = model.sessionPriority.has(sid);
    appendPriority(cwd, sid, !on);
    model.reloadSessions();
    setNote(`${on ? 'priorità via' : '🚨 prioritaria'} ${sid.slice(0, 8)}`);
  }

  /** `t` — terminale a project root, con un titolo che il matcher di compass riconosce. */
  function openTerminal() {
    const title = model.identity ? `🖥️ ${model.identity.name} [term]` : null;
    const child = spawnTerminal(cwd, title);
    child.on('error', () => setNote('⚠ t → ptyxis non lanciabile'));
    setNote(`t → terminale su ${model.projectName}`);
  }

  /**
   * T134 — apre la sessione PRESIDIATA che drena un file inbox.
   *
   * Il prompt arriva già composto dall'overlay (`inboxPrompt`), che è l'unico
   * posto in cui vive la mappa natura → skill: derivarlo qui una seconda volta
   * darebbe due tabelle capaci di divergere, e la seconda si scoprirebbe solo
   * il giorno in cui una natura nuova apre la skill sbagliata.
   *
   * Sessione NUDA: il drain lavora sulla doc, non sulla task (D10 preflight).
   * Modello e titolo vengono dalla riga `drain` del catalogo delle azioni
   * (T161), non più da un letterale scritto qui; il PROMPT resta del chiamante,
   * perché la skill è una funzione della natura del file e quella mappa vive in
   * un posto solo (`inboxPrompt`, `src/inbox.ts`).
   *
   * Il titolo interpola il basename del file, e serve un `sessionId` pinnato
   * per scriverlo nel sidecar — senza, la nota non avrebbe una chiave e la riga
   * in lista resterebbe nuda mentre la tab porta un nome. Le due scritture
   * stanno qui accanto per la stessa ragione di `spawnForTask`: il nome che le
   * due superfici mostrano nasce da un valore solo.
   */
  function drainInbox(file: InboxFile, prompt: string) {
    const sid = randomUUID();
    const d = spawnDefaults('drain', { file: inboxWords(file) });
    const title = d.title ?? '';
    if (title) appendNote(cwd, sid, title);
    const spawned = spawnBare(cwd, prompt, d.model, sid, title);
    spawned.child.on('error', () => setNote(`⚠ drain ${file.basename} fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  /**
   * T160 — la terna della riga `rebalance` sul bersaglio selezionato.
   *
   * Separata dallo spawn perché ha due chiamanti che la vogliono in due momenti
   * diversi: la schermata, che MOSTRA il comando in fondo prima che `⏎` lo
   * lanci, e l'attuatore, che lo lancia. Comporlo due volte darebbe due comandi
   * capaci di divergere — e quello mostrato è la sola cosa che rende `⏎` una
   * scelta invece di un salto nel buio.
   *
   * P9 — su una riga SENZA FLAG il prompt è vuoto, e il deck non spawna. Il
   * flag resta un invito a guardare e non un ordine, quindi la skill su un
   * bersaglio in equilibrio produrrebbe un report e nient'altro: aprire una
   * conversazione per farselo dire è un giro di modello pagato per niente. La
   * ragione viaggia accanto al vuoto (`hint`), o la riga muta si leggerebbe come
   * un comando che non si è riusciti a comporre.
   */
  function rebalanceSpawn(row: DocRow): { prompt: string; hint: string } {
    // La coda inbox PRIMA dei flag: un file inbox porta sempre il suo flag, e
    // senza questo ramo cadrebbe nel ramo del rebalance con l'aria di essere un
    // bersaglio legittimo. La skill è la stessa che offre il pane di destra —
    // il prompt lo compone `inboxPrompt`, unico posto in cui vive la mappa
    // natura → skill, esattamente come per il `⏎` del pane inbox.
    const kind = docTargetKind(row, model.docsRoot);
    if (kind !== 'doc') {
      const f = kind === 'inbox-file' ? inboxFileAt(row.path) : null;
      if (f) return { prompt: inboxPrompt(f), hint: '' };
      return {
        prompt: '',
        hint:
          kind === 'inbox-dir'
            ? `${row.path} è la coda inbox: si drena un file alla volta, non si riorganizza`
            : `${row.path} è un file inbox: la sua natura non è ancora stata misurata, aprilo dal pane di destra`,
      };
    }
    if (row.flags.length === 0) {
      return {
        prompt: '',
        hint: `${row.path} non porta flag: rebalance-doc non ha niente da fare qui`,
      };
    }
    const d = spawnDefaults('rebalance', { target: row.path, words: docWords(row.path) });
    return { prompt: d.prompt ?? '', hint: '' };
  }

  /** Il file della coda inbox che sta dietro una riga dell'albero doc. Le due
   *  misure sono due scan distinti dello stesso script: l'albero conosce il
   *  path, la natura la sa solo la coda, e il prompt di drain è una funzione
   *  della natura. */
  function inboxFileAt(path: string): InboxFile | null {
    return model.inboxAll.find((f) => f.path === path) ?? null;
  }

  /**
   * T160 — apre la sessione che RIORGANIZZA la topologia attorno a un bersaglio.
   *
   * Gemella di `drainInbox` e `unwrapPath` nella forma: sessione NUDA (il
   * rebalance lavora sulla doc, non su una task), `sessionId` pinnato per poter
   * scrivere la nota nel sidecar, titolo dalla riga di catalogo.
   *
   * Il modello della riga è `sonnet` ed è una cella FISSA, non una preferenza:
   * `rebalance-doc` dichiara `model: sonnet` nel frontmatter e quel campo
   * ri-timbra il modello della sessione qualunque `--model` arrivi dallo spawn.
   * Passarlo comunque nell'argv resta giusto — lo spawn è deterministico e la
   * riga di stato mostra il comando vero — ma configurarlo sarebbe una cella che
   * mente.
   */
  function rebalanceDoc(row: DocRow, prompt: string) {
    if (!prompt) return;
    // Il bersaglio inbox prende la terna della riga `drain`, non quella di
    // `rebalance`: il prompt da solo non basterebbe — modello e titolo della tab
    // verrebbero comunque dalla riga sbagliata, e la conversazione si
    // chiamerebbe «rebalance» mentre esegue un drain.
    const f = inboxFileAt(row.path);
    if (f) {
      drainInbox(f, prompt);
      return;
    }
    const sid = randomUUID();
    const d = spawnDefaults('rebalance', { target: row.path, words: docWords(row.path) });
    const title = d.title ?? '';
    if (title) appendNote(cwd, sid, title);
    const spawned = spawnBare(cwd, prompt, d.model, sid, title);
    spawned.child.on('error', () => setNote(`⚠ rebalance ${row.path} fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  /**
   * T134 — apre la sessione che SROTOLA l'hard-wrap di un path.
   *
   * Terna intera dalla riga `unwrap` del catalogo (T161): il modello, il titolo
   * e anche il PROMPT, che fino a T134 era cablato in `wrap-scan.ts`. A
   * differenza del drain qui un template unico basta — la skill è sempre la
   * stessa e l'unico buco è il `{path}`.
   *
   * Il default resta `sonnet` e non il modello di default del deck (D9): lo
   * srotolamento è una passata meccanica con un verificatore deterministico
   * dietro (`md-wrap --apply` confronta le due versioni normalizzate
   * `\s+ → spazio` e rimette indietro il file se differiscono), quindi il
   * giudizio richiesto al modello è leggere un diff e decidere se committarlo —
   * non progettare niente.
   */
  function unwrapPath(path: string) {
    const sid = randomUUID();
    const d = spawnDefaults('unwrap', { path: wrapWords(path) });
    const title = d.title ?? '';
    if (title) appendNote(cwd, sid, title);
    const spawned = spawnBare(cwd, d.prompt ?? '', d.model, sid, title);
    spawned.child.on('error', () => setNote(`⚠ srotolamento ${path} fallito (${DECK_RUN})`));
    noteSpawn(spawned);
  }

  /** `c` — sessione claude a mani nude, senza task e senza prompt. T154 — il
   *  modello è quello del selettore proprio della nuda (`model.bareModel`),
   *  passato SEMPRE nell'argv anche sul default. */
  function openClaude() {
    const spawned = spawnClaudeEmpty(cwd, model.bareModel);
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
    spawnDefaults,
    spawnTaskDefaults,
    spawnForTask,
    spawnTaskSession,
    resumeSession,
    cycleResumeModel,
    cycleBareModel,
    writeNote,
    assignSession,
    forkSession,
    togglePin,
    togglePriority,
    drainInbox,
    rebalanceSpawn,
    rebalanceDoc,
    unwrapPath,
    openTerminal,
    openClaude,
    saveCurrentView,
    runLaunchAt,
  };
}

export type DeckActions = ReturnType<typeof useDeckActions>;
