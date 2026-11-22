// T134 — il lettore degli inbox.
//
// Il difetto che questo banco esiste per impedire è un contatore che MENTE AL
// RIBASSO: un file che il lettore non sa parsare, scartato in silenzio, mostra
// una lista più corta del vero proprio quando qualcosa si è rotto. Da qui la
// fixture con un malformato deliberato — deve comparire in lista e restare
// fuori dai tre contatori, non sparire.
//
// L'altro asse è la distinzione fra ciò che entra nei numeri e ciò che entra
// nella lista (D5): il contatore conta i file a rilascio chiuso, la lista
// mostra tutto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countByNatura,
  inboxMark,
  isReleased,
  parseInboxTsv,
  INBOX_MARK_LABEL,
  NATURA_SHORT,
  type InboxFile,
} from '../src/inbox.js';
import { inboxCounts, releasedTotal, selectInboxRows } from '../src/inbox-views.js';

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

/** Una cartella inbox vera nella forma che il deck riceve: le tre nature, un
 *  file congelato su branch, uno senza `drainable`, e un malformato — cioè le
 *  ragioni per cui una riga può stare in lista senza stare nei numeri. */
const INBOX = [
  HEADER,
  tsvRow({ path: 'runtime/inbox/a-nozioni.md', created: '100' }),
  tsvRow({ path: 'runtime/inbox/b-sweep.md', natura: 'sweep', created: '200' }),
  tsvRow({ path: 'runtime/inbox/c-deriv.md', natura: 'derivazione', created: '300' }),
  tsvRow({ path: 'runtime/inbox/d-branched.md', branch: 'feat/x', created: '400' }),
  tsvRow({ path: 'runtime/inbox/e-wip.md', drainable: 'no', created: '500' }),
  // Un malformato dallo script arriva con natura `malformato` e le altre
  // colonne VUOTE: è la forma che il lettore deve reggere senza scartare.
  'runtime/inbox/f-rotto.md\tmalformato\t\t\t\t\t\t\t600\t\t',
  '',
].join('\n');

const files = parseInboxTsv(INBOX);

test('parseInboxTsv: ogni riga di dati diventa un file, header escluso', () => {
  assert.equal(files.length, 6);
  assert.deepEqual(
    files.map((f) => f.basename),
    ['a-nozioni.md', 'b-sweep.md', 'c-deriv.md', 'd-branched.md', 'e-wip.md', 'f-rotto.md'],
  );
});

test('parseInboxTsv: ordine dal più vecchio in cima (D8)', () => {
  const created = files.map((f) => f.created);
  assert.deepEqual(created, [...created].sort((a, b) => a - b));
  assert.equal(files[0]!.created, 100, 'in cima deve stare il più vecchio');
});

test('un malformato resta IN LISTA e non sparisce', () => {
  const rotto = files.find((f) => f.basename === 'f-rotto.md');
  assert.ok(rotto, 'il file malformato è stato scartato: la lista mente al ribasso');
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

test('isReleased: drainable, nessun branch, natura leggibile — tutte e tre', () => {
  const by = (name: string) => files.find((f) => f.basename === name)!;
  assert.equal(isReleased(by('a-nozioni.md')), true);
  assert.equal(isReleased(by('d-branched.md')), false, 'un branch congela finché non è su main');
  assert.equal(isReleased(by('e-wip.md')), false, 'senza drainable il file è in lavorazione');
  assert.equal(isReleased(by('f-rotto.md')), false, 'senza natura non entra in nessun contatore');
});

test('countByNatura: nei numeri solo il drainable non-branched, tre nature separate', () => {
  const counts = countByNatura(files);
  assert.deepEqual(counts, { nozioni: 1, derivazione: 1, sweep: 1 });
  // Le tre righe fuori dai numeri restano comunque in lista: sei righe, tre numeri.
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
  assert.equal(inboxMark(mk({})), 'released');
  assert.equal(inboxMark(mk({ drainable: false })), 'wip');
  assert.equal(inboxMark(mk({ branch: 'feat/x' })), 'branched');
  assert.equal(inboxMark(mk({ natura: 'malformato' })), 'broken');
  // La precedenza conta: un malformato su un branch resta un malformato — il
  // branch non aggiunge niente a un file che comunque va riparato a mano.
  assert.equal(inboxMark(mk({ natura: 'malformato', branch: 'feat/x' })), 'broken');
  // Un branch batte l'assenza di drainable: il file resta congelato finché
  // `pull-repos` non trova il branch su main.
  assert.equal(inboxMark(mk({ branch: 'feat/x', drainable: false })), 'branched');
});

test('INBOX_MARK_LABEL: ogni stato ha una parola, nessuna di coda o di drain', () => {
  assert.deepEqual(INBOX_MARK_LABEL, {
    broken: 'marker illeggibile',
    branched: 'congelato su branch',
    wip: 'in lavorazione',
    released: 'rilascio chiuso',
  });
});

test('NATURA_SHORT copre ogni natura, larghezza costante', () => {
  const shorts = Object.values(NATURA_SHORT);
  assert.equal(shorts.length, 4, 'una short per natura, malformato compreso');
  for (const s of shorts) assert.equal(s.length, 3, `short di larghezza diversa: ${s}`);
});

// ── catalogo delle viste ──────────────────────────────────────────────────

test('inboxCounts: il totale è la lista, i tre numeri sono i rilasci chiusi', () => {
  const c = inboxCounts(files);
  assert.equal(c.total, 6, 'il totale conta ogni riga in lista');
  assert.equal(releasedTotal(c), 3, 'la somma delle nature conta solo i rilasci chiusi');
});

test('ogni vista mostra esattamente le righe che il suo numero dichiara', () => {
  const c = inboxCounts(files);
  assert.equal(selectInboxRows('all', files).length, c.total);
  assert.equal(selectInboxRows('nozioni', files).length, c.nozioni);
  assert.equal(selectInboxRows('derivazione', files).length, c.derivazione);
  assert.equal(selectInboxRows('sweep', files).length, c.sweep);
});

test('le viste di natura non ammettono righe che non siano rilasci chiusi', () => {
  for (const id of ['nozioni', 'derivazione', 'sweep'] as const) {
    for (const f of selectInboxRows(id, files)) {
      assert.equal(f.natura, id);
      assert.ok(isReleased(f), `${f.basename} è in una vista di natura senza rilascio chiuso`);
    }
  }
});

test('la vista Tutti si grigia sui rilasci chiusi, non sul proprio contatore (D7)', () => {
  // Righe a schermo ma nessun rilascio chiuso: la voce è attenuata pur avendo
  // un contatore pieno.
  const nessunRilascio = files.filter((f) => !isReleased(f));
  const c = inboxCounts(nessunRilascio);
  assert.equal(c.total, 3, 'le righe ci sono');
  assert.equal(releasedTotal(c), 0, 'ma nessuna descrive un rilascio chiuso');
});
