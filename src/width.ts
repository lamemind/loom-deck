// Contabilità UNICA della larghezza — fonte di verità per «quanto è larga
// questa stringa sullo schermo».
//
// PERCHÉ ESISTE. Nel frame convivevano tre unità di misura diverse, e nessuna
// era la colonna del terminale:
//
//   1. `string-width` — quella con cui Ink misura per il layout (Yoga) e per il
//      troncamento. Conta 2 ogni emoji, VS16 o no.
//   2. `.length` / `.slice` — code unit UTF-16, usate dai vecchi `truncate` e
//      `wrapLines`. Un emoji astrale (`🔥`) sono 2 unità per 2 colonne (caso
//      fortunato), uno BMP (`⚡`) 1 unità per 2 colonne (sbagliato).
//   3. `slice-ansi`, dentro `cli-truncate`, dentro `wrap="truncate-end"` di Ink
//      (`ink/build/wrap-text.js`): indicizza per CODE POINT ma riceve un budget
//      di COLONNE. Ogni glifo largo 2 che sta a sinistra del taglio fa uscire
//      la riga 1 colonna più larga del richiesto.
//   4. VTE/Ptyxis, che disegna: largo 2 solo se East-Asian-Width ∈ {W, F}, con
//      gli Ambiguous a 1 e il VS16 IGNORATO.
//
// Una riga più larga del riservato sovrascrive il bordo del pane nella griglia
// di caratteri di Ink (bordo mangiato = layout sminchiato) e, quando il taglio
// cade su un glifo largo, fa crescere la riga composta oltre `columns`: il
// terminale la manda a capo, compare una riga vuota e tutto ciò che sta sotto
// slitta di una riga. Una riga più STRETTA del riservato sposta a sinistra
// bordo e pane vicino, sempre e solo sulle righe che contengono il glifo.
//
// LE TRE INVARIANTI. Tutto il resto del deck si appoggia a queste:
//
//   ① Alfabeto concorde — nel frame entrano solo caratteri per cui
//      `stringWidth(ch) === termWidth(ch)`. Il predicato è CALCOLATO, non una
//      lista: qualunque glifo nuovo (in una descrizione, in un transcript) è
//      giudicato dalla stessa regola. I discordi sono i ~120 emoji a
//      presentazione-testo del BMP (`▶ ✔ ⚠ ❤ ✂ ➡ …`): string-width li dà 2, il
//      terminale ne disegna 1. Non sono riparabili con un selettore di
//      variazione (né VS16 né VS15 cambiano il verdetto di string-width) →
//      vengono SOSTITUITI con un gemello concorde.
//
//   ② VS16 sui glifi larghi 2 del BMP, e SOLO su quelli. Ink compone il frame
//      su una griglia di celle assegnando 2 celle a un carattere se
//      `isFullwidthCodePoint(cp) || value.length > 1`
//      (`@alcalzone/ansi-tokenize`, un token per CODE POINT). `isFullwidthCodePoint`
//      copre il CJK ma NON gli emoji, quindi:
//        · astrale (`🔥`, 2 code unit) → `value.length > 1` → 2 celle, giusto;
//        · BMP largo 2 (`⚡`, 1 code unit) → 1 sola cella, una in meno del dovuto;
//        · BMP + VS16 → 1 + 1 = 2 celle, di nuovo giusto.
//      Timbrare un ASTRALE è quindi l'errore opposto: gli darebbe 3 celle per 2
//      colonne e la riga uscirebbe una colonna più CORTA del padding calcolato.
//
//   ③ Il taglio lo fa il deck, non Ink. Restava scoperta la terza contabilità
//      (`slice-ansi`, per code point): con un budget di colonne in ingresso,
//      ogni glifo largo 2 a sinistra del taglio allarga il risultato di una
//      colonna, e nessun timbro può ripararlo senza rompere ② o ①. L'unica via
//      è non farlo mai intervenire: chi renderizza una riga a lunghezza libera
//      la taglia PRIMA con `cut()`, su un budget derivato da `columns`.
//      `wrap="truncate-end"` resta come rete, non come meccanismo.
//
// L'assunzione sul terminale (EAW, ambiguous = 1, VS16 ignorato) vive TUTTA in
// `termWidth`. Se un giorno cambia il terminale, cambia questa funzione e basta.

