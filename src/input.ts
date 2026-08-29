// Il DISPATCH dell'input: tastiera e mouse, un ramo per tasto, nessun corpo di
// azione.
//
// Esce per ultimo dallo split (T131) e la sua firma è la prova del perché:
// riceve sei oggetti. Estratto per primo ne avrebbe richiesti venticinque —
// `onKey` tocca il focus, la selezione, la vista, le voci launch, l'identità,
// le conversazioni, i pin, i binding, i quattro overlay, la geometria e una
// dozzina di funzioni. Dopo che modello, attuatore e overlay hanno un nome,
// ognuna di quelle cose vive dentro uno di sei oggetti. È la lezione di T104
// ripetuta: l'input non si estrae per primo, si estrae quando ciò che dispaccia
// ha smesso di essere anonimo.
//
// `frame` arriva come VALORE già calcolato, non come closure. Prima di T131 la
// geometria delle liste nasceva seicento righe più in basso di `onListClick` e
// funzionava solo perché la closure di `useInput` legge il binding quando
// l'evento arriva, cioè dopo la fine del render. Con il dispatch in un hook
// chiamato in testa al componente quel binding non esisterebbe ancora, quindi
// il calcolo della geometria è stato hoistato sopra la chiamata. Il
// comportamento non cambia: il mouse esce comunque su `mode !== 'normal'`.
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useApp, useInput, type Key } from 'ink';
import {
  hitRegion,
  isWheel,
  listHit,
  takeMouse,
  wheelDir,
  WHEEL_LINES,
  type MouseEvent,
  type Region,
} from './mouse.js';
import { HINT_ROW, LAUNCH_ROW } from './frame.js';
import { moveSelection } from './session-list.js';
import { captures, scrolls, type CapturingMode, type ScrollingMode } from './input-modes.js';
import { META_ROWS, QUIT_WINDOW_MS, type Mode } from './model.js';
import { TASK_VIEWS, taskView, type SessionViewId, type TaskViewId } from './pane-views.js';
import type { InboxViewId } from './inbox-views.js';
import { loadTaskFileText } from './tasks.js';
import { loadInboxText } from './inbox.js';
import type { Frame } from './frame.js';
import type { DeckActions } from './actions.js';
import type { DeckModel } from './deck-model.js';
import type { useAssignOverlay } from './overlays/assign.js';
import type { useSheetOverlay } from './overlays/sheet.js';
import type { useSearchOverlay } from './overlays/search.js';
import type { useProjectStatus } from './overlays/status.js';
import type { useInboxOverlay } from './overlays/inbox.js';
import type { usePurgeOverlay } from './overlays/purge.js';
import type { useTextModals, useViewModals } from './overlays/modals.js';

// T116 — l'avviso della prima pressione di `^C`. La durata è INTERPOLATA dalla
// finestra, non ricopiata: un numero scritto a mano in un testo che promette un
// comportamento diventa falso il giorno che la costante cambia, e nessuno
// strumento lo segnala. Vive a livello di modulo perché ha due lettori — il ramo
// che la scrive e il timer che la ritira, e quest'ultimo deve riconoscerla.
export const QUIT_NOTE = `⚠ ^C di nuovo entro ${QUIT_WINDOW_MS / 1000}s per chiudere il deck`;

// T21 — il `Key` che accompagna un tasto sintetizzato da un click: nessun
// modificatore, nessun tasto speciale. Deve elencare ogni campo, o i rami che
// leggono `key.ctrl` o `key.tab` riceverebbero `undefined` invece di `false` —
// equivalente nel test di verità, ma non nel tipo.
export const NO_MODIFIERS: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

export type DeckOverlays = {
  assign: ReturnType<typeof useAssignOverlay>;
  sheet: ReturnType<typeof useSheetOverlay>;
  search: ReturnType<typeof useSearchOverlay>;
  status: ReturnType<typeof useProjectStatus>;
  inbox: ReturnType<typeof useInboxOverlay>;
  purge: ReturnType<typeof usePurgeOverlay>;
  view: ReturnType<typeof useViewModals>;
  text: ReturnType<typeof useTextModals>;
};

