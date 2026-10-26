// T176 — gli ARGOMENTI di `deck-run`: lettura dell'argv e validazione.
//
// `deck-run` è il primitive di spawn del deck, UI-agnostico: lo lanciano il deck
// TUI, compass (la ripresa di una pinnata) e chi lo invoca a mano. Fino a T176
// era uno script bash; da T176 la composizione è TypeScript per Linux e Windows,
// e `scripts/deck-run` resta allo stesso path come shim di una riga (D1
// preflight): compass lo risolve come `<cli>/../scripts/deck-run` e ne
// controlla l'eseguibilità, e `test/deck-run.test.ts` lo lancia a scatola chiusa.
//
// Quattro assi ORTOGONALI, da non confondere fra loro:
//   binding task   <TaskID> ..... --no-task
//   continuità     nuova ........ --resume [--fork]
//   prompt         --prompt-kind none|recap|… | --prompt <testo>
//   modello        --model fable|opus|sonnet|haiku
// Fuori dai quattro, e volutamente non un asse: --new-window, che cambia SOLO
// dove nasce la tab (finestra nuova invece della finestra attiva).
//
// Modulo PURO: argv in ingresso, richiesta o errore d'uso in uscita. Le regole e
// i messaggi sono quelli dello script bash, parola per parola: il gate di parità
// su Linux (`test/deck-run.test.ts`) li asserisce sullo stderr.
import type { PromptKind } from './spawn-catalog.js';

/** I kind accettati da `--prompt-kind`. Enum e non stringa libera: un kind è un
 *  simbolo interno del deck, e uno fuori elenco è un errore del chiamante. */
export const PROMPT_KINDS: readonly PromptKind[] = [
  'none',
  'recap',
  'recap-task',
  'recap-epic',
  'preflight',
  'run',
  'checkpoint',
];

/** La richiesta di spawn, già validata. Le stringhe vuote valgono «flag non
 *  passato», come nello script: `--resume ''` non è una ripresa. */
export interface TabRequest {
  /** TaskID, vuoto con `--no-task`. */
  task: string;
  noTask: boolean;
  sessionId: string;
  resumeId: string;
  fork: boolean;
  newWindow: boolean;
  titleNote: string;
  /** Vuoto = flag non passato: con `--no-task` il kind implicito è legittimo
   *  (nessun prompt), quello chiesto è un errore d'uso. */
  promptKind: string;
  /** T117 — il prompt letterale. Vuoto NON basta a dire «non passato»:
   *  `--prompt ''` è una richiesta legittima (nessun prompt, deciso da chi ha
   *  svuotato il campo), quindi la presenza del flag sta in `promptGiven`. */
  promptText: string;
  promptGiven: boolean;
  /** Vuoto = flag non passato: la cascata (env, catalogo, default) si risolve
   *  nella composizione. */
  model: string;
}

/** Un errore d'uso: le righe da scrivere su stderr, e l'uscita è sempre 2. */
export interface UsageError {
  lines: string[];
}

export const USAGE = `uso: deck-run <TaskID> [--model <alias>] [--prompt-kind <kind>] [--session-id <uuid>]
                                                   (es. deck-run T18)
     | deck-run --no-task                          (sessione nuda, senza task)
     | deck-run <TaskID> --resume <uuid>           (riprende sessione scoped)
     | deck-run --no-task --resume <uuid>          (riprende sessione spot)
     | deck-run <TaskID> --resume <uuid> --fork [--session-id <nuovo-uuid>]
                                                   (forka: ramo con id NUOVO)

  --prompt-kind  prompt iniziale della sessione bound (default: recap)
       none        nessun prompt — sessione aperta sulla task, a mani nude
       recap       /loom-works:recap-status <TaskID>       (dispatcher)
       recap-task  /loom-works:recap-status-task <TaskID>  (task non cappello)
       recap-epic  /loom-works:recap-status-epic <TaskID>  (Size: Epic)
       preflight   /loom-works:preflight-task <TaskID>
       run         /loom-works:run-task <TaskID>
       checkpoint  /loom-works:checkpoint-task <TaskID>

  --prompt       prompt LETTERALE, per chi lo ha già composto (o fatto
                 modificare). Esclusivo con --prompt-kind; vuoto = nessun
                 prompt. Ammesso anche con --no-task: un testo già scritto non
                 ha una task da nominare, a differenza dei kind del catalogo

  --model        modello della sessione: fable|opus|sonnet|haiku
                 (default: il modello del kind in catalogo, o 'fable' fuori catalogo)
                 valore ignoto → fallback sul default, con avviso su stderr

  --title-note   nota della conversazione, appesa al titolo tab
                 (ridotta a lettere/cifre/spazi/-/_, cap 60 char)

  --new-window   apre una FINESTRA nuova invece di una tab nella finestra
                 attiva. Per chi chiama da fuori dalla finestra del progetto`;

