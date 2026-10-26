// T182 — il titolo della conversazione GEMELLA: un carattere in coda al
// `--name` quando una conversazione viva ha già chiesto lo stesso nome.
//
// Chi porta davanti la tab di una conversazione la cerca per titolo (coda via
// AT-SPI, `sessionsByName` di compass), e il titolo della tab è il `--name`
// passato a `claude`. Due conversazioni vive con lo stesso nome — tipico: il
// preflight e il run della stessa task — hanno due tab con lo stesso titolo, e
// chi cerca non può scegliere. Il lanciatore rende unico il secondo titolo; il
// primo lancio resta senza carattere, quindi nel caso normale il titolo è quello
// di sempre.
//
// Modulo PURO: i nomi chiesti dalle conversazioni vive arrivano già letti
// (`liveRequestedNames` in `live-sessions.ts`).

/**
 * I caratteri del gemello, nell'ordine in cui si assegnano: il primo gemello
 * prende `#`.
 *
 * GEMELLA di `TWIN_MARKS` in `loom-compass/compass@lamemind/model.js`, il
 * secondo lanciatore di conversazioni: nessun codice confronta le due copie, e
 * cambiarne una sola fa scegliere caratteri diversi ai due lanciatori senza
 * errore. Si toccano insieme.
 *
 * Ogni carattere sta fuori da cinque classi, e ognuna rompe un consumer in
 * silenzio:
 *  - fuori dall'ASCII a una cella: un simbolo di larghezza ambigua (`§`, `†`)
 *    occupa una o due celle a seconda della locale e sposta il taglio del
 *    titolo nella tab;
 *  - dentro l'alfabeto di `saneNote`: un carattere ammesso lì può arrivare da
 *    una nota digitata, e il gemello non si distingue più dal testo;
 *  - dentro `[A-Za-z0-9_-]`: il matcher di compass `titleKeyRe` riconosce una
 *    finestra con `^<emoji> <name>(?![\w-])`;
 *  - l'apice singolo: il titolo sta dentro `claude --name '…'` nella riga che
 *    `bash -lc` analizza;
 *  - i metacaratteri di shell (`; & $ \` | < >`): inerti fra apici, ma il test
 *    di `saneNote` asserisce che nessun `[;&`$]` sopravviva in un titolo, e un
 *    gemello della stessa classe renderebbe cieco quel test. Fuori anche la
 *    punteggiatura che si legge come testo (`. , : /`) e le parentesi.
 */
export const TWIN_MARKS = ['#', '+', '=', '~', '^', '%', '@', '*', '?', '!'] as const;

/**
 * Il titolo da usare: `base` se nessuna conversazione viva l'ha chiesto,
 * altrimenti `base` + spazio + il primo carattere di `TWIN_MARKS` che nessuna
 * conversazione viva porta già su quel nome.
 *
 * Lo spazio separa il carattere come ogni altro suffisso del titolo (` · T182`,
 * ` <nota>`, ` · fork`): incollato all'ultima parola si leggerebbe come un
 * refuso della nota. Il confronto è per uguaglianza intera, la stessa che fanno
 * coda e `sessionsByName`.
 *
 * Insieme esaurito → `base`: il lancio parte comunque, e chi cerca la tab per
 * titolo torna all'esito ambiguo che ha anche senza lanciatore.
 */
export function twinTitle(base: string, liveRequestedNames: readonly string[]): string {
  const taken = new Set(liveRequestedNames);
  if (!taken.has(base)) return base;
  for (const mark of TWIN_MARKS) {
    const candidate = `${base} ${mark}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}