export function useDeckInput({
  cwd,
  tasksDir,
  mode,
  setMode,
  setNote,
  model,
  actions,
  overlays,
  frame,
  launchRegions,
  indicatorRegions,
}: {
  /** Project root: serve a leggere un file inbox, che `doc-metrics` nomina
   *  relativo alla radice del progetto e non alla docs-root. */
  cwd: string;
  tasksDir: string;
  mode: Mode;
  setMode: (m: Mode) => void;
  /** Il setter vero, non ristretto: il ramo del quit ritira la propria nota solo
   *  se è ancora la propria, e per saperlo deve leggere il valore precedente. */
  setNote: Dispatch<SetStateAction<string>>;
  model: DeckModel;
  actions: DeckActions;
  overlays: DeckOverlays;
  frame: Frame;
  /** Le colonne cliccabili della riga launch (`launchRow` in `frame.ts`). */
  launchRegions: Region[];
  /** T134 — le colonne cliccabili degli indicatori sulla riga legenda
   *  (`indicatorRow` in `frame.ts`). Le loro chiavi portano il prefisso `^`. */
  indicatorRegions: Region[];
}) {
  // T116 — uscita a doppio `^C`. Il timer È lo stato dell'armamento: finché il
  // handle esiste la finestra è aperta, e non serve un secondo stato da tenere
  // in fase con lui. In un `useRef` e non in `useState` perché il ramo di uscita
  // lo legge NELLO STESSO tasto in cui potrebbe averlo scritto — un valore di
  // stato React arriverebbe al render dopo, cioè troppo tardi per decidere.
  const { exit } = useApp();
  const quitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Il timer pendente è un handle vivo del loop di Node: lasciarlo appeso allo
  // smontaggio terrebbe il processo in piedi fino allo scadere della finestra,
  // con lo schermo già restituito al terminale.
  useEffect(
    () => () => {
      if (quitTimer.current) clearTimeout(quitTimer.current);
    },
    [],
  );

  // Il dispatch consulta il CATALOGO (`input-modes.ts`), non l'ordine di una
  // catena di `if`. `MODE_KEYS` è il custode di compilazione: essendo un
  // `Record` su `CapturingMode`, un modo nuovo senza handler non compila.
  // T131 — e ogni voce viene da un overlay, mai da una funzione dichiarata qui:
  // è ciò che `test/input-wiring.test.ts` verifica, dopo che T112 aveva
  // dimostrato che il solo `Record` non lo impedisce.
  const MODE_KEYS: Record<CapturingMode, (input: string, key: Key) => void> = {
    detail: overlays.sheet.onKey,
    status: overlays.status.onKey,
    inbox: overlays.inbox.onKey,
    reader: overlays.search.onReaderKey,
    search: overlays.search.onSearchKey,
    assign: overlays.assign.onKey,
    create: overlays.text.onCreateKey,
    note: overlays.text.onNoteKey,
    sort: overlays.view.onSortKey,
    filter: overlays.view.onFilterKey,
    edit: overlays.text.onEditKey,
    purge: overlays.purge.onKey,
  };

  // T21 (mandata 2) — la ROTELLA, per i soli modi che scorrono un contenuto
  // lungo (`SCROLLING_MODES`). Stessa forma di `MODE_KEYS`: un `Record` sul
  // catalogo, quindi un modo dichiarato scorrevole senza uno scroll da chiamare
  // non compila. Il delta è in righe, col segno del verso.
  const MODE_WHEEL: Record<ScrollingMode, (delta: number) => void> = {
    detail: overlays.sheet.scroll,
    status: overlays.status.scroll,
    inbox: overlays.inbox.scroll,
    reader: overlays.search.scrollReader,
  };

  /**
   * T116 — `^C`: la prima pressione ARMA, la seconda entro la finestra chiude.
   *
   * Prima di questa task `^C` usciva subito, e a chiuderlo era Ink stesso
   * (`exitOnCtrlC`, di default vero) PRIMA che il tasto raggiungesse
   * `useInput`. Spegnere quell'opzione è la condizione perché il ramo esista —
   * ma spegnerla e basta lascerebbe il deck senza NESSUNA uscita da tastiera:
   * il ramo qui sotto è ciò che restituisce quella via, e i due cambi non si
   * possono separare.
   *
   * La prima pressione RIPORTA IN `normal` quando si è dentro un modo
   * capturing. L'avviso vive nella riga di stato, e le tre schermate
   * sostitutive (detail, ricerca, reader) prendono l'intero frame senza
   * renderizzarla: armare restando lì dentro darebbe un deck che sembra
   * ignorare il tasto e che alla pressione successiva sparisce senza aver mai
   * avvertito. Chiudere lo strato è anche coerente con `esc` — `^C` dice
   * «voglio uscire», e il primo passo fuori è la lista.
   */
  function onQuitKey() {
    if (quitTimer.current) {
      clearTimeout(quitTimer.current);
      quitTimer.current = null;
      exit();
      return;
    }
    if (captures(mode)) setMode('normal');
    setNote(QUIT_NOTE);
    quitTimer.current = setTimeout(() => {
      quitTimer.current = null;
      // Solo se l'avviso è ANCORA il proprio: nei 5 secondi una qualunque altra
      // azione può aver scritto in riga di stato, e cancellare quella nota
      // significherebbe far sparire il feedback di un'azione che non c'entra.
      setNote((n) => (n === QUIT_NOTE ? '' : n));
    }, QUIT_WINDOW_MS);
  }

  function onMouse(ev: MouseEvent) {
    // Un click produce due eventi (pressione e rilascio): agire su entrambi
    // spawnerebbe due volte. La rotella arriva come sola pressione, quindi il
    // filtro su `press` la lascia passare e non la dedoppia.
    if (!ev.press) return;
    if (isWheel(ev.button)) {
      // La rotella NON rientra dalla porta della tastiera come il click: nel
      // detail `↑↓` muovono il fuoco fra i campi (T117), non il testo, e il
      // tasto che scorre — `PgUp`/`PgDn` — ha la granularità sbagliata per una
      // tacca. Va quindi allo scroll del modo, in righe. Fuori dai modi
      // scorrevoli è inerte: nelle liste la rotella non muove mai la
      // selezione (D5), e una tacca mentre il deck è sulla lista non deve
      // fare niente.
      if (scrolls(mode)) MODE_WHEEL[mode](wheelDir(ev.button) * WHEEL_LINES);
      return;
    }
    // Il bottone si legge sui due bit bassi, perché gli alti portano i
    // modificatori (shift/meta/ctrl).
    if ((ev.button & 3) !== 0) return;
    // Le superfici esistono solo nella lista: un modo capturing prende il
    // frame intero e a quella riga c'è dell'altro.
    if (mode !== 'normal') return;
    if (ev.row === LAUNCH_ROW) {
      const hit = hitRegion(launchRegions, ev.col);
      // Il click NON chiama l'azione: rientra dalla porta della tastiera col
      // tasto che la superficie annuncia. Un ramo nuovo su `t`/`c`/cifre nasce
      // così già cliccabile, e non esiste un secondo posto in cui il click possa
      // dire una cosa diversa dal tasto che gli sta scritto sopra.
      if (hit) onKey(hit, NO_MODIFIERS);
      return;
    }
    if (ev.row === HINT_ROW) {
      // T134 — stessa porta, con i modificatori: gli indicatori rappresentano
      // combo `ctrl`, e una chiave nuda le farebbe cadere nel ramo delle lettere
      // (`b` non è legata a niente oggi, ma `w` salva la vista).
      const hit = hitRegion(indicatorRegions, ev.col);
      if (hit) onKey(hit.slice(1), { ...NO_MODIFIERS, ctrl: true });
      return;
    }
    onListClick(ev);
  }

  /**
   * T21 (mandata 3) — click su un elemento di lista = SOLO FUOCO (D2): il pane
   * prende il focus e la selezione va sull'elemento, nessuna azione parte. Qui
   * il click non sintetizza un tasto, perché nessun tasto nomina una riga o una
   * vista — `↑↓` e `tab` sono relativi — e chiama i setter che la tastiera
   * usa a sua volta. Un click sulla vista già attiva si limita al focus.
   *
   * ECCEZIONE: la riga già selezionata col pane già a fuoco. Lì un tasto che
   * la nomina ESISTE — `⏎`, che agisce proprio su «la riga selezionata» — e il
   * click lo sintetizza, come le superfici della riga launch: due click sulla
   * stessa riga aprono il detail della task o fanno il resume della
   * conversazione, e ogni caso limite (pin stale, nessuna sessione) resta per
   * costruzione quello del tasto. Le righe meta ne sono fuori: `⏎` su di loro
   * non fa nulla, e un click che lo sintetizzasse produrrebbe solo la nota di
   * scarto di `selectedTaskOr`.
   */
  function onListClick(ev: MouseEvent) {
    if (!frame.listGeometry) return;
    const hit = listHit(ev, frame.listGeometry);
    if (!hit) return;
    if (hit.target === 'view') {
      model.setFocus(hit.pane);
      if (hit.pane === 'tasks') model.selectTaskView(hit.key as TaskViewId);
      else if (hit.pane === 'inbox') model.selectInboxView(hit.key as InboxViewId);
      else model.selectSessionView(hit.key as SessionViewId);
      return;
    }
    if (hit.pane === 'inbox') {
      const f = frame.windowInbox[hit.index];
      if (!f) return;
      if (model.focus === 'inbox' && f.path === model.selInboxPath) {
        onKey('', { ...NO_MODIFIERS, return: true });
        return;
      }
      model.setFocus('inbox');
      model.selectInboxRow(frame.inboxWin.start + hit.index);
      return;
    }
    if (hit.pane === 'tasks') {
      // Le due righe meta hanno indice fisso; le task riportano l'indice di
      // finestra a quello della lista completa, su cui è keyata la selezione.
      const index = hit.index < META_ROWS ? hit.index : frame.taskWin.start + hit.index;
      if (model.focus === 'tasks' && index === model.selIndex && index >= META_ROWS) {
        onKey('', { ...NO_MODIFIERS, return: true });
        return;
      }
      model.setFocus('tasks');
      model.selectTaskRow(index);
    } else {
      const row = frame.windowRows[hit.index];
      if (!row) return;
      if (model.focus === 'sessions' && row.sessionId === model.selSessionId) {
        onKey('', { ...NO_MODIFIERS, return: true });
        return;
      }
      model.setFocus('sessions');
      model.setSelSessionId(row.sessionId);
    }
  }

  function onKey(input: string, key: Key) {
    // T116 — `^C` sta SOPRA il dispatch dei modi, unico tasto a scavalcarlo.
    // Ogni altra combo `ctrl` è un acceleratore, e un acceleratore dentro un
    // modo capturing dev'essere inerte (`input-modes.ts`); questo non è un
    // acceleratore ma la via d'uscita dal processo, e una via d'uscita che
    // funziona solo in una schermata su undici non è una via d'uscita. Non è
    // quindi una deroga di `CTRL_DEROGATIONS` — quelle vivono DENTRO un modo e
    // le gestisce il modo, questa li precede tutti.
    if (key.ctrl && input === 'c') {
      onQuitKey();
      return;
    }

    // Un modo capturing consuma TUTTO — acceleratori globali compresi — e le
    // deroghe se le gestisce da sé (`CTRL_DEROGATIONS`). Da qui in giù si è
    // quindi in `normal`, l'unico modo che cede ai `key.ctrl`.
    if (captures(mode)) {
      MODE_KEYS[mode](input, key);
      return;
    }

    // T52/D1 — il ramo CTRL sta PRIMA di quelli su lettera nuda e li chiude
    // tutti. `CTRL+F` e `f` nudo arrivano con lo STESSO `input` ('f'),
    // distinguibili solo da `key.ctrl`: senza questa precedenza `CTRL+F`
    // cadrebbe nel ramo fork e spawnerebbe una sessione invece di aprire la
    // ricerca. Non è un caso isolato della `f` — `^Q` finirebbe nel quit, `^T`
    // aprirebbe un terminale, `^C` … ogni lettera legata a un'azione ha la sua
    // combo omonima. Chiudere qui l'intera classe è più solido che ricordarsi
    // un `!key.ctrl` su ognuno dei rami, oggi e a ogni tasto aggiunto domani.
    if (key.ctrl) {
      if (input === 'f') {
        setNote('');
        setMode('search');
      } else if (input === 'k') {
        actions.spawnTaskSession('recap', '^K');
      } else if (input === 'p') {
        actions.spawnTaskSession('preflight', '^P');
      } else if (input === 'r') {
        actions.spawnTaskSession('run', '^R');
      } else if (input === 'g') {
        // T121 — GENERA e APRI su due tasti distinti (D2): aprire un recap
        // vecchio deve costare zero, e generare non deve essere un effetto
        // collaterale del guardare. Nessuno dei due è preso né bruciato da Ink,
        // e `^S`/`^Q` sono evitati perché il terminale li intercetta come flow
        // control.
        overlays.status.generate();
      } else if (input === 'o') {
        overlays.status.open();
      } else if (input === 'b') {
        // T134/D8 preflight — `^B` (box/bacheca) scambia i due pane dello slot
        // destro. Non è un modale né una schermata: il pane resta uno dei due
        // riquadri della vista normale, quindi `tab` continua a ciclare le
        // viste DENTRO quello montato e `←→` a spostare il focus fra le colonne.
        model.toggleInboxPane();
      }
      return;
    }

    if (key.tab) {
      // `tab` cicla la VISTA del pane a fuoco, `←→` spostano il focus fra i due
      // pane: il criterio dell'assegnazione è spaziale. Una freccia orizzontale
      // porta con sé una direzione e i pane sono affiancati (task a sinistra,
      // sessioni a destra), quindi il tasto NOMINA il pane invece di limitarsi
      // a scambiarlo; un catalogo ciclico non ha un verso da rispettare, e un
      // tasto solo gli basta. `shift+tab` (backtab, `[Z`) scorre a rovescio — il
      // verso che un tasto singolo non esprime sta nel modificatore, e su cinque
      // voci risparmia quattro pressioni.
      model.cycleView(key.shift ? -1 : 1);
    } else if (key.escape) {
      // T134/D8 preflight — `esc` in vista normale chiude il pane inbox e torna
      // alle sessioni. Resta inerte quando le sessioni sono già montate: `esc`
      // dice «esci da dove sei», e da lì non c'è niente da cui uscire.
      model.closeInboxPane();
    } else if (key.leftArrow || key.rightArrow) {
      // Binding ASSOLUTO, non toggle: `←` porta sempre sui task e `→` sempre
      // sul pane DESTRO, quindi ripremere lo stesso tasto non riporta indietro.
      // È ciò che lo rende spaziale — la direzione indica una destinazione, e
      // con due colonne un toggle sarebbe indistinguibile solo per caso.
      // T134 — «destro» è il pane montato, non `sessions`: il tasto nomina una
      // posizione, e quale dei due la occupi è un'altra decisione (`^B`).
      model.setFocus(key.leftArrow ? 'tasks' : model.rightPane);
    } else if (key.upArrow) {
      if (model.focus === 'tasks') model.moveTaskSel(-1);
      else if (model.focus === 'inbox') model.moveInboxSel(-1);
      else model.setSelSessionId((id) => moveSelection(model.sessionRows, id, -1));
    } else if (key.downArrow) {
      if (model.focus === 'tasks') model.moveTaskSel(1);
      else if (model.focus === 'inbox') model.moveInboxSel(1);
      else model.setSelSessionId((id) => moveSelection(model.sessionRows, id, 1));
    } else if (key.return) {
      if (model.focus === 'inbox') {
        // T134 — `⏎` apre il DETAIL del file, non la sessione: la sessione la
        // apre il `⏎` di dentro. Stessa scala del pane task, dove `⏎` apre il
        // detail e le combo restano per chi sa già cosa vuole — con la
        // differenza che qui non esiste un acceleratore, perché la skill non è
        // una scelta ma una conseguenza della natura del file.
        const f = model.selInbox;
        if (!f) setNote('nessun file inbox selezionato');
        else overlays.inbox.open({ file: f, text: loadInboxText(cwd, f.path) });
      } else if (model.focus === 'tasks') {
        // T66 — ⏎ apre il DETAIL, non più una sessione. Secondo rimappaggio in
        // due task (T56 lo spostò da recap a sessione a mani nude), e la
        // direzione è una sola: da azione singola a punto d'ingresso. Il tasto
        // più battuto non è il posto dove inchiodare una scelta di prompt — le
        // shortcut CTRL restano per chi sa già cosa vuole, `⏎` apre il ventaglio.
        // Lo spawn a mani nude di prima è `open`, cioè `⏎ ⏎` (è il focus iniziale).
        const task = actions.selectedTaskOr('⏎', 'aprire');
        if (task) {
          overlays.sheet.open({
            id: task.id,
            // Il titolo del task file quando c'è (è l'H1, cioè la forma
            // lunga), la riga di tasks.md altrimenti: il detail non deve
            // restare senza intestazione solo perché il file manca.
            title: model.detail?.title || task.desc,
            text: loadTaskFileText(tasksDir, task.id),
          });
        }
      } else {
        // T49 — ⏎ su una sessione = resume in nuova tab. Il binding si rilegge
        // dal sidecar (non dal padre selezionato): vale anche per le spot.
        const s = model.selSessionObj;
        if (!s) {
          setNote(
            model.selSessionId
              ? 'pin stale: transcript non più presente'
              : 'nessuna sessione da riprendere',
          );
        } else {
          actions.resumeSession(s.sessionId);
        }
      }
    } else if (key.delete) {
      // T112/D1 — `CANC` non esiste come tasto distinto in Ink: `\x7f`
      // (Backspace) e `\x1b[3~` (Canc) collassano entrambi su `key.delete` con
      // `input` azzerato, quindi a valle non resta niente da cui distinguerli.
      // Il binding vale per entrambi e si accetta come tale: in `normal` non
      // c'è nessun campo di testo da cui Backspace possa rubare un significato,
      // e ogni modo che ne ha uno è capturing e non vede questo ramo. Il modale
      // di conferma è la rete contro chi usa Backspace come «indietro».
      overlays.purge.open();
    } else if (input === 'C') {
      overlays.text.openCreate();
    } else if (input === 'E') {
      // L'edit ha senso solo su una task reale: le righe meta non ne sono.
      if (!model.selTask) setNote('E → nessuna task selezionata');
      else overlays.text.openEdit(model.selTask);
    } else if (input === 'S') {
      overlays.view.openSort();
    } else if (input === 'F') {
      // T100/D3 — i filtri valgono SOLO sulla vista principale: su `nascoste`
      // riapplicarli non ha senso (quella vista È il loro complemento), su
      // `archiviabili` non li si vuole (è cieca ai filtri per decisione). Stessa
      // forma dell'inerzia di ^K/^P/^R dentro il detail, ma keyed sulla vista
      // invece che sul modo — e come là, l'inerzia lo DICE invece di non fare
      // niente in silenzio.
      if (model.taskViewId !== 'tasks') {
        setNote(
          `F → filtri: solo sulla vista ${TASK_VIEWS[0]!.label(model.taskCounts)} (ora: ${taskView(
            model.taskViewId,
          ).label(model.taskCounts)})`,
        );
      } else {
        overlays.view.openFilter();
      }
    } else if (input === 'f') {
      // T28 — fork della sessione selezionata. Minuscola come `t`/`c` (T39):
      // azione immediata, nessun modale — la `F` maiuscola resta ai filtri.
      actions.forkSession();
    } else if (input === 'p') {
      // T50 — pin/unpin, gemella di `f`: azione immediata sulla riga
      // selezionata del pane sessioni.
      actions.togglePin();
    } else if (input === 'N') {
      // T53 — nota sulla conversazione selezionata. MAIUSCOLA perché apre un
      // modale: nel deck le minuscole sono azioni immediate (`f` fork, `p` pin,
      // `t` term, `c` claude) e le maiuscole aprono un box (`C` create, `E`
      // edit, `S` sort, `F` filtri). Vincolo di focus identico a `p`: vale anche
      // su una pinnata STALE, perché annotare «questa non c'è più, era X» è
      // proprio il caso in cui una nota serve.
      if (model.focus !== 'sessions') {
        setNote('N → titolo: seleziona una sessione (→ per il pane)');
      } else if (!model.selSessionId) {
        setNote('N → nessuna sessione da annotare');
      } else {
        overlays.text.openNote(model.selSessionId);
      }
    } else if (input === 'A') {
      // T57 — assegna la conversazione selezionata a una task. MAIUSCOLA perché
      // apre un modale (convenzione T39), e il modale è obbligatorio: il pane
      // task non può fare da picker, perché spostare la selezione lì cambia il
      // parent e la sessione da assegnare sparisce dalla lista sotto le mani.
      // Vincolo di focus identico a `p`/`N`, e vale anche su una pinnata STALE:
      // il binding è nostro, il transcript è di CC — riassegnare una
      // conversazione il cui transcript non c'è più resta legittimo.
      if (model.focus !== 'sessions') {
        setNote('A → assegna: seleziona una sessione (→ per il pane)');
      } else if (!model.selSessionId) {
        setNote('A → nessuna sessione da assegnare');
      } else {
        overlays.assign.open(model.selSessionId, model.bindings.get(model.selSessionId));
      }
    } else if (input === 't') {
      actions.openTerminal();
    } else if (input === 'c') {
      // Minuscola = azione immediata (convenzione T39), gemella di `t`: entrambe
      // aprono una surface del cappello senza passare da un modale. `C` (create
      // task) resta distinta — stessa lettera, ma la maiuscola è per i modali.
      actions.openClaude();
    } else if (input === 'w') {
      actions.saveCurrentView();
    } else if (input && /^[1-9]$/.test(input)) {
      actions.runLaunchAt(input);
    }
    // Nessun tasto NUDO di uscita: `q` resta libera per un binding futuro, e
    // `esc` in modalità normale è inerte — dentro un overlay continua a
    // chiuderlo, perché quel ramo esce prima di qui. L'unica uscita da tastiera
    // è `^C` battuto due volte (T116, in testa a questo handler); resta poi la
    // chiusura della tab Ptyxis che ospita il processo.
  }

  /**
   * T21 — il MOUSE precede tutto, in ogni modo del deck.
   *
   * Il filtro è incondizionato — anche dentro un campo di testo, anche in un
   * modo che non ha nessuna superficie cliccabile — e non è una precauzione:
   * `useInput` riceve le sequenze SGR come testo (`mouse.ts`, fatto ①), quindi
   * senza filtro un click battuto mentre è aperto il campo del titolo ci
   * scriverebbe dentro `[<0;5;3M`. Un listener raw su stdin non risolverebbe:
   * riceve gli stessi chunk in broadcast e non li sottrae a `useInput`.
   *
   * Il chunk MISTO — un tasto e un click nella stessa scrittura, che arriva
   * come una sola chiamata — si separa a mano: gli eventi vanno al mouse, il
   * testo residuo prosegue verso la tastiera. Solo un chunk di solo mouse
   * chiude qui.
   */
  useInput((raw, key) => {
    const { text, events } = takeMouse(raw);
    for (const ev of events) onMouse(ev);
    if (events.length > 0 && !text) return;
    onKey(text, key);
  });
}
