// Rendering del markdown per il detail della task (T75): dal sorgente al
// testo VISIBILE più gli intervalli da colorare.
//
// PERCHÉ IL PARSER PRODUCE TESTO E NON COLORE. La tentazione naturale è
// restituire una stringa già colorata con escape ANSI dentro. Sarebbe il modo
// più corto e il più sbagliato: `width.ts` misura CARATTERI per contare le
// colonne del terminale, e una sequenza `ESC[1m` le violerebbe tutte —
// `termWidth` conterebbe colonne che il terminale non disegna, quindi l'a-capo
// cadrebbe nel posto sbagliato e il bordo del pane verrebbe mangiato.
//
// Da qui la separazione: qui si producono `(testo-visibile, span tipizzati)`,
// il colore lo mette il render intersecando gli span con le righe wrappate.
//
// PERCHÉ I MARKER VANNO VIA PRIMA DEL WRAP, non dopo. `**foo**` occupa 3
// colonne rese e 7 grezze. Wrappare sul testo con i marker manderebbe a capo
// contando 7, cioè ogni riga uscirebbe più corta del budget di 4 colonne per
// ogni `**` — un a-capo sbagliato, non un difetto estetico. La catena è quindi
// obbligata:
//
//   sanitize(raw)  →  parseMarkdown  →  wrapWithOffsets  →  interseca
//
// `sanitize` sta PRIMA (T75 · D1) perché non conserva la lunghezza: timbra col
// VS16 ogni glifo BMP largo 2 e sostituisce i discordi (`⚠`→`❗️`, `✔`→`✅️`),
// quindi applicarla dopo sposterebbe gli offset appena calcolati. Applicarla
// prima è sicuro perché i marker markdown sono ASCII e cadono fuori dal suo
// insieme di rischio. Nel deck la sanificazione avviene già al confine di
// caricamento (`loadTaskFileText`), quindi qui il testo arriva timbrato.
//
// GLI SPAN SONO PIATTI E DISGIUNTI. Il nesting del markdown (codice dentro un
// heading, grassetto dentro un bullet) è risolto QUI, non al render: ogni
// carattere del testo reso appartiene al più a uno span. Il render diventa
// così una mappa `kind → attributi Ink` senza logica di merge, ed è la stessa
// proprietà che permette di comporre questi span con quelli della ricerca
// (`sliceLine` in `text-search.ts`) senza che le due segmentazioni si
// contendano lo stesso carattere.

import type { WrappedLine } from './width.js';

/**
 * Costrutto reso, non tag markdown: `heading` e `fence` nascono dal blocco,
 * `bold` e `code` dall'inline. Il bullet non c'è — la sua resa è la
 * sostituzione del glifo, che avviene nel testo e non ha bisogno di colore.
 */
export type SpanKind = 'heading' | 'bold' | 'code' | 'fence';

/** Intervallo `[start, end)` nel testo RESO — mai nel sorgente. */
export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
}

export interface Rendered {
  /** Il testo senza marker: è questo che si wrappa, si cerca e si mostra. */
  text: string;
  /** In ordine di posizione, disgiunti, tutti dentro `[0, text.length)`. */
  spans: Span[];
}

/** Apertura o chiusura di un blocco di codice: almeno tre backtick a inizio
 *  riga, eventualmente indentati. La info-string dopo i backtick (` ```bash `)
 *  fa parte del delimitatore e sparisce con lui. */
const FENCE = /^\s*```/;

/** `# ` … `###### ` — lo spazio è obbligatorio, o `#tag` diventerebbe un
 *  titolo. Il livello non si conserva: la resa è la stessa per tutti (D4). */
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Voce di elenco: indentazione + marker + almeno uno spazio. Lo spazio
 *  obbligatorio è ciò che tiene fuori `---` (riga orizzontale) e `**bold**` a
 *  inizio riga, che altrimenti passerebbero per bullet. Indentazione e spazio
 *  dopo il marker sono catturati per essere RIMESSI identici: il glifo occupa
 *  una colonna come il marker che sostituisce, quindi conservare i due lati
 *  conserva la colonna d'inizio del testo, che è ciò che tiene allineato un
 *  elenco scritto a mano. */
