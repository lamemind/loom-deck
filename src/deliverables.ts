// T189 — i DELIVERABLE di un task file, e le due regole del plugin che il deck
// replica per offrirli nel detail.
//
// Il deck non esegue niente qui: legge i DLV per mostrarli e per comporre il
// perimetro di `run-task`. Ma il perimetro è un INDIRIZZO — `run-task T189 2,4`
// esegue il secondo e il quarto DLV come li conta il plugin, non come li conta
// chi ha composto il prompt. Se i due conteggi divergono l'umano seleziona DLV3
// e `run-task` esegue un altro DLV, senza errore. Per questo le due regole sono
// copie esatte, e la prima ha un test di parità contro lo script vero.
//
//  ① NUMERAZIONE — `loom-works-plugin/scripts/task/task-deliverables.sh`:
//     posizionale 1-based sulle sole checkbox a COLONNA ZERO dentro
//     `## Deliverables Checklist`; le righe indentate sono prosa della voce.
//  ② GATE DI ESEGUIBILITÀ — `run-task` SKILL.md §3: Size L vuole un
//     `### Preflight` in `## Decisions`, S e M no, Size assente = M; un ultimo
//     `### Preflight` con `— premessa decaduta` blocca a ogni Size. Questa regola
//     vive nella prosa di una skill e non ha un presidio eseguibile: se cambia
//     lì, va cambiata qui a mano.
//
// D6 (preflight T189) — parser TypeScript e non lo script del plugin lanciato
// dal deck: il deck gira anche su Windows, dove un `.sh` del plugin oggi non
// parte (T178), e il detail si apre a ogni `⏎` — uno spawn di bash lì dentro
// sarebbe un costo per tasto. La parità la garantisce il test, non la fonte
// comune.
//
// Logica pura, zero React/Ink.
import { parseTaskDetail } from './tasks.js';

export interface Deliverable {
  /** Posizione 1-based fra le checkbox a colonna zero: l'indirizzo che
   *  `run-task` capisce (`--scope 1,3-5`). Si conta, non è scritta nel file. */
  n: number;
  done: boolean;
  /** Il testo della voce dopo la checkbox, markdown grezzo. */
  text: string;
}

/** Un heading di livello 2 apre una sezione nuova; `###` e oltre no. */
const SECTION_RE = /^## /;
const DLV_SECTION_RE = /^## Deliverables Checklist/;
/** Checkbox a colonna zero: `- [ ]`, `- [x]`, `- [X]`, e nient'altro. */
const CHECKBOX_RE = /^- \[[ xX]\]/;

/**
 * I DLV del task file, nell'ordine del file.
 *
 * Copia riga per riga dell'`awk` di `task-deliverables.sh`, comprese le sue
 * tolleranze: la sezione si riconosce per prefisso (`## Deliverables Checklist
 * (…)` vale), un fence non sospende niente, e il testo è ciò che segue i sei
 * caratteri della checkbox, spazi in testa tolti. Una «correzione» qui — saltare
 * le checkbox dentro un fence, per dire — darebbe numeri diversi da quelli dello
 * script sul primo task file che ne ha una.
 *
 * Testo assente (task file non trovato) → nessun DLV.
 */
export function parseDeliverables(text: string | null): Deliverable[] {
  if (!text) return [];
  const out: Deliverable[] = [];
  let inSection = false;
  for (const line of text.split('\n')) {
    if (SECTION_RE.test(line)) {
      inSection = DLV_SECTION_RE.test(line);
      continue;
    }
    if (!inSection || !CHECKBOX_RE.test(line)) continue;
    out.push({
      n: out.length + 1,
      done: line[3] !== ' ',
      text: line.slice(6).replace(/^[ \t]+/, ''),
    });
  }
  return out;
}

/**
 * Lo stato del modo DLV per una task, deciso all'apertura del detail.
 *
 *  - `ready` — `⏎` lancia `run-task`;
 *  - `warn` — `⏎` lancia lo stesso, ma `run-task` potrebbe rifiutare il lavoro:
 *    il motivo è quello che la skill direbbe, e sta a schermo accanto al prompt;
 *  - `off` — non c'è niente da lanciare (task chiusa, nessun DLV aperto).
 *
 * `warn` non blocca per scelta dell'utente: il rifiuto è un diritto della
 * skill, e il deck non lo anticipa. Il deck lo DICE, perché l'umano lanci
 * sapendo cosa la sessione risponderà, ma la decisione resta di chi preme.
 */