import stringWidth from 'string-width';
import { eastAsianWidth } from 'get-east-asian-width';

/** Variation Selector-16: forza la presentazione emoji del carattere che precede. */
const VS16 = '️';

/** Zero-width per il terminale: combining marks e format chars (VS16 incluso). */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Larghezza in colonne secondo il TERMINALE (VTE/Ptyxis).
 *
 * `eastAsianWidth` restituisce già 1 per gli Ambiguous — che è il default di
 * VTE (`utf8-ambiguous-width`) e il motivo per cui `▶` (EAW = Ambiguous) e `✔`
 * (EAW = Neutral) vengono disegnati stretti anche col VS16 appiccicato.
 */
export function termWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ZERO_WIDTH.test(ch)) continue;
    w += eastAsianWidth(ch.codePointAt(0)!);
  }
  return w;
}

/** Il carattere è misurato allo stesso modo da Ink e dal terminale? */
export function agrees(ch: string): boolean {
  return stringWidth(ch) === termWidth(ch);
}

/**
 * Sostituzioni esplicite per i discordi che il deck usa come SEGNALE: qui la
 * semantica del glifo va preservata, non degradata a segnaposto.
 *
 * I sostituti sono concordi per costruzione (verificati dal test): `▸` è
 * Neutral e non-emoji → 1 ovunque; `✅` `❗` sono astrali a presentazione-emoji
 * → 2 ovunque.
 */
const GLYPH_MAP = new Map<string, string>([
  ['▶', '▸'], // caret di selezione
  ['◀', '◂'],
  ['✔', '✅'], // marker Done
  ['☑', '✅'],
  ['✖', '❌'],
  ['⚠', '❗'], // warning (riga pin stale)
  ['❗', '❗'],
]);

/**
 * Segnaposto per i discordi che arrivano da testo NON nostro (descrizioni,
 * titoli, corpi dei transcript): non c'è una traduzione sensata glifo-per-glifo
 * di `❤ ✂ ☀ ➡ …`, e lasciarli passare romperebbe la riga che li ospita.
 * Largo 1 e concorde.
 */
const FILLER = '·';

/**
 * Fast-path: sotto U+1100 non esiste né un wide né un discorde, quindi non
 * c’è niente da sanificare. `\n` e `\t` stanno fuori dal sospetto pur essendo
 * control char — li normalizzano i chiamanti (`wrapLines` collassa il
 * whitespace, `wrapWithOffsets` li mappa preservando gli offset) e tenerli
 * dentro costerebbe il fast-path su OGNI corpo di transcript, visto che
 * `sanitize` gira anche sui ~10 MB di testo cercabile del progetto.
 */
const SUSPECT = /[^\n\t\u0020-\u10FF]/;

/**
 * Byte di controllo che il terminale INTERPRETA — ESC in testa. Passati nudi
 * da un transcript muoverebbero il cursore o cambierebbero i colori dal mezzo
 * di una preview. Diventano uno spazio: largo 1, concorde, inerte.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Sostituzione di UN carattere secondo le invarianti ① e ②. Memoizzata: i
 * corpi cercabili sono ~10 MB e i caratteri distinti che li attraversano sono
 * poche decine — misurare la stessa emoji un milione di volte è il costo che
 * questa cache toglie.
 */
const FIXED = new Map<string, string>();

function fixChar(ch: string): string {
  const cached = FIXED.get(ch);
  if (cached !== undefined) return cached;
  let out: string;
  if (CONTROL.test(ch)) {
    out = ' ';
  } else if (ZERO_WIDTH.test(ch)) {
    // Il VS16 in ingresso si scarta SEMPRE: se serve lo ri-mette il ramo ② sul
    // carattere che lo precede. Passare da «scarta e ri-timbra» invece che da
    // «tieni se c'è» è ciò che rende `sanitize` idempotente. Le altre combining
    // mark e i format char restano dove sono (0 colonne per entrambe le conte).
    out = ch === VS16 ? '' : ch;
  } else {
    const fixedGlyph = agrees(ch) ? ch : (GLYPH_MAP.get(ch) ?? FILLER); // ①
    // ② una cella per colonna nella griglia di Ink — SOLO sui BMP.
    const bmpWide = fixedGlyph.codePointAt(0)! < 0x10000 && termWidth(fixedGlyph) === 2;
    out = bmpWide ? fixedGlyph + VS16 : fixedGlyph;
  }
  FIXED.set(ch, out);
  return out;
}