const BULLET = /^(\s*)[-*+](\s+)/;

/** Il glifo del bullet. Concorde (`stringWidth` 1, `termWidth` 1), quindi si
 *  può inserire DOPO `sanitize` senza violare l'invariante ① di `width.ts`. */
const BULLET_GLYPH = '•';

/**
 * Testo reso e span di stile a partire dal markdown grezzo.
 *
 * Due livelli, e l'ordine fra loro non è negoziabile: il blocco decide se
 * l'inline gira o è sospeso. Dentro un fence `**` e i backtick sono contenuto,
 * non marcatura — una regex per riga non potrebbe saperlo, perché il fence ha
 * stato multi-riga.
 *
 * Fuori scope per scelta (T75): tabelle — l'inline ci gira sopra come ovunque,
 * ma le colonne non vengono allineate — corsivo e link.
 */
export function parseMarkdown(src: string): Rendered {
  const out: string[] = [];
  const spans: Span[] = [];
  /** Offset del reso a cui inizierà la prossima riga emessa. */
  let base = 0;
  let inFence = false;

  const emit = (text: string, lineSpans: Span[]) => {
    for (const s of lineSpans) {
      spans.push({ start: base + s.start, end: base + s.end, kind: s.kind });
    }
    out.push(text);
    base += text.length + 1; // +1 = il '\n' che unirà questa riga alla prossima
  };

  for (const line of src.split('\n')) {
    if (FENCE.test(line)) {
      // D2 — il delimitatore è un marker quanto `**` e `#`, quindi sparisce
      // come gli altri: il confine del blocco lo porta il colore uniforme.
      // Conseguenza contabile: due righe in meno per fence nel totale che
      // alimenta il contatore `righe N-M di T`.
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      emit(line, line.length > 0 ? [{ start: 0, end: line.length, kind: 'fence' }] : []);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const body = h[2]!;
      const r = scanInline(body, 'heading');
      emit(r.text, r.spans);
      continue;
    }

    const b = BULLET.exec(line);
    if (b) {
      const r = scanInline(line.slice(b[0].length), null);
      const prefix = b[1]! + BULLET_GLYPH + b[2]!;
      emit(
        prefix + r.text,
        r.spans.map((s) => ({ ...s, start: s.start + prefix.length, end: s.end + prefix.length })),
      );
      continue;
    }

    const r = scanInline(line, null);
    emit(r.text, r.spans);
  }

  return { text: out.join('\n'), spans };
}

/**
 * Livello inline: `**grassetto**` e `` `codice` `` su UNA riga.
 *
 * `base` è il costrutto che avvolge la riga (`heading`) o `null` per il testo
 * normale, e serve a due cose: riempire i tratti non marcati con lo stile del
 * blocco, e assorbire il grassetto quando il blocco è già enfatizzato — un
 * `**` dentro un titolo non deve spezzarlo in un pezzo cyan e uno bianco.
 *
 * **Il perimetro è la riga, e questo è il presidio contro il marker spaiato.**
 * Un `**` che non si chiude non può mangiare il resto del documento perché la
 * ricerca del chiudente non esce dalla riga: resta letterale, il testo non si
 * perde e il documento sotto è intatto.
 *
 * Precedenza al codice, come in CommonMark: dentro `` `**x**` `` gli asterischi
 * sono contenuto. Ne discende l'ordine dei rami qui sotto.
 */
