# loom-deck

Cockpit TUI (Ink) **per-progetto** della famiglia [loom](https://github.com/lamemind/loom-works).

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

Il cockpit è **UN processo Node**: spawna ma **non contiene** le sessioni CC — le possiede
Ptyxis. Chiudere il cockpit non uccide le sessioni. La tab nasce nella window *attiva*
(quella col focus = il cockpit) → desktop isolation "gratis".

## Stato

Bootstrap + **spike ①** (spawn primitive UI-agnostico). Roadmap:

```
① spike spawn-tab + LOOM_TASK   ✅ questo repo (scripts/cockpit-run)
② gradino $LOOM_TASK nelle skill loom-works
③ TUI Ink sopra (lista tasks.md, ↑↓/⏎ → chiama ①)
④ mouse opzionale (SGR enable+parse+hit-test)
⑤ azioni extra (start/preflight/checkpoint/merge dal cockpit)
```

## Uso (spike ①)

```bash
# dalla project dir con un tasks.md
scripts/cockpit-run T18
```

Apre una tab Ptyxis nella window attiva con `LOOM_TASK=T18 claude '/loom-works:run-task T18'`.

## Sviluppo (scaffold Ink)

```bash
npm install
npm run dev      # tsx src/cli.tsx — box placeholder, ↑↓/⏎/q
npm run build    # tsc → dist/
```

## Licenza

MIT © 2026 lamemind
