// T21 — MOUSE del deck: abilitazione del tracking SGR, parse delle sequenze,
// hit-test sulle superfici cliccabili.
//
// Tre fatti misurati sotto pty reggono tutto il modulo, e ognuno spiega una
// scelta che altrimenti sembrerebbe arbitraria.
//
// ① `useInput` di Ink riceve le sequenze mouse come TESTO, con l'ESC iniziale
//    strippato e nessun flag di `key` attivo: un click arriva come `[<0;5;3M`.
//    Un listener `data` raw agganciato a stdin accanto a Ink riceve gli stessi
//    identici chunk (i listener `data` sono broadcast) e NON impedisce che le
//    sequenze raggiungano comunque `useInput`. Il filtro dev'essere quindi
//    dentro `useInput` in ogni caso — da cui: un punto solo, non due.
// ② L'ESC è strippato solo se la sequenza APRE il chunk. In un chunk misto
//    tasto+mouse (`a\x1b[<0;7;2M`, una sola chiamata) l'ESC interno resta.
//    Il pattern lo rende quindi opzionale e lo consuma quando c'è, o
//    resterebbe un ESC orfano nel testo restituito al deck.
// ③ Modi di tracking `1000` (click) + `1006` (SGR) e basta. `1002` (drag) e
//    `1003` (ogni movimento) sono la sorgente documentata delle valanghe di
//    eventi che sotto render pesante si frammentano su stdin e leakano dentro
//    i campi di testo. Con soli 1000+1006 gli eventi sono due per click.

import { termWidth } from './width.js';

/** Un evento mouse SGR già parsato. `col`/`row` sono 1-based, come li manda il
 *  terminale. `button` è il codice grezzo: 0/1/2 = sinistro/centrale/destro,
 *  64/65 = rotella su/giù (bit 6), più i bit dei modificatori. */
export interface MouseEvent {
  button: number;
  col: number;
  row: number;
  /** `M` = pressione, `m` = rilascio. Il deck agisce sulla pressione. */
  press: boolean;
}

/**
 * Sequenza SGR: `ESC [ < b ; x ; y M|m`, con l'ESC opzionale (fatto ①).
 *
 * Il prezzo dell'ESC opzionale è che un INCOLLAGGIO della stringa letterale
 * `[<0;5;3M` dentro un campo di testo verrebbe letto come un click. È accettato
 * e non compensato: distinguerlo richiederebbe di fidarsi dell'ESC, che nel
 * caso più comune — la sequenza che apre il chunk — non c'è.
 */
const SGR_MOUSE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** `true` se il codice è una pressione di rotella (bit 6 del bottone). */
export function isWheel(button: number): boolean {
  return (button & 64) !== 0;
}

/**
 * Verso della rotella: `-1` su (codice 64), `+1` giù (65), `0` se non è una
 * rotella. Il verso sta nel bit 0, i modificatori nei bit 2-4 (shift/meta/
 * ctrl): `66`/`67` sono le rotelle orizzontali, che qui valgono `0` perché il
 * deck non ha nulla da scorrere in orizzontale.
 *
 * Un terminale manda la rotella come SOLA pressione (`M`), mai seguita da un
 * rilascio: un tacca = un evento, e il chiamante non deve dedoppiare come fa
 * per il click.
 */
export function wheelDir(button: number): -1 | 0 | 1 {
  if (!isWheel(button) || (button & 2) !== 0) return 0;
  return (button & 1) === 0 ? -1 : 1;
}

/**
 * Righe scorse per tacca di rotella nei contenuti lunghi (detail, project
 * status, reader). Tre è la convenzione dei terminali e dei browser: una tacca
 * a riga singola costringe a girare la rotella quanto basta a stancare la mano,
 * una a pagina salta il testo che si stava leggendo.
 */
export const WHEEL_LINES = 3;

/**
 * Separa le sequenze mouse dal testo di un chunk di `useInput`.
 *
 * Ritorna il testo RIPULITO (quello che il deck deve continuare a trattare come
 * input di tastiera) e gli eventi trovati, nell'ordine di arrivo.
 *
 * Una sequenza spezzata su due chunk — succede sotto render pesante — arriva
 * come due frammenti monchi: nessuno dei due matcha, quindi entrambi finiscono
 * nel testo ripulito. Il click va perso. È voluto: bufferizzare significherebbe
 * tenere uno stato fra due chiamate di `useInput` e decidere quando scade, e un
 * click perso costa una ripetizione mentre un buffer che non scade mai
 * inghiotte i tasti che seguono.
 */
export function takeMouse(input: string): { text: string; events: MouseEvent[] } {
  if (!input.includes('[<')) return { text: input, events: [] };
  const events: MouseEvent[] = [];
  const text = input.replace(SGR_MOUSE, (_all, b: string, x: string, y: string, kind: string) => {
    events.push({
      button: Number(b),
      col: Number(x),
      row: Number(y),
      press: kind === 'M',
    });
    return '';
  });
  return { text, events };
}

// ── Tracking: accensione, spegnimento, ripristino ───────────────────────────

const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';