/**
 * Caratteri che possono violare un'invariante: control char, tutto ciò che sta
 * da U+1100 in su (primo wide dell'insieme) e gli astrali. `\n` e `\t` restano
 * fuori — li normalizzano i chiamanti, e includerli qui costerebbe una
 * sostituzione su ogni riga di ogni transcript.
 */
const RISKY = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|[\u1100-\uFFFF]|[\u{10000}-\u{10FFFF}]/gu;

/**
 * Rende una stringa sicura da mettere nel frame: applica le invarianti ① e ②.
 *
 * Idempotente, e a costo quasi zero sul testo ASCII (fast-path) — cioè sulla
 * stragrande maggioranza dei corpi di transcript, che è il volume vero: la
 * versione carattere-per-carattere costava secondi all'avvio del deck.
 */
export function sanitize(s: string): string {
  if (!s || !SUSPECT.test(s)) return s;
  return s.replace(RISKY, fixChar);
}

/**
 * Taglio a un budget di COLONNE, ellissi inclusa nel budget.
 *
 * Rimpiazza il vecchio `truncate`, che tagliava per code unit: su una riga con
 * due emoji il risultato usciva 2 colonne oltre il budget, cioè esattamente
 * dentro il bordo del pane.
 *
 * Collassa il whitespace come faceva il predecessore: i chiamanti passano
 * descrizioni multi-riga e si aspettano un blocco unico.
 */
export function cut(s: string, cols: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (cols <= 0) return '';
  if (termWidth(flat) <= cols) return flat;
  if (cols === 1) return '…';

  let out = '';
  let w = 0;
  for (const ch of flat) {
    const cw = termWidth(ch);
    if (w + cw > cols - 1) break; // -1 = la colonna dell'ellissi
    out += ch;
    w += cw;
  }
  // Un estratto può arrivare qui con la SUA ellissi già in coda (la ricerca
  // ritaglia il contesto attorno al match): due ellissi di fila non aggiungono
  // informazione, tolgono una colonna di testo.
  return out.trimEnd().replace(/…$/, '') + '…';
}

/**
 * Cella di larghezza ESATTA `cols`: taglia se eccede, riempie di spazi se manca.
 *
 * È il gemello di `cut` e serve a una cosa sola: fare colonne vere. Una lista
 * incolonnata a mano allinea solo finché ogni cella misura davvero quanto
 * dichiara — e la misura è in COLONNE del terminale (`termWidth`), non in
 * caratteri: `'○'.padEnd(2)` e `'🔗'.padEnd(2)` danno due stringhe che
 * `String.length` giura uguali e che il terminale disegna larghe 2 e 3. È
 * esattamente lo slittamento di una colonna che rende ragged una lista.
 *
 * `align: 'right'` mette il riempimento davanti: serve ai campi ancorati al
 * margine destro (la data), dove ad allinearsi sono le unità, non l'inizio.
 */
export function pad(s: string, cols: number, align: 'left' | 'right' = 'left'): string {
  if (cols <= 0) return '';
  const t = termWidth(s) > cols ? cut(s, cols) : s;
  const fill = ' '.repeat(Math.max(0, cols - termWidth(t)));
  return align === 'right' ? fill + t : t + fill;
}

/**
 * Larghezza in colonne di UN carattere **dopo** `sanitize`.
 *
 * Misurare il carattere grezzo significa misurare qualcosa che nel frame non
 * entra mai: la sanificazione può cambiarne la larghezza (`✔`, largo 1, diventa
 * `✅`, largo 2 — invariante ①). Chi taglia su un budget deve contare le colonne
 * che verranno DISEGNATE, altrimenti sbaglia di una colonna per ogni glifo
 * sostituito. La cache di `fixChar` rende la doppia chiamata gratuita.
 */
export function cellWidth(ch: string): number {
  return termWidth(sanitize(ch));
}

/** Finestra di testo attorno a un caret, già spezzata per il render. */
export interface CaretWindow {
  /** Testo a sinistra del cursore, ellissi di testa inclusa. */
  head: string;
  /** Cella SOTTO il cursore: un carattere del testo, o uno spazio a fine campo. */
  at: string;
  /** Testo a destra del cursore, ellissi di coda inclusa. */
  tail: string;
  /** Colonna in cui cade il cursore dentro la finestra (= larghezza di `head`). */
  cursorCol: number;
}

