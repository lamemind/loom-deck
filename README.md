# loom-deck

Deck TUI (Ink) **per-progetto** della famiglia [loom](https://github.com/lamemind/loom-works).

Legge il `tasks.md` del progetto e, con un tasto (poi un click), **spawna** una tab [Ptyxis](https://gitlab.gnome.org/chergert/ptyxis) che avvia una sessione Claude Code già bound alla task via `LOOM_TASK`.

```
↑↓ scegli la task  →  ⏎  →  tab CC di fianco  →  LOOM_TASK bound
```

`⏎` apre il **detail** della task — task file scrollabile più una barra azioni — e da lì si sceglie con quale prompt entrare; `^K`/`^P`/`^R` restano acceleratori per chi lo sa già (vedi [I cinque modi di entrare in una task](#i-cinque-modi-di-entrare-in-una-task)).

Entrambi i prefissi del contratto loom entrano in lista: **`T`** (code task) e **`D`** (doc task). Il trattamento è identico ovunque tranne che su `^R`, dove il prompt dispatcha sulla skill di esecuzione della rispettiva famiglia.

## Ruolo nella famiglia loom

`loom-deck` è un **client** con runtime proprio (TUI Ink) che **consuma** il contratto definito da `loom-works-plugin` (formato `tasks.md`, variabile `LOOM_TASK`) — non lo ridefinisce. Divisione dei ruoli con Compass:

| | scope | ruolo | domanda |
|---|---|---|---|
| **Compass** (GNOME) | globale, cross-desktop | radar, stato live, focus/jump | "dove sono?" |
| **loom-deck** (TUI) | per-progetto | attuatore locale, spawna task | "cosa faccio qui?" |

## Architettura di processo

Il deck è **UN processo Node**: spawna ma **non contiene** le sessioni CC — le possiede Ptyxis. Chiudere il deck non uccide le sessioni. La tab nasce nella window *attiva*
(quella col focus = il deck) → desktop isolation "gratis".

### La riga di stato dice il comando, non una parafrasi

Ogni spawn di una sessione Claude — task (`⏎`/`^K`/`^P`/`^R`), resume, fork, sessione nuda (`c`) — scrive nella riga di stato in fondo al frame il **comando esatto** che gira dentro la tab, cioè l'invocazione `claude` vera con le env che la legano a task e progetto:

```
$ LOOM_TASK=T115 claude --name '🧵 loom-works · T115 «parser»' --permission-mode auto --model opus --session-id 9f3a… '/loom-works:run-task T115'
```

Task, `sessionId`, modello, titolo e prompt iniziale sono già lì dentro: una nota che li elencasse a parole li direbbe una seconda volta, in una grafia che non si può ricopiare in un terminale. Quello che si perde è il **tasto premuto**, che è ciò che hai appena fatto tu e non ciò che il deck ha fatto per te.

**Il comando non lo compone il deck**, e non potrebbe senza riscrivere le stesse regole due volte: catalogo dei prompt, quoting, permission mode, profilo di stato e titolo vivono in `deck-run`. Il primitive lo **annuncia** su stdout prima di `exec`, con una riga

```
LOOM_DECK_INTAB <comando>
```

e il deck la legge da lì. L'annuncio è utile anche a chi lancia `deck-run` a mano: dice cosa sta per partire, mentre le diagnostiche restano su stderr.

Ne discende che il comando in-tab arriva **asincrono**, qualche millisecondo dopo lo spawn. Nel frattempo la riga mostra il comando `deck-run` — che resta l'unica cosa visibile quando l'annuncio non arriva affatto (argomenti rifiutati, `deck-run` morto prima dell'exec), ed è anche il comando da ripetere a mano per vedere l'errore.

Su un terminale stretto il taglio è **al mezzo** (`…`), non dalla coda: in un comando di spawn è la coda a distinguere un'invocazione dall'altra, e tagliare da lì la butterebbe via per intero.

Restano fuori gli spawn che non aprono una sessione Claude interattiva: terminale (`t`), voci `launch` (`1`-`9`) e le skill headless (`C` create-task, `CANC` clean-tasks), dove la riga di stato serve a riportare l'**esito** di un'operazione asincrona.

## Stato

Bootstrap + spike ① + **TUI ③** funzionante (legge `tasks.md`, `⏎` apre il detail). Roadmap:

```
① spike spawn-tab + LOOM_TASK   ✅ scripts/deck-run
② gradino $LOOM_TASK nelle skill loom-works
③ TUI Ink sopra (lista tasks.md, ↑↓/⏎ → chiama ①)   ✅ src/
④ mouse opzionale (SGR enable+parse+hit-test)
⑤ azioni extra (start/preflight/checkpoint/merge dal deck)
```

## Standard shortcut

Regola unica, senza eccezioni — pensata per reggere l'aggiunta di nuove azioni senza collisioni:

| Tasto | Semantica | Note |
|---|---|---|
| `↑` `↓` | naviga nella lista | |
| `←` `→` | cambia pane | assoluto, non toggle: `←` = Tasks, `→` = Sessions — la direzione nomina il pane, che è affiancato |
| `tab` | cambia **vista** del pane a fuoco | ciclico (`shift+tab` indietro); il catalogo è l'header stesso |
| `⏎` | azione primaria del pane | Tasks → apre il **detail** della task selezionata · Sessions → riprende (`claude --resume`) la sessione selezionata |
| **MAIUSCOLA** | **apre un modale** | cattura tutti i tasti; `esc` annulla, non esce |
| minuscola | azione immediata, one-shot | |
| `CTRL`+lettera | idiomi universali, toggle dentro i modali di testo, varianti di un'azione | `^F` = find, come ovunque · `^K`/`^P`/`^R` = spawn con un altro prompt · `^G`/`^O` = genera/apri il project status |
| `1`…`9` | voce `launch` n-esima del progetto | da `.claude/loom-works.json` |
| `esc` | chiude l'overlay aperto | in modalità normale è inerte: **nessuna lettera chiude il deck** |
| `^C` `^C` | chiude il deck | la prima pressione avverte in riga di stato, la seconda entro **5 secondi** esce; passata la finestra si riparte dall'avviso. Da dentro un modale il primo `^C` riporta alla lista — l'avviso vive nella riga di stato, che le schermate a pieno frame non disegnano |

`CTRL` è il terzo livello, aggiunto quando è arrivata la ricerca. Serve perché un modale con **campi di testo** mangia ogni lettera nuda: là dentro nessun comando può essere una lettera semplice. `CTRL+X` e `x` nudo condividono lo stesso `input` e si distinguono solo per `key.ctrl`, quindi in modalità normale il ramo `CTRL` è valutato **per primo** e chiude l'intera classe — senza, `CTRL+F` cadrebbe nel ramo `f` e forkerebbe una sessione invece di cercare.

`^C` è l'unica combo fuori da questo schema: non sta nel ramo `CTRL` di `normal` ma **sopra** il dispatch dei modi, perché non è un acceleratore — è la via d'uscita dal processo, e una via d'uscita che funziona in una schermata su undici non è una via d'uscita.

Assegnazioni correnti:

| | Tasto | Cosa fa |
|---|---|---|
| modale | `C` | nuova task (create-task inline) |
| modale | `E` | edit priorità/stato della task selezionata (salva + commit) |
| modale | `S` | sort chain |
| modale | `F` | filtri |
| modale | `^F` | **ricerca full-text** nelle conversazioni del progetto |
| modale | `⏎` | **detail** della task selezionata: task file scrollabile + area di compilazione a quattro righe |
| modale | `CANC` | **elimina** — la task selezionata; su una riga meta della vista `archiviabili`, l'intero insieme |
| modale | `^O` | apre il **project status** in cache (viewer fullscreen) |
| immediata | `^G` | **genera** il project status (skill headless, dura minuti) |
| immediata | `^K` | spawna la task selezionata col prompt di **recap** |
| immediata | `^P` | spawna la task selezionata sul **preflight** |
| immediata | `^R` | spawna la task selezionata in **esecuzione** |
| immediata | `f` | **forka** la sessione selezionata (solo col focus sul pane Sessions) |
| immediata | `t` 💻 | terminale @project-root (surface standard launch) |
| immediata | `c` 🤖 | sessione Claude **nuda**: nessuna task, nessun prompt iniziale |
| immediata | `w` | salva la vista corrente su disco |
| launch | `1`…`9` | esegue il `command` della voce, con `cwd` = project root |

Il footer è **due righe con due nature diverse**:

```
⏎ detail · ^K/^P/^R spawn · ^G genera status · ^O apri status · ^F cerca · C nuova · E edit · S sort · F filtri · w salva
t 💻 · c 🤖 · 1 📝 codium · 2 ☕ idea
```

- **tasti** — cosa puoi fare *qui e ora*. Solo le voci attive: quelle contestuali compaiono quando il pane a fuoco le rende possibili e altrimenti spariscono,
  invece di mostrarsi inerti. Fuori navigazione (`↑↓` `←→`) e indicatore `focus:` — la prima è universale in qualunque TUI, il pane a fuoco si vede già dall'evidenziazione.
  Nessuna voce di uscita: `^C` non ha bisogno di essere annunciato — è il tasto che si prova per primo, e la prima pressione risponde da sé con l'avviso.
- **surface** — *dove* puoi aprire qualcosa: prima le due built-in (`t`/`c`), poi le voci `launch` del progetto. Stanno insieme perché hanno la stessa natura — fire-once, `cwd` = project root, nessuno stato — e differiscono solo per essere universali invece che custom.

L'indice da solo è opaco (le `launch` sono custom per-progetto, senza una lettera fissa per app), quindi la riga espone la mappa e non il conteggio. Se non entrano in larghezza, si ferma a voci intere e mostra il contatore di quelle fuori riga — mai un troncamento silenzioso; le celle delle due built-in sono riservate a monte, o le voci sfonderebbero il box di quel tanto. Il cap a `9` è imposto dai tasti-cifra, non dallo schema: un progetto può dichiarare più di 9 voci, quelle oltre la nona sono configurate ma non raggiungibili (e la riga lo dice).

Le emoji sono quelle del menu compass. Per il terminale compass usa 🖥️, che nel frame Ink non sopravvive: `sanitize` lo sostituisce perché VTE lo disegna largo 1 mentre `string-width` ne conta 2 (invariante ① di `src/width.ts`) — 💻 è il gemello concorde.

`t` e `c` sono gemelle: entrambe aprono una surface del cappello nella stessa finestra Ptyxis, senza passare da un modale. `c` (minuscola, azione) e `C` (maiuscola, modale create-task) restano distinte per la regola sopra — così come `f` (fork) e `F` (filtri).

### `CANC` — eliminare task

Il deck **ordina** la potatura, non la esegue: la fa `loom-works:clean-tasks`, invocato da un processo Claude headless. Nessun `git rm` e nessuna riscrittura di `tasks.md` vivono qui — quella sequenza (task file + folder dot-prefixed + riga in `tasks.md`, un commit atomico per task, symlink `current-task.md` rimosso, righe orfane riconciliate) è implementata una volta sola, e averne una seconda darebbe due rimozioni capaci di divergere.

Lo **stesso tasto ha due bersagli di taglia diversa**, e a discriminarli è la **selezione prima della vista**:

|  | riga meta (`≡ tutte` / `○ spot`) | riga task |
|---|---|---|
| vista `archiviabili` | **tutte** le task che la vista mostra | quella task |
| qualunque altra vista | rifiuto, con la nota che dice quale riga meta è | quella task |

Con una riga task sotto il caret il tasto tocca **sempre e solo quella task**. Il bulk richiede quindi di essere usciti da ogni riga task, cioè un movimento in più: l'azione di massa non è mai a un tasto di distanza da quella singola, e non la si preme guardando una task evidenziata credendo che il bersaglio sia lei. Il costo è che la regola non si legge dallo schermo — la legenda la dice (`CANC elimina` contro `CANC elimina tutte`), ed è il solo canale che la rende visibile prima della conferma.

Da qui la forma della conferma: nomina il bersaglio (quante e quali ID, troncando con `+N`) invece dell'azione, e dice l'**effetto sul disco** — mai «archiviare», che prometterebbe uno spostamento in un archivio che non esiste. I commit restano **locali**: `clean-tasks` non pusha, quindi finché nessuno lo fa un altro worktree continua a vedere le task potate.

- **`CANC` è anche Backspace.** Ink battezza `delete` sia `\x7f` sia `\x1b[3~` e azzera `input`: a valle non resta nulla da cui distinguerli. Il binding vive nel modo `normal`, che non ha campi di testo, e ogni modo che ne ha uno cattura l'input e non vede quel ramo — la conferma è la rete contro chi usa Backspace come «indietro».
- **Le folder con file non tracciati si scartano a monte.** `clean-tasks.sh` esce 2 appena trova una task folder con file che `git rm` non rimuove, e lo fa *prima* di potare qualsiasi cosa: in un bulk su N target, uno solo non conforme annullerebbe il lavoro sugli altri N-1. Il deck replica il predicato del gate (`git ls-files -o`), marca quelle task con `⚠` nella vista `archiviabili` e le esclude dal bulk — nominandole nella conferma, perché promettere 7 e farne 5 sarebbe una bugia invisibile.
- **Sulla singola task sporca la conferma ha tre uscite**: `⏎` su `keep` (snapshot in git prima del purge), `⏎` su `purge` (file persi), `esc`. La scelta viaggia come `--ignored-files` ed è rara: nasconderla dentro un binario `⏎`/`esc` la mascherebbe.
- **`CANC` col focus sul pane Sessions è inerte e lo dice**, come `F` fuori dalla vista principale.

### I cinque modi di entrare in una task

Sulla task selezionata (focus sul pane Tasks) si apre una sessione **bound**: `LOOM_TASK` iniettata, `sessionId` pinnato, binding scritto nel sidecar. Fra i modi cambia **solo il prompt iniziale**.

| Azione (detail) | Tasto diretto | Prompt |
|---|---|---|
| `open` | — | nessuno — il contesto lo carica l'hook `SessionStart`, il primo messaggio lo scrivi tu |
| `status` | `^K` | `recap stato task <id>` — prompt diretto, nessuna skill |
| `preflight` | `^P` | `/loom-works:preflight-task <id>` |
| `run` | `^R` | `/loom-works:run-task <id>`, oppure `/loom-works:run-doc <id>` se l'id è una `D` |
| `checkpoint` | — | `/loom-works:checkpoint-task <id>` |

Il prompt iniziale è la scelta di **chi apre**, non una proprietà della task: lo stesso task file si apre per leggerne lo stato, per congelarne le decisioni, per eseguirlo o per entrarci a mani nude — e l'azione scelta *è* quell'intento.

Le due superfici sono complementari, non alternative. `⏎` apre il **detail** e lì si legge la Description *mentre* si decide: è il caso normale, perché la domanda «quale azione?» quasi sempre si risponde leggendo la task. I tre `CTRL` saltano il passaggio per chi lo sa già. Dentro il detail sono inerti — i bottoni sono lì.

Col focus sul pane Sessions né `⏎` né i `CTRL` spawnano: l'oggetto dell'azione è la task selezionata, e senza quel pane a fuoco non ce n'è una (il deck lo dice nella riga di nota, invece di aprire qualcosa a caso).

### `⏎` — il detail della task

Overlay fullscreen a due zone: il **task file per intero**, scrollabile con `PgUp`/`PgDn`, e sotto un'**area di compilazione** a quattro righe — i quattro parametri con cui la sessione sta per nascere.

| Riga | Cosa | Come si cambia |
|---|---|---|
| `azione` | `open` `preflight` `run` `status` `checkpoint` | `←→`, oppure l'iniziale: `o` `p` `r` `s` `c` |
| `prompt` | il testo che riceverà la sessione | si scrive; parte pre-riempito dall'azione scelta |
| `modello` | `fable` `opus` `sonnet` `haiku` | `←→` |
| `titolo` | il nome della conversazione, in lista e nella tab | si scrive |

`↑↓` spostano il fuoco fra le righe, `⏎` spawna coi quattro valori correnti, `esc` chiude lasciando la lista con la stessa selezione. Le righe di testo ricevono i caratteri **solo quando sono in fuoco**: su `azione` una lettera che non è un'iniziale resta inerte invece di finire in un campo.

`↑↓` sono quindi una risorsa contesa, e vanno al fuoco: la lettura del task file resta su `PgUp`/`PgDn`, cioè una granularità sola invece di due. È il prezzo di avere `↑↓` nel loro significato di sempre su una schermata che ospita insieme un documento e dei campi.

**Il campo `prompt` è quello che parte davvero**, non un'anteprima: modificarlo cambia il messaggio che la sessione riceve. Cambiare azione lo riscrive col default della nuova — col fuoco per riga il cambio accidentale non esiste (`←→` toccano l'azione solo dalla sua riga), quindi non c'è nessuna modifica da proteggere.

La grammatica delle righe è la **stessa** del modale edit (`SHIFT+E`) e sta in `src/fields.ts`: descrittore delle righe, fuoco, caret, `^A`/`^E`/`^D`/`^U`. Finché era scritta due volte andava tenuta allineata a mano a ogni tasto aggiunto. `Home`/`End` non ci sono e non possono esserci: `useInput` non le espone — verificato su otto sequenze diverse, arrivano tutte come input vuoto senza flag — da cui `^A`/`^E`.

Le azioni non sono un catalogo nuovo: chiamano lo **stesso** percorso di spawn dei tasti diretti. Una superficie in più, zero percorsi di spawn in più. Sono bottoni affiancati e non voci di un menu verticale perché è la forma che sopravvive all'arrivo del mouse: un rettangolo ha già coordinate e area cliccabile, una lista di voci andrebbe rifatta.

Il **testo** dei prompt vive in `scripts/prompt-catalog`, un file dati sibling di `deck-run` che entrambi leggono a runtime: il deck per pre-riempire il campo, `deck-run` per comporre il comando in-tab. Come codice posseduto da un lato solo il deck avrebbe dovuto riscriverlo per mostrarlo, e le due copie divergerebbero alla prima voce aggiunta da una parte sola. Un prompt modificato a mano viaggia poi letterale (`--prompt`), perché a quel punto nessun `--prompt-kind` lo descrive più.

### `f` — forkare una conversazione

Il fork rama la sessione selezionata: `claude --resume <origine> --fork-session` apre un **sessionId nuovo** con il transcript copiato, lasciando l'origine intatta. Serve quando vuoi ripartire da un certo stato senza perdere il ramo originale — e siccome i due id sono distinti, non esistono mai due processi che scrivono lo stesso file (il vincolo *single-writer* dello store di Claude Code).

Il nuovo id lo genera il deck e lo pinna con `--session-id`, per due ragioni:

- il ramo **eredita la task** dell'origine (senza id noto in anticipo il fork di una sessione scoped comparirebbe come spot);
- il **lineage** finisce nel sidecar `.claude/loom/session-tasks.jsonl` come campo `forkOf`. Serve perché il transcript del fork **non nomina** la sessione d'origine da nessuna parte: è una copia verbatim (stessi uuid dei messaggi) e `parentUuid` incatena i messaggi dentro un transcript, non le sessioni fra loro. Senza quel record un ramo sarebbe una riga gemella dell'originale, di cui eredita anche il titolo.

Un ramo si riconosce dal marker `⑂` nella lista e dalla riga `⑂ da <id>` nel pannello di dettaglio; la sua tab Ptyxis titola `<label> · <task> · fork`.

> **Nota di migrazione (0.6.0)**: `c` → **`C`** per creare una task, e le voci
> `codium`/`idea` non hanno più una lettera dedicata (erano `C`/`I` hardcoded):
> ora sono voci `launch` del file config, raggiunte per indice `1`…`9`.

### `^F` — cercare dentro le conversazioni

Il navigator trova una conversazione per **metadati** (titolo, data, turni). `^F` la trova per **contenuto**: «l'IA me l'ha detto 150k di testo fa, ricordo mezza parola». Claude Code non ha un find-in-conversation, ma i transcript sono tutti su disco e il deck li legge già.

Due campi, `tab` per passare dall'uno all'altro:

- **hash** — prefisso del `sessionId` (gli 8 char della statusline bastano), restringe a una conversazione. Vuoto = **tutte** quelle del progetto.
- **chiave** — il termine cercato. La ricerca è **eager**: si aggiorna a ogni carattere, da 3 in su.

Sei toggle, tutti su `CTRL` perché i campi di testo occupano le lettere nude. Lo stato si legge da `[x]`/`[ ]`, non dal solo colore:

| Tasto | Toggle | Default |
|---|---|---|
| `^R` | la chiave è una **regex** invece che testo letterale | off |
| `^A` | **case-sensitive** | off |
| `^W` | solo **parole intere** | off |
| `^B` | cerca nel testo **dell'IA** | **on** |
| `^T` | cerca nei **tool** (`tool_use` / `tool_result`) | off |
| `^U` | cerca nei prompt **umani** | off |

Non esiste un toggle *thinking*: quei blocchi sono persistiti **senza testo** (il transcript porta la sola firma crittografica), quindi sarebbe una casella che non può mai produrre un risultato.

Con l'hash vuoto la lista è **raggruppata per conversazione**; `⏎` è contestuale alla riga selezionata — su una riga-conversazione **riprende** la sessione (come dal pane Sessions), su una riga-occorrenza apre il **reader**. La selezione parte dalla prima *occorrenza*, non dalla riga di gruppo: quella è un segnaposto di navigazione, raggiungibile con le frecce ma non una destinazione.

L'estratto attorno al match **si allarga col terminale**: a 190 colonne sono ~170 caratteri di contesto, non i 50 di un valore fisso — ed è il contesto la ragione per cui si legge la riga invece di aprire il reader.

Sotto la lista, un **pannello di anteprima** mostra il contesto attorno all'occorrenza selezionata e si aggiorna navigando con le frecce. Prende solo le righe che la lista non usa: con pochi risultati riempie il terminale, con molti sparisce e la lista se le riprende — quando c'è tanto da scorrere la priorità è vedere più occorrenze, il contesto è il premio per una ricerca già stretta.

Il reader mostra il messaggio intero, aperto già **posizionato sull'occorrenza**
col match evidenziato: `↑↓` riga, `PgUp`/`PgDn` pagina, `g`/`G` estremi, `esc`
torna alla lista senza perdere query, toggle e selezione. (Gli estremi stanno su lettera e non su `Home`/`End` perché Ink non espone quei due tasti: arrivano indistinguibili da qualunque tasto ignoto.)

I toggle e la query sono **volatili**: sopravvivono alla chiusura del modale, non al riavvio del deck — comporre una ricerca non tocca il disco.

**Come fa a essere istantanea.** I corpi dei messaggi restano in RAM dentro la cache mtime-keyed che il deck usa già per la lista sessioni: quei file venivano comunque deserializzati per turni e titoli, e i corpi buttati. Trattenerli non aggiunge I/O, aggiunge memoria — e ne aggiunge poca, perché un JSONL è per l'85% overhead (misurato su un progetto reale: 57 MB su disco = 9,8 MB di testo cercabile). Cercarci dentro costa 1-9 ms; un prefiltro `grep` sugli stessi file ne costerebbe 26, perché rileggerebbe il volume pieno a ogni battuta.

### `^G` / `^O` — il project status

Il recap di progetto (`/loom-works:recap-status-project`) non è più solo una conversazione da aprire e perdere: il deck lo tiene come **artefatto**. La prima riga della cornice lo dice sempre.

```
loom-works :: PROJECT STATUS [ 09:42 ]        v0.49.0
```

Il campo fra parentesi ha tre stati e basta:

| Stato | Significato |
|---|---|
| `missing` | nessun recap in cache: mai generato, o cache svuotata |
| `◍ building 47...` | generazione in corso, coi secondi trascorsi dallo spawn |
| `09:42` | ora dell'ultima generazione riuscita |

Il glifo `◍` è lo stesso della colonna liveness delle sessioni: una generazione in corso **è** una conversazione che sta lavorando, non un simbolo nuovo da imparare. Dopo un tentativo fallito il campo porta un marker in coda (`[ 09:42 ⚠ ]`) e se lo tiene finché una generazione riuscita non lo azzera — la riga di stato sparisce al primo tasto premuto, e un fallimento non deve poter passare inosservato per una pressione di freccia. Il fallimento **non** cancella l'ora: la cache non è stata riscritta, quindi il recap di prima è ancora vero e ancora apribile.

**Due tasti, non uno**: `^G` genera, `^O` apre. Aprire un recap vecchio costa una lettura di file, generarlo costa minuti di sessione Claude — legarli allo stesso tasto renderebbe il gesto economico un effetto collaterale di quello caro. `^G` con una generazione già in corso non ne fa partire una seconda; `^O` su cache assente lo dice nella riga di stato invece di aprire un viewer vuoto.

Il recap vive in un file markdown sotto `/tmp/loom-deck-status-<uid>/`, col nome derivato dal path del progetto (non-alnum → `-`, la stessa trasformazione del transcript store di Claude Code). Da lì tre conseguenze volute: **sopravvive alla chiusura del deck** (riaperto, la testata mostra l'ora di prima), muore al reboot (un recap di ieri è comunque stale), e la coordinata resta una funzione pura del path invece di un registro da tenere allineato. L'ora mostrata è l'**mtime del file**, mai un campo scritto dentro il testo: un fatto scritto due volte diverge alla prima riscrittura parziale.

`^O` apre un **viewer fullscreen** con lo stesso markdown reso del detail della task: `↑↓` riga, `PgUp`/`PgDn` pagina, `g`/`G` estremi, `esc` chiude. Aperto mentre una generazione gira, mostra la versione precedente e lo **dichiara** nella riga meta — il viewer è una fotografia e non si aggiorna da sé quando la generazione finisce.

A generazione finita arriva una notifica desktop (`notify-send`): la generazione dura minuti e nel frattempo si guarda altrove, e la notifica di GNOME persiste nel cassetto — cosa che un suono non farebbe. Senza `notify-send` installato non succede **niente**: nessuna riga, nessun messaggio. L'assenza di un binario è una proprietà stabile della macchina, non un evento, e segnalarla a ogni generazione sarebbe rumore ripetuto su una funzione accessoria mentre il deliverable vero è arrivato comunque.

## Vista: filtri e ordinamenti

La lista è una **vista** sulla `tasks.md`: si filtra e si ordina senza toccare il file.

**`S` — sort chain.** Grammatica libera: la *sequenza* di tasti **è** la catena di
ordinamento. Ogni tasto cicla `asc → desc → fuori dalla catena`; una chiave
rimossa e ripremuta si riaccoda in fondo.

```
p  priorità     s  stato     i  id
```

Partendo da catena vuota, digitare `ppi` produce `[pri ↓, id ↑]`. Il ciclo parte
sempre **dallo stato corrente**, che il modale mostra dal vivo mentre digiti.

Sull'**id** il confronto è numerico (`T9` prima di `T10`, non lessicografico) e i due prefissi sono blocchi distinti — le `D` in coda alle `T`: i counter `T` e `D` sono separati nel contratto loom, quindi `T01` e `D01` non sono confrontabili come numeri soli. A parità su tutte le chiavi decide sempre l'`id` (confronto **numerico**: `T9`
prima di `T10`) → l'ordine è deterministico, mai instabile fra un refresh e l'altro.

**`F` — filtri.** Un toggle per ogni priorità e per ogni stato, componibili in AND.
`↑↓` cambia riga, `←→` scorre i valori, `spazio` mostra/nasconde.

In entrambi i modali la lista si aggiorna **dal vivo**; `⏎` conferma, `esc` ripristina la vista com'era all'apertura.

Con un filtro attivo l'header dichiara sempre quanto sta nascondendo (`Tasks (9/25) · 16 nascoste`): il deck non finge mai una lista completa.

**Persistenza.** La vista non si salva da sola — sperimentare non sporca nulla. `w` la scrive in `.claude/loom/deck-view.json` (macchina-locale, da gitignorare)
e al riavvio viene ripristinata. File assente o corrotto → default puliti.

## L'header è un selettore di vista

Ogni segmento dell'header nomina un sottoinsieme che il deck sa già calcolare.
`tab` lo rende **raggiungibile**: la voce attiva si evidenzia in video
inverso e la lista sotto mostra quel sottoinsieme.

```
Tasks (20/78) · 58 nascoste · 23 archiviabili · ↑7 · ↓9
Sessions · tutte (317) · ●2 vive · 📌4 · +213 più vecchie · ↑7 · ↓9
```

| Pane | Viste |
|---|---|
| Tasks | `Tasks (n/N)` (filtri applicati) · `N nascoste` (il complemento esatto di quei filtri) · `N archiviabili` (Done oltre `archivableDays`, cieca ai filtri) |
| Sessions | `{parent} (N)` · `●N vive` · `📌N` · `+N più vecchie` (le contestuali che il cap `maxContext` tronca) |

- **Il catalogo è fisso**, anche a contatore 0 (la voce si mostra dim). Un catalogo che si accorcia sposta le voci sotto le dita, e la vista corrente può svanire mentre la guardi — togliere un filtro mentre sei su `nascoste`.
- **`↑N` `↓N` non sono viste**: contano elementi fuori finestra per altezza del
  terminale, cioè una posizione, non un insieme. Restano in coda, non selezionabili.
- **Due assi ortogonali**: il pane task sceglie il *parent* delle conversazioni (`≡ tutte` / `○ spot` / una task), l'header sceglie *quale sottoinsieme* di quel parent. Cambiare parent non azzera la vista, che si ricalcola dentro il nuovo.
- **`F` è inerte fuori dalla vista `Tasks`** e lo dice con una nota: su `nascoste` riapplicare i filtri non ha senso, `archiviabili` è cieca per scelta.
- **La vista è volatile**: non entra in `deck-view.json`, il deck riapre sempre sulla voce 1. Un filtro salvato lo si è scelto; una vista non-default riaperta a freddo si leggerebbe come la lista intera.
- **Cambiare vista riporta la selezione in cima**, righe meta comprese: nessuna regola di mantenimento, nessun tentativo di ritrovare l'elemento precedente.
- Su un terminale stretto **la voce attiva è servita per prima** dal budget di larghezza: sparisce un contatore, mai la voce che dice dove sei.

## Installazione

```bash
npm install -g @lamemind/loom-deck   # comando globale `loom-deck`
# oppure senza install permanente:
npx @lamemind/loom-deck
```

## Requisiti runtime

- **Node.js ≥ 18** (dichiarato in `engines`).
- **[Ptyxis](https://gitlab.gnome.org/chergert/ptyxis)** (terminale GNOME) — **dipendenza di runtime, non risolvibile da npm**. Lo spawn di una tab (`scripts/deck-run`) invoca il binario `ptyxis`: l'**install riesce anche senza**, ma al momento dello spawn il comando
  fallisce (gestito: handler `error` → la TUI resta viva, mostra la nota). Senza una GUI
  GNOME con Ptyxis installato, il deck naviga i task ma **non apre sessioni**.
- **[Claude Code](https://claude.com/claude-code)** nel `PATH` — la tab spawnata avvia `claude`.

## Uso (spike ①)

```bash
# dalla project dir con un tasks.md
scripts/deck-run T18
scripts/deck-run T18 --prompt-kind none|recap|preflight|run|checkpoint
scripts/deck-run T18 --prompt 'testo letterale del prompt'
```

Apre una tab Ptyxis nella window attiva con `LOOM_TASK=T18 claude 'recap stato task T18'`. Il prompt iniziale è il terzo asse dello spawn, ortogonale al binding task (`<TaskID>` vs `--no-task`) e alla continuità (nuova vs `--resume`/`--fork`): senza flag resta `recap`, `none` apre la sessione bound **senza** alcun prompt. `LOOM_DECK_ENTER_PROMPT` (placeholder `{TASK}`) resta un override che vince sul kind — tranne su `none`, che è una richiesta esplicita di non averne.

I testi del catalogo stanno in `scripts/prompt-catalog` (formato `kind<TAB>template`, `{TASK}` interpolato), non dentro lo script: li legge anche il deck, per mostrare nel detail il prompt prima dello spawn. `--prompt` passa invece un testo **letterale** ed è esclusivo con `--prompt-kind` — sono due modi di dire la stessa cosa, e accettarli insieme costringerebbe a stabilire quale vince. Il testo viene quotato per la shell in-tab, apici singoli compresi: è l'unico ingresso di testo libero in una riga che una shell parsa.

La tab porta anche `PTYXIS_PROFILE` forzata al profilo bindato al progetto nel registry (`bindings/claude`), letto da dconf: è la chiave con cui loom-compass associa a un progetto lo stato annunciato dagli hook (running/ask/done). Una tab `ptyxis --tab` nuda erediterebbe il profilo di default, e l'annuncio finirebbe keyed su un UUID che nessun progetto dichiara — pallino fermo su idle, senza alcun errore visibile. Override o disattivazione via `LOOM_DECK_STATE_PROFILE`
(settata a vuoto → nessun annuncio); progetto non registrato → nessun prefisso.

## Sviluppo (TUI Ink)

```bash
npm install
npm run dev      # tsx src/cli.tsx — lista tasks.md reale, ↑↓ naviga · ⏎ detail · ^K/^P/^R spawn · ^C chiude
npm run build    # tsc → dist/
npm test         # node:test sul core vista (src/view.ts), senza Ink né terminale
```

Il core di filtri e ordinamenti (`src/view.ts`) è **puro**: nessun import da Ink o React, nessun I/O. È il motivo per cui è testabile con `node:test` su array fixture, mentre la TUI resta un guscio sottile che lo consuma.

Il deck cerca `tasks.md` in `$PWD/${LOOM_DECK_DOCS_ROOT:-docs}/tasks.md`. Progetti con docs-root non-standard esportano la variabile, es. `LOOM_DECK_DOCS_ROOT=runtime`.

La lista si **auto-aggiorna** quando `tasks.md` cambia sotto (poll su `mtime`, ~1.5s):
crei/checkpoint una task da un'altra sessione → il deck la riflette senza riavvio.

## Licenza

MIT © 2026 lamemind
