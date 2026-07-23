# loom-deck

Deck TUI (Ink) **per-progetto** della famiglia [loom](https://github.com/lamemind/loom-works).

Legge il `tasks.md` del progetto e, con un tasto (poi un click), **spawna** una tab
[Ptyxis](https://gitlab.gnome.org/chergert/ptyxis) che avvia una sessione Claude Code
già bound alla task via `LOOM_TASK`, dritta su `/loom-works:run-task <Txx>`.

```
↑↓ scegli la task  →  ⏎  →  tab CC di fianco  →  parte già su /loom-works:run-task <Txx>
```

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
| `1`…`9` | voce `launch` n-esima del progetto | da `.claude/loom-works.json` |
| `q` `esc` | esce dal deck | in un modale `esc` annulla soltanto |

Assegnazioni correnti:

| | Tasto | Cosa fa |
|---|---|---|
| modale | `C` | nuova task (create-task inline) |
| modale | `E` | edit priorità/stato della task selezionata (salva + commit) |
| modale | `S` | sort chain |
| modale | `F` | filtri |
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

Apre una tab Ptyxis nella window attiva con `LOOM_TASK=T18 claude '/loom-works:run-task T18'`.

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
