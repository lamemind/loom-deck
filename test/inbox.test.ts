// T134 — il lettore della coda inbox.
//
// Il difetto che questo banco esiste per impedire è un contatore che MENTE AL
// RIBASSO: un file che il lettore non sa parsare, scartato in silenzio, mostra
// una coda più corta del vero proprio quando qualcosa si è rotto. Da qui la
// fixture con un malformato deliberato — deve comparire in lista e restare
// fuori dai tre contatori, non sparire.
//
// L'altro asse è la distinzione fra ciò che entra nei numeri e ciò che entra
// nella lista (D5): il contatore promette lavoro che una skill può prendere da
// sola, la lista mostra tutto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageHours,
  inboxPrompt,
  countByNatura,
  inboxMark,
  isQueued,
  parseInboxTsv,
  staleCount,
  NATURA_SHORT,
  type InboxFile,
} from '../src/inbox.js';
import { inboxCounts, queuedTotal, selectInboxRows } from '../src/inbox-views.js';

/** Le colonne nell'ordine in cui `doc-metrics.sh --inbox --format tsv` le
 *  emette: PATH · NATURA · INDEXED · DRAINABLE · BRANCH · NOZIONI · APERTE ·
 *  CHAR · CREATED · AGE_DAYS · CAPPELLO. */
function tsvRow(cells: Partial<Record<string, string>> & { path: string }): string {
  return [
    cells.path,
    cells.natura ?? 'nozioni',
    cells.indexed ?? 'no',
    cells.drainable ?? 'si',
    cells.branch ?? '',
    cells.nozioni ?? '3',
    cells.aperte ?? '3',
    cells.chars ?? '1200',
    cells.created ?? '1000',
    cells.ageDays ?? '0',
    cells.cappello ?? 'T134',
  ].join('\t');
}

const HEADER =
  'PATH\tNATURA\tINDEXED\tDRAINABLE\tBRANCH\tNOZIONI\tAPERTE\tCHAR\tCREATED\tAGE_DAYS\tCAPPELLO';

/** Una coda vera nella forma che il deck riceve: le tre nature, un file
 *  congelato su branch, uno senza `drainable`, e un malformato — cioè le quattro
 *  ragioni per cui una riga può stare in lista senza stare nei numeri. */
const CODA = [
  HEADER,
  tsvRow({ path: 'runtime/inbox/a-nozioni.md', created: '100' }),
  tsvRow({ path: 'runtime/inbox/b-sweep.md', natura: 'sweep', created: '200' }),
  tsvRow({ path: 'runtime/inbox/c-deriv.md', natura: 'derivazione', created: '300' }),
  tsvRow({ path: 'runtime/inbox/d-branched.md', branch: 'feat/x', created: '400' }),
  tsvRow({ path: 'runtime/inbox/e-held.md', drainable: 'no', created: '500' }),
  // Un malformato dallo script arriva con natura `malformato` e le altre
  // colonne VUOTE: è la forma che il lettore deve reggere senza scartare.
  'runtime/inbox/f-rotto.md\tmalformato\t\t\t\t\t\t\t600\t\t',
  '',
].join('\n');

const files = parseInboxTsv(CODA);

test('parseInboxTsv: ogni riga di dati diventa un file, header escluso', () => {
  assert.equal(files.length, 6);
  assert.deepEqual(
    files.map((f) => f.basename),
    ['a-nozioni.md', 'b-sweep.md', 'c-deriv.md', 'd-branched.md', 'e-held.md', 'f-rotto.md'],
  );
});

test('parseInboxTsv: ordine dal più vecchio in cima (D8)', () => {
  const created = files.map((f) => f.created);
  assert.deepEqual(created, [...created].sort((a, b) => a - b));
  assert.equal(files[0]!.created, 100, 'in cima deve stare il più vecchio');
});