/**
 * Porzione visibile di un campo di testo con un caret MOBILE, larga al più
 * `cols` colonne.
 *
 * Perché non basta un taglio dalla coda: mostrare sempre le ultime `cols`
 * colonne è corretto solo finché si scrive in fondo. Con un caret che si muove,
 * appena rientra a sinistra del bordo visibile si finirebbe per digitare in un
 * punto che non si vede — il testo deve scorrere DIETRO il cursore, non
 * viceversa.
 *
 * Il caret è un indice per CODE POINT (`[...s]`), non per code unit: un'emoji
 * nel titolo sono due code unit e muoversi per unità la spezzerebbe a metà.
 *
 * La finestra si espande ALTERNANDO i due lati, così il cursore resta al centro
 * finché il testo lo consente: muoversi di un carattere fa scorrere il testo di
 * uno, invece di far saltare la vista da un bordo all'altro. Le ellissi entrano
 * nel budget e ne escono da sole — quando un lato tocca il bordo del testo la
 * sua ellissi non serve più e la colonna liberata va all'altro lato.
 *
 * Restituisce i tre pezzi già pronti al render (non la sola stringa visibile):
 * il cursore si disegna invertendo `at`, e ricavarlo tagliando `visible` a
 * `cursorCol` vorrebbe dire rifare qui fuori lo stesso conteggio in colonne.
 */
export function caretWindow(text: string, caret: number, cols: number): CaretWindow {
  const empty: CaretWindow = { head: '', at: '', tail: '', cursorCol: 0 };
  if (cols <= 0) return empty;

  const chars = [...text];
  const c = Math.max(0, Math.min(caret, chars.length));
  // Il caret a fine campo non ha un carattere sotto di sé: gliene si dà uno
  // virtuale, così il cursore ha sempre una cella da invertire e la finestra ha
  // sempre un centro. È lo spazio inverso che il modale disegnava in coda.
  const cells = c === chars.length ? [...chars, ' '] : chars;
  const len = cells.length;
  const w = cells.map(cellWidth);

  const cost = (s: number, e: number, tw: number) => tw + (s > 0 ? 1 : 0) + (e < len ? 1 : 0);

  let start = c;
  let end = c + 1;
  let textW = w[c]!;
  // Budget più stretto della sola cella del cursore: non c'è finestra da dare.
  if (cost(start, end, textW) > cols) return empty;

  let goRight = true;
  let stuckL = false;
  let stuckR = false;
  while (!stuckL || !stuckR) {
    const canR = end < len && !stuckR;
    const canL = start > 0 && !stuckL;
    if (!canR && !canL) break;
    if (canR && (goRight || !canL)) {
      const nw = textW + w[end]!;
      if (cost(start, end + 1, nw) > cols) stuckR = true;
      else {
        textW = nw;
        end++;
        // Arrivare in fondo toglie l'ellissi di coda: la colonna che si libera
        // può rimettere in gioco il lato che si era fermato per un pelo.
        if (end === len) stuckL = false;
      }
    } else {
      const nw = textW + w[start - 1]!;
      if (cost(start - 1, end, nw) > cols) stuckL = true;
      else {
        textW = nw;
        start--;
        if (start === 0) stuckR = false;
      }
    }
    goRight = !goRight;
  }

  const head = (start > 0 ? '…' : '') + cells.slice(start, c).join('');
  return {
    head,
    at: cells[c]!,
    tail: cells.slice(c + 1, end).join('') + (end < len ? '…' : ''),
    cursorCol: termWidth(sanitize(head)),
  };
}

/** Riga wrappata che sa da dove viene: `start`/`end` sono offset nel testo
 *  SORGENTE, e servono a evidenziare il match a cavallo dell'a-capo. */
export interface WrappedLine {
  text: string;
  start: number;
  end: number;
}

/**
 * Indice sorgente raggiunto consumando al più `cols` colonne da `from`.
 *
 * Il conteggio è per colonne, l'indice restituito è in code unit: è ciò che
 * tiene gli offset del match allineati al sorgente mentre l'a-capo ragiona in
 * colonne.
 */
