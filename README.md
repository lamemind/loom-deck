# loom-deck

Deck TUI (Ink) **per-progetto** della famiglia [loom](https://github.com/lamemind/loom-works).

Legge il `tasks.md` del progetto e, con un tasto (poi un click), **spawna** una tab
[Ptyxis](https://gitlab.gnome.org/chergert/ptyxis) che avvia una sessione Claude Code
già bound alla task via `LOOM_TASK`, con un prompt di recap sullo stato della task.

```
↑↓ scegli la task  →  ⏎  →  tab CC di fianco  →  LOOM_TASK bound + recap stato task
```

Entrambi i prefissi del contratto loom entrano in lista: **`T`** (code task) e
**`D`** (doc task). Nessuna differenza di trattamento — il prompt iniziale è un
recap, non l'invocazione di una skill, quindi vale identico sulle due famiglie.

## Ruolo nella famiglia loom

`loom-deck` è un **client** con runtime proprio (TUI Ink) che **consuma** il contratto
definito da `loom-works-plugin` (formato `tasks.md`, variabile `LOOM_TASK`) — non lo
ridefinisce. Divisione dei ruoli con Compass:

| | scope | ruolo | domanda |
|---|---|---|---|
| **Compass** (GNOME) | globale, cross-desktop | radar, stato live, focus/jump | "dove sono?" |
| **loom-deck** (TUI) | per-progetto | attuatore locale, spawna task | "cosa faccio qui?" |

## Architettura di processo

Il deck è **UN processo Node**: spawna ma **non contiene** le sessioni CC — le possiede
Ptyxis. Chiudere il deck non uccide le sessioni. La tab nasce nella window *attiva*
(quella col focus = il deck) → desktop isolation "gratis".

## Stato

Bootstrap + spike ① + **TUI ③** funzionante (legge `tasks.md`, `⏎` spawna). Roadmap:

```
① spike spawn-tab + LOOM_TASK   ✅ scripts/deck-run
② gradino $LOOM_TASK nelle skill loom-works
③ TUI Ink sopra (lista tasks.md, ↑↓/⏎ → chiama ①)   ✅ src/
④ mouse opzionale (SGR enable+parse+hit-test)
⑤ azioni extra (start/preflight/checkpoint/merge dal deck)
```

## Standard shortcut

Regola unica, senza eccezioni — pensata per reggere l'aggiunta di nuove azioni
senza collisioni:

| Tasto | Semantica | Note |
|---|---|---|
| `↑` `↓` | naviga nella lista | |
| `←` `→` `tab` | cambia pane | |
| `⏎` | azione primaria del pane | Tasks → spawna la task selezionata · Sessions → riprende (`claude --resume`) la sessione selezionata |
| **MAIUSCOLA** | **apre un modale** | cattura tutti i tasti; `esc` annulla, non esce |
| minuscola | azione immediata, one-shot | |
| `CTRL`+lettera | idiomi universali e toggle dentro i modali di testo | `^F` = find, come ovunque |
| `1`…`9` | voce `launch` n-esima del progetto | da `.claude/loom-works.json` |
| `q` `esc` | esce dal deck | in un modale `esc` annulla soltanto |

`CTRL` è il terzo livello, aggiunto quando è arrivata la ricerca. Serve perché
un modale con **campi di testo** mangia ogni lettera nuda: là dentro nessun
comando può essere una lettera semplice. `CTRL+X` e `x` nudo condividono lo
stesso `input` e si distinguono solo per `key.ctrl`, quindi in modalità normale
il ramo `CTRL` è valutato **per primo** e chiude l'intera classe — senza,
`CTRL+F` cadrebbe nel ramo `f` e forkerebbe una sessione invece di cercare.

Assegnazioni correnti:

| | Tasto | Cosa fa |
|---|---|---|
| modale | `C` | nuova task (create-task inline) |
| modale | `E` | edit priorità/stato della task selezionata (salva + commit) |
| modale | `S` | sort chain |
| modale | `F` | filtri |
| modale | `^F` | **ricerca full-text** nelle conversazioni del progetto |
| immediata | `f` | **forka** la sessione selezionata (solo col focus sul pane Sessions) |
| immediata | `t` | terminale @project-root (surface standard launch) |
| immediata | `c` | sessione Claude **nuda**: nessuna task, nessun prompt iniziale |
| immediata | `w` | salva la vista corrente su disco |
| launch | `1`…`9` | esegue il `command` della voce, con `cwd` = project root |

Le voci `launch` sono elencate in una **riga di legenda** sotto il footer
(`launch 1 📝 codium · 2 ☕ idea`): l'indice da solo è opaco, perché le voci sono
custom per-progetto e non hanno una lettera fissa per app. Se non entrano in
larghezza, la legenda si ferma a voci intere e mostra il contatore di quelle
fuori riga — mai un troncamento silenzioso. Il cap a `9` è imposto dai tasti-cifra,
non dallo schema: un progetto può dichiarare più di 9 voci, quelle oltre la nona
sono configurate ma non raggiungibili (e la legenda lo dice).

`t` e `c` sono gemelle: entrambe aprono una surface del cappello nella stessa
finestra Ptyxis, senza passare da un modale. `c` (minuscola, azione) e `C`
(maiuscola, modale create-task) restano distinte per la regola sopra — così come
`f` (fork) e `F` (filtri).

### `f` — forkare una conversazione

Il fork rama la sessione selezionata: `claude --resume <origine> --fork-session`
apre un **sessionId nuovo** con il transcript copiato, lasciando l'origine
intatta. Serve quando vuoi ripartire da un certo stato senza perdere il ramo
originale — e siccome i due id sono distinti, non esistono mai due processi che
scrivono lo stesso file (il vincolo *single-writer* dello store di Claude Code).

Il nuovo id lo genera il deck e lo pinna con `--session-id`, per due ragioni:

- il ramo **eredita la task** dell'origine (senza id noto in anticipo il fork
  di una sessione scoped comparirebbe come spot);
- il **lineage** finisce nel sidecar `.claude/loom/session-tasks.jsonl` come
  campo `forkOf`. Serve perché il transcript del fork **non nomina** la sessione
  d'origine da nessuna parte: è una copia verbatim (stessi uuid dei messaggi) e
  `parentUuid` incatena i messaggi dentro un transcript, non le sessioni fra
  loro. Senza quel record un ramo sarebbe una riga gemella dell'originale, di
  cui eredita anche il titolo.

Un ramo si riconosce dal marker `⑂` nella lista e dalla riga `⑂ da <id>` nel
pannello di dettaglio; la sua tab Ptyxis titola `<label> · <task> · fork`.

> **Nota di migrazione (0.6.0)**: `c` → **`C`** per creare una task, e le voci
> `codium`/`idea` non hanno più una lettera dedicata (erano `C`/`I` hardcoded):
> ora sono voci `launch` del file config, raggiunte per indice `1`…`9`.

### `^F` — cercare dentro le conversazioni

Il navigator trova una conversazione per **metadati** (titolo, data, turni). `^F`
la trova per **contenuto**: «l'IA me l'ha detto 150k di testo fa, ricordo mezza
parola». Claude Code non ha un find-in-conversation, ma i transcript sono tutti
su disco e il deck li legge già.

Due campi, `tab` per passare dall'uno all'altro:

- **hash** — prefisso del `sessionId` (gli 8 char della statusline bastano),
  restringe a una conversazione. Vuoto = **tutte** quelle del progetto.
- **chiave** — il termine cercato. La ricerca è **eager**: si aggiorna a ogni
  carattere, da 3 in su.

Sei toggle, tutti su `CTRL` perché i campi di testo occupano le lettere nude.
Lo stato si legge da `[x]`/`[ ]`, non dal solo colore:

| Tasto | Toggle | Default |
|---|---|---|
| `^R` | la chiave è una **regex** invece che testo letterale | off |
| `^A` | **case-sensitive** | off |
| `^W` | solo **parole intere** | off |
| `^B` | cerca nel testo **dell'IA** | **on** |
| `^T` | cerca nei **tool** (`tool_use` / `tool_result`) | off |
| `^U` | cerca nei prompt **umani** | off |

Non esiste un toggle *thinking*: quei blocchi sono persistiti **senza testo**
(il transcript porta la sola firma crittografica), quindi sarebbe una casella
che non può mai produrre un risultato.

Con l'hash vuoto la lista è **raggruppata per conversazione**; `⏎` è contestuale
alla riga selezionata — su una riga-conversazione **riprende** la sessione
(come dal pane Sessions), su una riga-occorrenza apre il **reader**. La selezione
parte dalla prima *occorrenza*, non dalla riga di gruppo: quella è un segnaposto
di navigazione, raggiungibile con le frecce ma non una destinazione.

L'estratto attorno al match **si allarga col terminale**: a 190 colonne sono
~170 caratteri di contesto, non i 50 di un valore fisso — ed è il contesto la
ragione per cui si legge la riga invece di aprire il reader.

Sotto la lista, un **pannello di anteprima** mostra il contesto attorno
all'occorrenza selezionata e si aggiorna navigando con le frecce. Prende solo le
righe che la lista non usa: con pochi risultati riempie il terminale, con molti
sparisce e la lista se le riprende — quando c'è tanto da scorrere la priorità è
vedere più occorrenze, il contesto è il premio per una ricerca già stretta.

Il reader mostra il messaggio intero, aperto già **posizionato sull'occorrenza**
col match evidenziato: `↑↓` riga, `PgUp`/`PgDn` pagina, `g`/`G` estremi, `esc`
torna alla lista senza perdere query, toggle e selezione. (Gli estremi stanno su
lettera e non su `Home`/`End` perché Ink non espone quei due tasti: arrivano
indistinguibili da qualunque tasto ignoto.)

I toggle e la query sono **volatili**: sopravvivono alla chiusura del modale,
non al riavvio del deck — comporre una ricerca non tocca il disco.

**Come fa a essere istantanea.** I corpi dei messaggi restano in RAM dentro la
cache mtime-keyed che il deck usa già per la lista sessioni: quei file venivano
comunque deserializzati per turni e titoli, e i corpi buttati. Trattenerli non
aggiunge I/O, aggiunge memoria — e ne aggiunge poca, perché un JSONL è per l'85%
overhead (misurato su un progetto reale: 57 MB su disco = 9,8 MB di testo
cercabile). Cercarci dentro costa 1-9 ms; un prefiltro `grep` sugli stessi file
ne costerebbe 26, perché rileggerebbe il volume pieno a ogni battuta.

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

Sull'**id** il confronto è numerico (`T9` prima di `T10`, non lessicografico) e i
due prefissi sono blocchi distinti — le `D` in coda alle `T`: i counter `T` e `D`
sono separati nel contratto loom, quindi `T01` e `D01` non sono confrontabili
come numeri soli.
A parità su tutte le chiavi decide sempre l'`id` (confronto **numerico**: `T9`
prima di `T10`) → l'ordine è deterministico, mai instabile fra un refresh e l'altro.