export type DlvGate =
  | { kind: 'ready' }
  | { kind: 'warn'; reason: string }
  | { kind: 'off'; reason: string };

/** `⏎` nel modo DLV lancia qualcosa: in `ready` e in `warn`, non in `off`. */
export function dlvLaunchable(gate: DlvGate): boolean {
  return gate.kind !== 'off';
}

/** L'esito dei blocchi `### Preflight` dentro `## Decisions`. */
export type PreflightState = 'none' | 'done' | 'decayed';

const DECISIONS_RE = /^## Decisions\b/;
const PREFLIGHT_RE = /^### Preflight\b/;
/** La dicitura che `preflight-task` mette nel heading quando si ferma davanti a
 *  una premessa smentita (§0b della skill). */
const DECAYED_RE = /premessa decaduta/i;

/**
 * L'ULTIMO blocco `### Preflight` di `## Decisions` decide: `preflight-task`
 * appende in fondo alla sezione, quindi l'ultimo nel file è il più recente.
 * Una premessa decaduta seguita da un preflight riuscito non blocca più; il
 * contrario sì.
 */
export function preflightState(text: string | null): PreflightState {
  if (!text) return 'none';
  let inDecisions = false;
  let last: PreflightState = 'none';
  for (const line of text.split('\n')) {
    if (SECTION_RE.test(line)) {
      inDecisions = DECISIONS_RE.test(line);
      continue;
    }
    if (inDecisions && PREFLIGHT_RE.test(line)) last = DECAYED_RE.test(line) ? 'decayed' : 'done';
  }
  return last;
}

/**
 * La Size della task, ridotta alla sua prima parola maiuscola (`L`, `M`, `S`,
 * `EPIC`). Assente o vuota → `M`, come in `run-task` §4: la mancanza del campo
 * non deve far scattare il ramo più severo.
 */
export function taskSize(id: string, text: string | null): string {
  if (!text) return 'M';
  const raw = parseTaskDetail(id, text).fields['Size'] ?? '';
  return /^\s*([A-Za-z]+)/.exec(raw)?.[1]?.toUpperCase() ?? 'M';
}

export const DLV_REASON = {
  closed: 'task chiusa',
  empty: 'nessun deliverable in ## Deliverables Checklist',
  allDone: 'tutti i deliverable sono chiusi',
  decayed: 'premessa decaduta, run-task può rifiutare',
  sizeL: 'Size L senza preflight, run-task può rifiutare',
} as const;

/**
 * Il gate di `run-task` §3 visto dal deck, più i due casi in cui non c'è niente
 * da lanciare.
 *
 * L'ordine dei controlli è quello della domanda «cosa partirebbe?»: prima se c'è
 * qualcosa da eseguire, poi se la skill lo eseguirebbe. Su una task chiusa con
 * una premessa decaduta il motivo utile è «chiusa», non il preflight.
 *
 * `done` viene da `tasks.md` (la Prog ✔️ della lista, `isDone`) e non dal campo
 * `Progress` del task file: è la stessa fonte che usa il resto del deck, e il
 * testo che il detail ha in mano è già sanificato — il glifo di Done lì non è
 * più quello scritto su disco.
 *
 * `Size: Epic` non esclude (D2): un'epica con DLV propri resta lanciabile, e se
 * `run-task` si rifiuta il rifiuto è della skill, non del deck.
 */
export function dlvGate(
  id: string,
  text: string | null,
  dlvs: readonly Deliverable[],
  done: boolean,
): DlvGate {
  if (done) return { kind: 'off', reason: DLV_REASON.closed };
  if (dlvs.length === 0) return { kind: 'off', reason: DLV_REASON.empty };
  if (!dlvs.some((d) => !d.done)) return { kind: 'off', reason: DLV_REASON.allDone };
  const preflight = preflightState(text);
  if (preflight === 'decayed') return { kind: 'warn', reason: DLV_REASON.decayed };
  if (taskSize(id, text) === 'L' && preflight === 'none') {
    return { kind: 'warn', reason: DLV_REASON.sizeL };
  }
  return { kind: 'ready' };
}