test('un malformato resta IN LISTA e non sparisce', () => {
  const rotto = files.find((f) => f.basename === 'f-rotto.md');
  assert.ok(rotto, 'il file malformato è stato scartato: la coda mente al ribasso');
  assert.equal(rotto!.natura, 'malformato');
  // Le colonne vuote non diventano marcatori accesi: un marcatore che non si è
  // potuto leggere non vale come presente.
  assert.equal(rotto!.drainable, false);
  assert.equal(rotto!.indexed, false);
  assert.equal(rotto!.branch, '');
  assert.equal(rotto!.nozioni, 0);
});

test('una natura fuori vocabolario collassa su malformato', () => {
  const [f] = parseInboxTsv(tsvRow({ path: 'x/y.md', natura: 'inventata' }));
  assert.equal(f!.natura, 'malformato');
});

test('righe più corte del tracciato si scartano invece di produrre campi a caso', () => {
  assert.deepEqual(parseInboxTsv('solo\tdue\tcolonne'), []);
});

test('isQueued: drainable, nessun branch, natura leggibile — tutte e tre', () => {
  const by = (name: string) => files.find((f) => f.basename === name)!;
  assert.equal(isQueued(by('a-nozioni.md')), true);
  assert.equal(isQueued(by('d-branched.md')), false, 'un branch congela per chiunque');
  assert.equal(isQueued(by('e-held.md')), false, 'senza drainable non è coda automatica');
  assert.equal(isQueued(by('f-rotto.md')), false, 'senza natura non lo prende nessuna skill');
});

test('countByNatura: nei numeri solo il drainable non-branched, tre nature separate', () => {
  const counts = countByNatura(files);
  assert.deepEqual(counts, { nozioni: 1, derivazione: 1, sweep: 1 });
  // Le tre righe fuori coda restano comunque in lista: sei righe, tre numeri.
  assert.equal(files.length, 6);
});

test('inboxMark: quattro casi, in ordine di precedenza', () => {
  const mk = (over: Partial<InboxFile>): InboxFile => ({
    path: 'p',
    basename: 'p',
    natura: 'nozioni',
    indexed: false,
    drainable: true,
    branch: '',
    nozioni: 1,
    aperte: 1,
    chars: 10,
    created: 0,
    cappello: '',
    ...over,
  });
  assert.equal(inboxMark(mk({})), 'queued');
  assert.equal(inboxMark(mk({ drainable: false })), 'held');
  assert.equal(inboxMark(mk({ branch: 'feat/x' })), 'branched');
  assert.equal(inboxMark(mk({ natura: 'malformato' })), 'broken');
  // La precedenza conta: un malformato su un branch resta un malformato — è
  // quello che decide che nessuna skill lo prende, e il branch non aggiunge
  // niente a un file che comunque va riparato prima.
  assert.equal(inboxMark(mk({ natura: 'malformato', branch: 'feat/x' })), 'broken');
  // Un branch batte l'assenza di drainable: il primo congela per chiunque, la
  // seconda no.
  assert.equal(inboxMark(mk({ branch: 'feat/x', drainable: false })), 'branched');
});

test('ageHours conta in ORE, non in giorni', () => {
  const created = 1_000_000; // epoch in secondi
  const now = created * 1000 + 47 * 3_600_000;
  assert.equal(ageHours(created, now), 47);
  // La colonna AGE_DAYS dello script è troncata al giorno: 47 e 49 ore
  // sarebbero lo stesso numero, e la soglia della sirena è in ore.
  assert.equal(ageHours(created, created * 1000 + 49 * 3_600_000), 49);
});

test('staleCount: solo i file IN CODA oltre soglia', () => {
  const now = 1000 * 1000 + 100 * 3_600_000;
  // Tutti i file della fixture hanno created ≤ 600s, quindi a `now` sono tutti
  // oltre 48 ore: a contare sono i soli tre in coda.
  assert.equal(staleCount(files, 48, now), 3);
  // Soglia più alta dell'età del più vecchio → nessuno.
  assert.equal(staleCount(files, 10_000, now), 0);
});

test('NATURA_SHORT copre ogni natura, larghezza costante', () => {
  const shorts = Object.values(NATURA_SHORT);
  assert.equal(shorts.length, 4, 'una short per natura, malformato compreso');
  for (const s of shorts) assert.equal(s.length, 3, `short di larghezza diversa: ${s}`);
});