/**
 * Ancoraggio del frame: pulisce lo schermo e riporta il cursore in alto a
 * sinistra PRIMA del primo render di Ink.
 *
 * Senza, l'hit-test non ha origine. Ink non posiziona mai il cursore in modo
 * assoluto (verificato sul flusso di byte: solo `\x1b[2K` e `\x1b[1A`, cioè
 * `log-update` puro): il frame nasce dove si trovava il cursore quando il
 * processo è partito — riga 1 in una tab appena aperta, più in basso dopo un
 * prompt di shell, più in alto ancora se la prima scrittura ha fatto scorrere
 * lo schermo. Una coordinata assoluta del mouse non sarebbe traducibile.
 *
 * Pinnato a riga 1 il frame ci RESTA, senza bisogno di ri-ancorarlo a ogni
 * resize: `log-update` cancella all'insù tante righe quante ne aveva scritte e
 * poi riscrive da lì, e il frame è alto al massimo `rows - 1` (lo garantisce lo
 * SLACK di `viewport.ts`) — quindi la scrittura non fa mai scorrere lo schermo
 * e la cancellazione riporta sempre il cursore a riga 1. È un punto fisso.
 */
export function anchorFrame(out: NodeJS.WriteStream = process.stdout): void {
  out.write('\x1b[2J\x1b[H');
}

/**
 * Accende il tracking e registra lo spegnimento su ogni via d'uscita.
 *
 * Un tracking lasciato acceso non è un difetto cosmetico: il terminale continua
 * a mandare sequenze a qualunque programma prenda il posto del deck, che se le
 * ritrova stampate come testo a ogni movimento.
 *
 * Due agganci coprono tutte le uscite, e la ragione per cui non ne basta uno è
 * che le due classi non si attraversano. L'evento `exit` copre l'uscita normale
 * (`exit()` di Ink, che è anche il secondo `^C` del deck) e il CRASH, perché
 * un'eccezione non catturata termina il processo passando comunque di lì. I
 * segnali no: `SIGINT`/`SIGTERM` terminano il processo senza emettere `exit`,
 * quindi vogliono un handler proprio — che poi deve ri-emettere il segnale, o
 * il processo resterebbe vivo (agganciare un handler ne disattiva la
 * terminazione di default). `^C` battuto dentro il deck non è nessuno dei due:
 * in raw mode è il byte `\x03` nello stream di input, che il deck consuma da sé
 * e che sfocia nell'uscita normale.
 *
 * Ritorna la funzione di spegnimento per chi voglia chiamarla da sé.
 */
export function enableMouse(out: NodeJS.WriteStream = process.stdout): () => void {
  let off = false;
  const disable = () => {
    if (off) return;
    off = true;
    try {
      out.write(DISABLE);
    } catch {
      // stdout già chiuso: non c'è più niente da ripristinare.
    }
  };
  out.write(ENABLE);
  process.on('exit', disable);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      disable();
      process.kill(process.pid, sig);
    });
  }
  return disable;
}

// ── Hit-test ────────────────────────────────────────────────────────────────

/** Una superficie cliccabile di una riga: `key` è il tasto che il click
 *  equivale a premere, `start`/`end` sono colonne 1-based, estremi inclusi. */
export interface Region {
  key: string;
  start: number;
  end: number;
}

/** Un pezzo di riga che porta un tasto: il testo così com'è renderizzato. */
export interface Segment {
  key: string;
  text: string;
}

/**
 * Colonne occupate da ogni segmento di una riga, dato il separatore che li
 * unisce e la colonna in cui la riga comincia.
 *
 * Deriva dall'ARITMETICA di layout, non da un registro popolato al render:
 * `measureElement` di Ink espone width e height ma mai la posizione assoluta di
 * un elemento, quindi la mappa coordinate→superficie va costruita comunque. Il
 * vincolo che la tiene onesta è che i `Segment` che entrano qui sono gli stessi
 * che compongono la stringa renderizzata — una sola fonte, non due conti
 * paralleli che possono divergere.
 *
 * La larghezza è quella del TERMINALE (`termWidth`), non quella di `cellWidth`
 * in `config.ts`: la seconda è una stima prudente che serve a decidere quante
 * voci stanno in riga e ha licenza di sovrastimare, mentre qui una colonna di
 * troppo sposta il bersaglio.
 */
export function rowRegions(segments: Segment[], sep: string, startCol: number): Region[] {
  const sepW = termWidth(sep);
  const out: Region[] = [];
  let col = startCol;
  for (const seg of segments) {
    const w = termWidth(seg.text);
    if (w > 0) out.push({ key: seg.key, start: col, end: col + w - 1 });
    col += w + sepW;
  }
  return out;
}

/** Il tasto della superficie sotto la colonna, o `null` fuori da tutte. */
export function hitRegion(regions: Region[], col: number): string | null {
  for (const r of regions) {
    if (col >= r.start && col <= r.end) return r.key;
  }
  return null;
}

/**
 * Riga del terminale (1-based) su cui vive la riga launch in modalità normale.
 *
 * Il frame è ancorato a riga 1 (`anchorFrame`) e le righe sopra la launch sono
 * fisse e sempre presenti: bordo superiore, testata (status + versione),
 * legenda tasti. Nessuna delle tre è condizionale in modalità normale — la
 * legenda tasti è una catena di ternari che rende SEMPRE esattamente un `Text`,
 * e la testata è una riga `space-between`. Tutto ciò che varia in altezza (i
 * due pane, il blocco preview, la riga di nota) sta SOTTO, quindi il conto non
 * dipende da quanto è popolato il progetto.
 */
export const LAUNCH_ROW = 4;

/** Colonna (1-based) del primo carattere di testo dentro il box esterno:
 *  bordo + `paddingX={1}`. */
export const FRAME_TEXT_COL = 3;