/** I flag che portano un valore, nel campo della richiesta che lo riceve. */
const VALUED: Readonly<Record<string, keyof TabRequest>> = {
  '--model': 'model',
  '--title-note': 'titleNote',
  '--prompt-kind': 'promptKind',
  '--prompt': 'promptText',
  '--session-id': 'sessionId',
  '--resume': 'resumeId',
};

function usageError(...lines: string[]): UsageError {
  return { lines: [...lines, USAGE] };
}

/**
 * L'argv di `deck-run` come richiesta validata, o l'errore d'uso.
 *
 * Le due forme di un flag con valore (`--model x` e `--model=x`) valgono uguale;
 * un argomento che non è un flag noto è il TaskID se il TaskID non c'è ancora,
 * altrimenti un errore — anche `--qualcosa`, come nello script.
 *
 * L'ordine delle validazioni è quello dello script, perché è l'ordine in cui un
 * chiamante riceve i messaggi quando più regole sono violate insieme.
 */
export function parseTabArgs(argv: readonly string[]): TabRequest | UsageError {
  const req: TabRequest = {
    task: '',
    noTask: false,
    sessionId: '',
    resumeId: '',
    fork: false,
    newWindow: false,
    titleNote: '',
    promptKind: '',
    promptText: '',
    promptGiven: false,
    model: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const field = VALUED[name];
    if (field) {
      let value: string;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length) value = argv[++i]!;
      else return usageError(`${name} richiede un valore`);
      (req[field] as string) = value;
      if (field === 'promptText') req.promptGiven = true;
      continue;
    }
    if (arg === '--fork') req.fork = true;
    else if (arg === '--no-task') req.noTask = true;
    else if (arg === '--new-window') req.newWindow = true;
    else if (!req.task) req.task = arg;
    else return { lines: [`argomento inatteso: '${arg}'`] };
  }

  if (req.noTask && req.task) {
    return usageError('--no-task e <TaskID> sono mutuamente esclusivi');
  }
  if (!req.noTask && !req.task) return usageError();
  if (req.fork && !req.resumeId) {
    return usageError(
      '--fork richiede --resume <uuid>: si forka una conversazione esistente, non il nulla',
    );
  }
  // Una ripresa nuda riscrive il transcript dell'id ripreso, quindi un id
  // pinnato non ha senso; il fork apre un transcript NUOVO, che si può pinnare.
  if (req.resumeId && req.sessionId && !req.fork) {
    return usageError(
      '--resume e --session-id sono mutuamente esclusivi (la sessione ripresa ha già il suo id)',
      'usa --fork se vuoi un ramo con id nuovo',
    );
  }
  // Un kind fuori catalogo è un errore del CHIAMANTE (simbolo interno, non
  // configurazione utente): uscita, non fallback silenzioso come il modello.
  if (req.promptKind && !(PROMPT_KINDS as readonly string[]).includes(req.promptKind)) {
    return usageError(
      `--prompt-kind ignoto: '${req.promptKind}' (usa ${PROMPT_KINDS.join('|')})`,
    );
  }
  // Ogni prompt del catalogo nomina il TaskID: senza task produrrebbe un
  // comando monco (`/loom-works:run-task ` con l'id vuoto). Il testo letterale
  // invece è ammesso con `--no-task` (T134/D9): non ha una task da nominare.
  if (req.noTask && req.promptKind) {
    return usageError(
      '--prompt-kind richiede una task: una sessione --no-task non ha prompt iniziale',
    );
  }
  // Due modi di dire la stessa cosa: accettarli insieme obbligherebbe a
  // stabilire quale vince.
  if (req.promptGiven && req.promptKind) {
    return usageError(
      '--prompt e --prompt-kind sono mutuamente esclusivi (il testo o il simbolo, non entrambi)',
    );
  }
  return req;
}

export function isUsageError(r: TabRequest | UsageError): r is UsageError {
  return 'lines' in r;
}
