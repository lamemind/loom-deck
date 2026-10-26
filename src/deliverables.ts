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