// ── catalogo delle viste ──────────────────────────────────────────────────

test('inboxCounts: il totale è la lista, i tre numeri sono la coda', () => {
  const c = inboxCounts(files);
  assert.equal(c.total, 6, 'il totale conta ogni riga in lista');
  assert.equal(queuedTotal(c), 3, 'la somma delle nature conta solo la coda');
});

test('ogni vista mostra esattamente le righe che il suo numero dichiara', () => {
  const c = inboxCounts(files);
  assert.equal(selectInboxRows('all', files).length, c.total);
  assert.equal(selectInboxRows('nozioni', files).length, c.nozioni);
  assert.equal(selectInboxRows('derivazione', files).length, c.derivazione);
  assert.equal(selectInboxRows('sweep', files).length, c.sweep);
});

test('le viste di natura non ammettono righe fuori coda', () => {
  for (const id of ['nozioni', 'derivazione', 'sweep'] as const) {
    for (const f of selectInboxRows(id, files)) {
      assert.equal(f.natura, id);
      assert.ok(isQueued(f), `${f.basename} è in una vista di natura senza essere in coda`);
    }
  }
});

test('la vista Tutti si grigia sulla coda, non sul proprio contatore (D7)', () => {
  // Sei righe a schermo ma nessuna prendibile: il pane vale per il lavoro
  // ordinabile, quindi la voce è attenuata pur avendo un contatore pieno.
  const soloBloccati = files.filter((f) => !isQueued(f));
  const c = inboxCounts(soloBloccati);
  assert.equal(c.total, 3, 'le righe ci sono');
  assert.equal(queuedTotal(c), 0, 'ma non c\'è niente da prendere');
});

// ── il prompt per natura ──────────────────────────────────────────────────

test('inboxPrompt: una skill per natura, col basename come argomento', () => {
  const by = (name: string) => files.find((f) => f.basename === name)!;
  assert.equal(
    inboxPrompt(by('a-nozioni.md')),
    '/loom-works:drain-notions a-nozioni.md',
  );
  assert.equal(
    inboxPrompt(by('c-deriv.md')),
    '/loom-works:derive-notions c-deriv.md',
  );
  assert.equal(inboxPrompt(by('b-sweep.md')), '/loom-works:align-doc b-sweep.md');
});

test('inboxPrompt: su un malformato il prompt è di RIPARAZIONE, non di drain', () => {
  // Nessuna delle tre skill prende un file senza natura: offrirgliene una
  // aprirebbe una sessione destinata a fermarsi allo step 0.
  const p = inboxPrompt(files.find((f) => f.natura === 'malformato')!);
  assert.ok(!p.startsWith('/loom-works:'), `un malformato ha ricevuto un drain: ${p}`);
  assert.match(p, /f-rotto\.md/);
  assert.match(p, /marker/);
});

test('inboxPrompt: nessuna guardia su drainable o branch (D5)', () => {
  // Le tre skill dichiarano che un file NOMINATO si esegue anche senza
  // `drainable`, e il branch lo rifiutano loro. Una guardia qui impedirebbe
  // proprio ciò che l'utente ha appena chiesto aprendo il detail.
  const held = files.find((f) => f.basename === 'e-held.md')!;
  const branched = files.find((f) => f.basename === 'd-branched.md')!;
  assert.equal(inboxPrompt(held), '/loom-works:drain-notions e-held.md');
  assert.equal(inboxPrompt(branched), '/loom-works:drain-notions d-branched.md');
});

test('inboxPrompt: nessun backtick nel testo', () => {
  // Il prompt attraversa `--prompt` come argv singolo e poi `bash -lc` dentro
  // deck-run, che lo quota ad apici singoli: un backtick sarebbe inerte, ma il
  // testo si legge anche in riga di stato e in un titolo di tab.
  for (const f of files) assert.ok(!inboxPrompt(f).includes('`'), f.basename);
});