function advance(line: string, from: number, cols: number): number {
  let i = from;
  let w = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = termWidth(ch);
    if (w + cw > cols) break;
    w += cw;
    i += ch.length;
  }
  return i;
}

/**
 * A-capo che PRESERVA la struttura del testo e traccia gli offset.
 *
 * Distinto da `wrapLines`, che collassa tutto in un flusso unico: lì serve una
 * preview compatta di 2-4 righe, qui si legge un messaggio intero — appiattire
 * le newline renderebbe illeggibile qualunque blocco di codice o elenco.
 *
 * Ogni riga prodotta è una FETTA CONTIGUA del sorgente: è ciò che permette di
 * intersecarla con l'intervallo del match e colorare solo la parte giusta,
 * anche quando il match cade a cavallo di due righe.
 *
 * Taglia sull'ultimo spazio disponibile; una parola più larga della riga viene
 * spezzata a forza, altrimenti l'a-capo lo farebbe il terminale — fuori dal
 * conteggio delle righe, cioè di nuovo un frame più alto di `rows`.
 */
export function wrapWithOffsets(text: string, width: number): WrappedLine[] {
  const out: WrappedLine[] = [];
  if (width <= 0) return out;

  let base = 0;
  for (const raw of text.split('\n')) {
    // Tab e CR diventano UN singolo spazio, non quattro: la sostituzione deve
    // conservare la lunghezza, o gli offset delle righe smettono di indicizzare
    // il sorgente e il match verrebbe evidenziato spostato. Un tab lasciato
    // passare sarebbe l'errore opposto — lo conteremmo 1 e il terminale 8.
    const line = raw.replace(/[\t\r]/g, ' ');
    if (line.length === 0) {
      out.push({ text: '', start: base, end: base });
    }
    let pos = 0;
    while (pos < line.length) {
      const stop = advance(line, pos, width);
      if (stop >= line.length) {
        out.push({ text: line.slice(pos), start: base + pos, end: base + line.length });
        break;
      }
      let brk = line.lastIndexOf(' ', stop);
      if (brk <= pos) brk = stop; // parola più lunga della riga
      out.push({ text: line.slice(pos, brk), start: base + pos, end: base + brk });
      pos = brk;
      while (line[pos] === ' ') pos++; // lo spazio del taglio non apre la riga dopo
    }
    base += raw.length + 1; // +1 = il '\n' consumato dallo split
  }
  return out;
}

/**
 * Hard-wrap a larghezza fissa, con tetto di righe.
 *
 * Serve un conteggio righe DETERMINISTICO: `<Text wrap="wrap">` di Ink wrappa a
 * runtime su una larghezza che il budget non conosce, quindi il pannello
 * dettaglio potrebbe sforare il tetto e riaprire il bug dell'altezza. Qui il
 * testo viene spezzato prima, e ogni riga è renderizzata con `truncate-end`.
 *
 * Sottostimare `width` è sicuro (tronca prima), sovrastimarlo no (la riga
 * andrebbe a capo aggiungendo altezza non contabilizzata).
 */
export function wrapLines(text: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0 || width <= 0) return [];
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];

  const lines: string[] = [];
  let line = '';
  const push = () => {
    lines.push(line);
    line = '';
  };
  for (const word of flat.split(' ')) {
    if (!line) {
      line = word;
    } else if (termWidth(line) + 1 + termWidth(word) <= width) {
      line += ' ' + word;
    } else {
      push();
      line = word;
      if (lines.length === maxLines) break;
    }
    // Parola più lunga della riga: spezzala a forza, altrimenti l'a-capo lo
    // farebbe il terminale — fuori dal nostro conteggio.
    while (termWidth(line) > width) {
      const stop = advance(line, 0, width);
      lines.push(line.slice(0, stop));
      line = line.slice(stop);
      if (lines.length === maxLines) break;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  const kept = lines.slice(0, maxLines);
  // Troncamento MAI silenzioso, come le liste: l'ellissi segnala che il testo
  // continua oltre il pannello.
  const consumed = kept.join(' ').length;
  if (consumed < flat.length && kept.length > 0) {
    const last = kept[kept.length - 1]!;
    kept[kept.length - 1] = termWidth(last) >= width ? cut(last, width) : last + '…';
  }
  return kept;
}
