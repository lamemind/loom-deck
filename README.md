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
```

Il deck cerca `tasks.md` in `$PWD/${LOOM_DECK_DOCS_ROOT:-docs}/tasks.md`. Progetti
con docs-root non-standard esportano la variabile, es. `LOOM_DECK_DOCS_ROOT=runtime`.

La lista si **auto-aggiorna** quando `tasks.md` cambia sotto (poll su `mtime`, ~1.5s):
crei/checkpoint una task da un'altra sessione → il deck la riflette senza riavvio.

## Licenza

MIT © 2026 lamemind