function scanInline(src: string, base: SpanKind | null): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  /** Inizio del tratto corrente non ancora coperto da uno span inline. */
  let plain = 0;
  let i = 0;

  const closePlain = () => {
    if (base && text.length > plain) spans.push({ start: plain, end: text.length, kind: base });
    plain = text.length;
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '`') {
      // Delimitatore a N backtick: chiude su una sequenza di ESATTAMENTE N.
      // Serve davvero, non è zelo — la doc di questo progetto cita i backtick
      // scrivendo `` `code` ``, e un parser a un backtick solo la ridurrebbe a
      // poltiglia.
      let n = 0;
      while (src[i + n] === '`') n++;
      const close = findFenceRun(src, i + n, n);
      if (close >= 0) {
        closePlain();
        const start = text.length;
        text += stripPadding(src.slice(i + n, close));
        if (text.length > start) spans.push({ start, end: text.length, kind: 'code' });
        plain = text.length;
        i = close + n;
        continue;
      }
      // Non si chiude entro la riga: i backtick sono testo.
      text += src.slice(i, i + n);
      i += n;
      continue;
    }

    if (ch === '*' && src[i + 1] === '*') {
      const close = src.indexOf('**', i + 2);
      if (close >= 0) {
        closePlain();
        const start = text.length;
        // Il contenuto si riparsa: `**testo con `codice`**` è legittimo, e il
        // codice dentro vince sul grassetto perché è più specifico.
        const inner = scanInline(src.slice(i + 2, close), base ?? 'bold');
        text += inner.text;
        for (const s of inner.spans) {
          spans.push({ start: start + s.start, end: start + s.end, kind: s.kind });
        }
        plain = text.length;
        i = close + 2;
        continue;
      }
      text += '**';
      i += 2;
      continue;
    }

    text += ch;
    i++;
  }
  closePlain();

  return { text, spans: coalesce(spans) };
}

/** Prima sequenza di ESATTAMENTE `n` backtick a partire da `from`; -1 se non
 *  c'è. Una sequenza più lunga non chiude — è la regola CommonMark, ed è ciò
 *  che permette a `` `` ` `` `` di contenere un backtick singolo. */
function findFenceRun(s: string, from: number, n: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '`') continue;
    let k = 0;
    while (s[i + k] === '`') k++;
    if (k === n) return i;
    i += k - 1;
  }
  return -1;
}

/** Uno spazio di cortesia in testa e in coda si toglie: serve a scrivere
 *  `` ` `` senza incollarlo ai delimitatori, non a spaziare il risultato. */
function stripPadding(s: string): string {
  if (s.length > 1 && s.startsWith(' ') && s.endsWith(' ') && s.trim().length > 0) {
    return s.slice(1, -1);
  }
  return s;
}

/** Fonde gli intervalli adiacenti dello stesso kind: il riempimento del tratto
 *  base ne produce a raffica, e ognuno costerebbe un `<Text>` in più al
 *  render. */
function coalesce(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind && last.end === s.start) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Pezzo di riga con la propria resa. `kind` `null` = testo normale. */
export interface StyledSegment {
  text: string;
  kind: SpanKind | null;
}

/**
 * Taglia una riga wrappata nei pezzi da colorare, intersecando gli offset.
 *
 * Gemello di `sliceLine` (`text-search.ts`), che fa lo stesso lavoro con un
 * intervallo booleano invece che tipizzato: la riga è una fetta CONTIGUA del
 * testo reso, quindi uno span a cavallo dell'a-capo si colora su entrambe le
 * righe senza nessun caso speciale — entrambe lo intersecano.
 *
 * Restituisce sempre la copertura completa della riga, buchi inclusi come
 * segmenti `kind: null`: chi renderizza concatena e basta, senza dover
 * ricostruire ciò che è rimasto fuori.
 */
export function sliceSpans(line: WrappedLine, spans: readonly Span[]): StyledSegment[] {
  const out: StyledSegment[] = [];
  const { text, start } = line;
  let pos = 0;
  for (const s of spans) {
    if (s.end <= start) continue;
    if (s.start >= start + text.length) break; // `spans` è ordinato: il resto è oltre
    const a = Math.max(0, Math.min(text.length, s.start - start));
    const b = Math.max(0, Math.min(text.length, s.end - start));
    if (b <= a || a < pos) continue;
    if (a > pos) out.push({ text: text.slice(pos, a), kind: null });
    out.push({ text: text.slice(a, b), kind: s.kind });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), kind: null });
  return out;
}
