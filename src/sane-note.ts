// La riduzione della nota del titolo di una tab: l'unica, per il deck e per
// `deck-run`.
//
// La nota del titolo è l'UNICO ingresso di testo libero nel titolo di una tab,
// quindi non si quota: si RIDUCE a una whitelist chiusa di code point, e tutto
// ciò che non ci rientra sparisce senza errore. Da quando un TEMPLATE del titolo
// si scrive in una pagina e si salva su disco (T161), la riduzione si applica
// anche QUI, al confine — al salvataggio e alla lettura del blocco `spawn` —
// così quello che sta nel file è quello che la tab mostrerà.
//
// T176 — fino a T176 questo modulo era il gemello di `_sane_note`, la stessa
// riduzione scritta in bash dentro `deck-run`, e un test teneva uguali i due
// lati. Il composer della tab ora è TypeScript (`src/tab-compose.ts`) e chiama
// questa funzione: la whitelist ha due sedi da toccare insieme, questo file e le
// emoji dei titoli in `spawn-catalog.ts`, e `test/deck-run.test.ts` fallisce se
// un'emoji di un titolo del catalogo non passa.

/**
 * L'alfabeto ammesso, negato: lettere, cifre, spazio, `_`, `-`, le accentate
 * italiane e sette emoji.
 *
 * Whitelist e non blacklist: il titolo finisce in una riga di shell su Linux
 * (`bash -lc "claude --name '…'"`) e nella riga di `wt.exe` su Windows, ed
 * enumerare i caratteri pericolosi significa sbagliarne uno.
 *
 * Le sette emoji sono nominate una per una e NON come intervallo di code point,
 * per due ragioni: un'emoji arriva nella tab solo
 * se il deck la mostra identica in lista, cioè se `sanitize` (`src/width.ts`) la
 * lascia passare invece di renderla `·`, e quel verdetto si verifica un glifo
 * alla volta; e l'ordine di un intervallo dentro un bracket expression segue la
 * collazione della locale, non i code point.
 *
 * Il flag `u` non è cosmetico: senza, le emoji astrali entrerebbero
 * nella classe come coppie di surrogati sciolti, e la riduzione lascerebbe
 * passare mezzo carattere di qualunque altra emoji che ne condivida il primo.
 */
const OUT_OF_ALPHABET = /[^A-Za-z0-9 _àèéìòùÀÈÉÌÒÙ📐🚀📊🏁🧹📏🧭-]/gu;

/** Cap in CARATTERI (code point), non in byte: a byte un taglio a metà di una
 *  `à` lascerebbe UTF-8 rotto nel titolo. Largo di proposito — una tab che sfora
 *  tronca a destra da sola, e il limite serve solo a non spingere fuori vista la
 *  parte del titolo che compass matcha. */
export const SANE_CAP = 60;

/** Un buco di template: `{TASK}`, `{slug}`, `{file}`, `{path}`. La cattura nel
 *  gruppo è ciò che fa comparire i buchi nei dispari di `split`. */
const HOLE = /(\{[A-Za-z]+\})/;

/** Spazi collassati, estremi potati, cap: i tre passi che in bash sono `tr -s`,
 *  i due `${s#/%}` e `${s:0:60}`. */
function tidy(s: string): string {
  const squeezed = s.replace(/ +/g, ' ');
  const trimmed = squeezed.replace(/^ /, '').replace(/ $/, '');
  return [...trimmed].slice(0, SANE_CAP).join('');
}

/**
 * La nota ridotta, esattamente come la ridurrebbe `deck-run`.
 *
 * Si applica al titolo GIÀ interpolato, cioè al testo che finisce nel sidecar e
 * in `--title-note`: le due superfici che mostrano quel nome — la riga di lista
 * del deck, che legge la nota grezza dal sidecar, e la tab Ptyxis — devono
 * vedere la stessa stringa.
 */
export function saneNote(raw: string): string {
  return tidy(raw.replace(OUT_OF_ALPHABET, ''));
}

/**
 * La stessa riduzione, coi BUCHI preservati.
 *
 * Le graffe non sono nell'alfabeto: passare un template da `saneNote` lo
 * ridurrebbe a `📐 slug`, cioè a un titolo che nomina la parola «slug» invece di
 * interpolare il nome della task. Il template si riduce comunque — è testo
 * scritto a mano, e il resto della riga deve sopravvivere alla tab — ma i buchi
 * attraversano intatti e vengono riempiti dopo.
 *
 * Fuori dai buchi il comportamento è identico a `saneNote`, compresi collasso
 * degli spazi, potatura e cap: un template senza buchi passa dalle stesse regole
 * di una nota qualunque.
 */
export function saneTemplate(raw: string): string {
  return tidy(
    raw
      .split(HOLE)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(OUT_OF_ALPHABET, '')))
      .join(''),
  );
}

/**
 * Riempie i buchi di un template. `null` quando un buco nominato non ha un
 * valore da mettere.
 *
 * Il `null` non è difensivo, è il comportamento: un titolo `📐 {slug}` su una
 * task il cui file non si trova diventerebbe `📐` — un prefisso solo, uguale per
 * ogni task, che è peggio di nessun titolo. Chi chiama riceve `null` e apre la
 * conversazione senza nota, che è ciò che faceva il vecchio `fallbackTitle`
 * quando il task file mancava.
 *
 * I buchi non dichiarati dall'azione restano LETTERALI e non fanno fallire
 * l'interpolazione: non sono un valore mancante, sono testo che l'utente ha
 * scritto — e il giro di riduzione dopo l'interpolazione toglierà le graffe.
 */
export function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
): string | null {
  let missing = false;
  const filled = template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (!(name in values)) return whole;
    const v = values[name]!;
    if (!v) {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : filled;
}