**`F` — filtri.** Un toggle per ogni priorità e per ogni stato, componibili in AND.
`↑↓` cambia riga, `←→` scorre i valori, `spazio` mostra/nasconde.

In entrambi i modali la lista si aggiorna **dal vivo**; `⏎` conferma, `esc`
ripristina la vista com'era all'apertura.

Con un filtro attivo l'header dichiara sempre quanto sta nascondendo
(`Tasks (9/25) · 16 nascoste`): il deck non finge mai una lista completa.

**Persistenza.** La vista non si salva da sola — sperimentare non sporca nulla.
`w` la scrive in `.claude/loom/deck-view.json` (macchina-locale, da gitignorare)
e al riavvio viene ripristinata. File assente o corrotto → default puliti.

## Installazione

```bash
npm install -g @lamemind/loom-deck   # comando globale `loom-deck`
# oppure senza install permanente:
npx @lamemind/loom-deck
```

## Requisiti runtime

- **Node.js ≥ 18** (dichiarato in `engines`).
- **[Ptyxis](https://gitlab.gnome.org/chergert/ptyxis)** (terminale GNOME) — **dipendenza
  di runtime, non risolvibile da npm**. Lo spawn di una tab (`scripts/deck-run`) invoca il
  binario `ptyxis`: l'**install riesce anche senza**, ma al momento dello spawn il comando
  fallisce (gestito: handler `error` → la TUI resta viva, mostra la nota). Senza una GUI
  GNOME con Ptyxis installato, il deck naviga i task ma **non apre sessioni**.
- **[Claude Code](https://claude.com/claude-code)** nel `PATH` — la tab spawnata avvia `claude`.

## Uso (spike ①)

```bash
# dalla project dir con un tasks.md
scripts/deck-run T18
```

Apre una tab Ptyxis nella window attiva con `LOOM_TASK=T18 claude 'recap stato task T18'`
(prompt override-abile via `LOOM_DECK_ENTER_PROMPT`, placeholder `{TASK}`).

## Sviluppo (TUI Ink)

```bash
npm install
npm run dev      # tsx src/cli.tsx — lista tasks.md reale, ↑↓ naviga · ⏎ spawn · q esci
npm run build    # tsc → dist/
npm test         # node:test sul core vista (src/view.ts), senza Ink né terminale
```

Il core di filtri e ordinamenti (`src/view.ts`) è **puro**: nessun import da Ink o
React, nessun I/O. È il motivo per cui è testabile con `node:test` su array
fixture, mentre la TUI resta un guscio sottile che lo consuma.

Il deck cerca `tasks.md` in `$PWD/${LOOM_DECK_DOCS_ROOT:-docs}/tasks.md`. Progetti
con docs-root non-standard esportano la variabile, es. `LOOM_DECK_DOCS_ROOT=runtime`.

La lista si **auto-aggiorna** quando `tasks.md` cambia sotto (poll su `mtime`, ~1.5s):
crei/checkpoint una task da un'altra sessione → il deck la riflette senza riavvio.

## Licenza

MIT © 2026 lamemind
