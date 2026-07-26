// T52 — core della ricerca full-text. Modulo puro: nessun I/O, nessun terminale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatcher,
  buildRows,
  excerptAround,
  firstRowKey,
  moveRowSelection,
  rowIndexOfKey,
  searchSessions,
  selectedRow,
  DEFAULT_OPTIONS,
  MAX_HITS_PER_SESSION,
  MAX_TOTAL_HITS,
  MIN_QUERY,
  type SearchOptions,
} from '../src/search.js';
import type { BodyKind, MessageBody, Session } from '../src/sessions.js';

let seq = 0;
function sess(sessionId: string, bodies: [BodyKind, string][], ts = ++seq): Session {
  return {
    sessionId,
    cwd: '/p',
    gitBranch: 'main',
    parentUuid: null,
    title: sessionId,
    ts,
    path: `/p/${sessionId}.jsonl`,
    sizeBytes: 100,
    turns: 1,
    customTitle: '',
    firstPrompt: '',
    lastReply: '',
    bodies: bodies.map(([kind, text], idx): MessageBody => ({ idx, kind, text })),
  };
}

function opts(over: Partial<SearchOptions> = {}): SearchOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...over,
    kinds: { ...DEFAULT_OPTIONS.kinds, ...(over.kinds ?? {}) },
  };
}

const ALL_KINDS = { ai: true, tool: true, human: true };

// ── soglia e stati leciti ───────────────────────────────────────────────────

test(`sotto ${MIN_QUERY} char non si cerca: lista vuota, nessun errore`, () => {
  const s = [sess('a', [['ai', 'longest-label vince sempre']])];
  for (const q of ['', 'l', 'lo']) {
    const r = searchSessions(s, '', q, opts());
    assert.equal(r.idle, true, `query "${q}" dovrebbe essere idle`);
    assert.equal(r.error, '');
    assert.deepEqual(r.groups, []);
  }
  assert.equal(searchSessions(s, '', 'lon', opts()).idle, false);
});

test('zero risultati è uno stato lecito, non un errore', () => {
  const r = searchSessions([sess('a', [['ai', 'niente qui']])], '', 'zzz', opts());
  assert.equal(r.idle, false);
  assert.equal(r.error, '');
  assert.equal(r.shown, 0);
  assert.equal(r.sessionCount, 0);
});

test('hash inesistente: nessun gruppo, nessun errore', () => {
  const r = searchSessions([sess('abcd1234', [['ai', 'testo']])], 'ffff', 'testo', opts());
  assert.equal(r.error, '');
  assert.equal(r.sessionCount, 0);
});

test('lista di sessioni vuota non esplode', () => {
  assert.equal(searchSessions([], '', 'query', opts()).shown, 0);
});

// ── hash per prefisso ───────────────────────────────────────────────────────

test('hash filtra per PREFISSO, non per uguaglianza', () => {
  const all = [sess('79e653ae-1111', [['ai', 'match qui']]), sess('4dccc30c-2222', [['ai', 'match qui']])];
  const r = searchSessions(all, '79e653ae', 'match', opts());
  assert.equal(r.sessionCount, 1);
  assert.equal(r.groups[0].session.sessionId, '79e653ae-1111');
});

test('hash case-insensitive e con spazi attorno', () => {
  const all = [sess('79E653AE-1111', [['ai', 'match qui']])];
  assert.equal(searchSessions(all, '  79e6 ', 'match', opts()).sessionCount, 1);
});

test('hash vuoto = tutte le sessioni', () => {
  const all = [sess('a1', [['ai', 'match']]), sess('b2', [['ai', 'match']])];
  assert.equal(searchSessions(all, '', 'match', opts()).sessionCount, 2);
});

// ── toggle di tipo ──────────────────────────────────────────────────────────

test('default: solo IA — tools e human sono fuori indice', () => {
  const s = [sess('a', [['ai', 'chiave ai'], ['tool', 'chiave tool'], ['human', 'chiave human']])];
  const r = searchSessions(s, '', 'chiave', opts());
  assert.equal(r.shown, 1);
  assert.equal(r.groups[0].hits[0].kind, 'ai');
});

test('accendere tools e human allarga subito i risultati', () => {
  const s = [sess('a', [['ai', 'chiave ai'], ['tool', 'chiave tool'], ['human', 'chiave human']])];
  const r = searchSessions(s, '', 'chiave', opts({ kinds: ALL_KINDS }));
  assert.deepEqual(r.groups[0].hits.map((h) => h.kind), ['ai', 'tool', 'human']);
});

test('spegnere tutti i tipi: nessun risultato, nessun errore', () => {
  const s = [sess('a', [['ai', 'chiave']])];
  const r = searchSessions(s, '', 'chiave', opts({ kinds: { ai: false, tool: false, human: false } }));
  assert.equal(r.shown, 0);
  assert.equal(r.error, '');
});

// ── matcher: literal, case, whole-word, regex ───────────────────────────────

test('literal: i metacaratteri della query sono testo, non sintassi', () => {
  const s = [sess('a', [['ai', 'usa a.b come chiave'], ['ai', 'ma non axb']])];
  const r = searchSessions(s, '', 'a.b', opts());
  assert.equal(r.shown, 1, '"a.b" literal non deve matchare "axb"');
  assert.equal(r.groups[0].hits[0].idx, 0);
});

test('case-insensitive di default, sensitive col toggle', () => {
  const s = [sess('a', [['ai', 'Longest-Label']])];
  assert.equal(searchSessions(s, '', 'longest', opts()).shown, 1);
  assert.equal(searchSessions(s, '', 'longest', opts({ caseSensitive: true })).shown, 0);
  assert.equal(searchSessions(s, '', 'Longest', opts({ caseSensitive: true })).shown, 1);
});

test('whole-word esclude i match dentro una parola più lunga', () => {
  const s = [sess('a', [['ai', 'label e labelling']])];
  assert.equal(searchSessions(s, '', 'label', opts()).shown, 2);
  assert.equal(searchSessions(s, '', 'label', opts({ wholeWord: true })).shown, 1);
});

test('whole-word su regex avvolge TUTTA l\'alternativa, non il solo primo ramo', () => {
  const s = [sess('a', [['ai', 'foo fooX bar barX']])];
  const r = searchSessions(s, '', 'foo|bar', opts({ regex: true, wholeWord: true }));
  assert.equal(r.shown, 2, 'devono restare solo `foo` e `bar` interi');
});

test('regex + case-sensitive si combinano', () => {
  const s = [sess('a', [['ai', 'T52 e t52']])];
  assert.equal(searchSessions(s, '', 'T\\d+', opts({ regex: true, caseSensitive: true })).shown, 1);
  assert.equal(searchSessions(s, '', 'T\\d+', opts({ regex: true })).shown, 2);
});

test('regex INVALIDA: nessun crash, errore riportato, lista svuotata', () => {
  const s = [sess('a', [['ai', 'testo qualsiasi']])];
  // Stati intermedi normali mentre si digita una regex carattere per carattere.
  for (const q of ['[a-', '(ab', '*bad', 'a)b', '(?<']) {
    const r = searchSessions(s, '', q, opts({ regex: true }));
    assert.notEqual(r.error, '', `"${q}" doveva riportare un errore`);
    assert.deepEqual(r.groups, [], `"${q}" doveva svuotare la lista`);
    assert.equal(r.idle, false);
  }
});

test('quantificatore non terminato è LEGALE in JS: `a{2,` è il letterale "a{2,"', () => {
  // Non è un dettaglio da nerd: mentre si digita `a{2,3}` si attraversa `a{2,`,
  // e se quello stato fosse un errore la lista lampeggerebbe rossa a metà parola.
  // JS (Annex B) lo degrada a testo, quindi lo stato intermedio è silenzioso.
  const s = [sess('a', [['ai', 'ecco a{2, scritto letterale']])];
  const r = searchSessions(s, '', 'a{2,', opts({ regex: true }));
  assert.equal(r.error, '');
  assert.equal(r.shown, 1);
});

test('la stessa query invalida in modalità LITERAL è solo testo', () => {
  const s = [sess('a', [['ai', 'un [a- letterale']])];
  const r = searchSessions(s, '', '[a-', opts());
  assert.equal(r.error, '');
  assert.equal(r.shown, 1);
});

test('regex che matcha la stringa vuota non manda in loop infinito', () => {
  const s = [sess('a', [['ai', 'abc']])];
  const r = searchSessions(s, '', 'x*a', opts({ regex: true }));
  assert.equal(r.error, '');
  assert.ok(r.shown >= 1);
});

test('buildMatcher restituisce null senza lanciare su query invalida', () => {
  const { re, error } = buildMatcher('[a-', { ...DEFAULT_OPTIONS, regex: true });
  assert.equal(re, null);
  assert.notEqual(error, '');
});

// ── estratto centrato ───────────────────────────────────────────────────────

test('estratto: match al centro, ellissi su entrambi i bordi', () => {
  const text = 'x'.repeat(100) + 'CHIAVE' + 'y'.repeat(100);
  const e = excerptAround(text, 100, 106, 50);
  assert.ok(e.startsWith('…'), 'ellissi a sinistra');
  assert.ok(e.endsWith('…'), 'ellissi a destra');
  assert.ok(e.includes('CHIAVE'));
  const pos = e.indexOf('CHIAVE');
  // ±3 char di tolleranza sull'arrotondamento della metà.
  assert.ok(Math.abs(pos - (e.length - pos - 6)) <= 3, `match non centrato: ${e}`);
});

test('estratto: match a INIZIO messaggio, nessuna ellissi a sinistra', () => {
  const text = 'CHIAVE' + 'y'.repeat(100);
  const e = excerptAround(text, 0, 6, 50);
  assert.ok(!e.startsWith('…'));
  assert.ok(e.startsWith('CHIAVE'));
  assert.ok(e.endsWith('…'));
});

test('estratto: match a FINE messaggio, il contesto va tutto a sinistra', () => {
  const text = 'x'.repeat(100) + 'CHIAVE';
  const e = excerptAround(text, 100, 106, 50);
  assert.ok(e.startsWith('…'));
  assert.ok(e.endsWith('CHIAVE'));
  assert.ok(e.length >= 45, 'il budget inutilizzato a destra va speso a sinistra');
});

test('estratto: messaggio più corto della finestra sta tutto dentro, senza ellissi', () => {
  const e = excerptAround('breve CHIAVE qui', 6, 12, 50);
  assert.equal(e, 'breve CHIAVE qui');
});

test('estratto: match più lungo della finestra viene troncato lui', () => {
  const text = 'Z'.repeat(200);
  const e = excerptAround(text, 0, 200, 50);
  assert.equal(e.length, 50);
  assert.ok(e.endsWith('…'));
});

test('estratto: le newline sono collassate, la riga resta una', () => {
  const text = 'riga uno\n\n   riga due CHIAVE\ttab\nfine';
  const e = excerptAround(text, 22, 28, 50);
  assert.ok(!/[\n\t]/.test(e), `estratto multi-riga: ${JSON.stringify(e)}`);
  assert.ok(e.includes('CHIAVE'));
});

test('estratto: gli offset del match restano quelli del testo RAW', () => {
  const text = 'aaa\n\n\nbbb CHIAVE ccc';
  const s = [sess('a', [['ai', text]])];
  const hit = searchSessions(s, '', 'CHIAVE', opts()).groups[0].hits[0];
  assert.equal(text.slice(hit.matchStart, hit.matchEnd), 'CHIAVE');
});

// ── occorrenze multiple, indici, cap ────────────────────────────────────────

test('match multipli nello stesso messaggio = righe distinte', () => {
  const s = [sess('a', [['ai', 'chiave uno, chiave due, chiave tre']])];
  const hits = searchSessions(s, '', 'chiave', opts()).groups[0].hits;
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.idx), [0, 0, 0]);
  assert.equal(new Set(hits.map((h) => h.matchStart)).size, 3, 'offset tutti diversi');
});

test('idx dell\'occorrenza = indice del record che la contiene', () => {
  const s = [sess('a', [['ai', 'nulla'], ['ai', 'nulla'], ['ai', 'la chiave']])];
  assert.equal(searchSessions(s, '', 'chiave', opts()).groups[0].hits[0].idx, 2);
});

test('hit.text è il corpo INTERO, per il reader', () => {
  const full = 'preambolo lungo ' + 'x'.repeat(500) + ' chiave ' + 'y'.repeat(500);
  const s = [sess('a', [['ai', full]])];
  assert.equal(searchSessions(s, '', 'chiave', opts()).groups[0].hits[0].text, full);
});

test('cap per sessione: taglia le occorrenze ma le CONTA tutte', () => {
  const n = MAX_HITS_PER_SESSION + 15;
  const s = [sess('a', [['ai', Array.from({ length: n }, () => 'chiave').join(' ')]])];
  const r = searchSessions(s, '', 'chiave', opts());
  assert.equal(r.groups[0].hits.length, MAX_HITS_PER_SESSION);
  assert.equal(r.groups[0].hidden, 15, 'il contatore non deve mentire sulle tagliate');
  assert.equal(r.hidden, 15);
});

test('cap globale: la lista si ferma, il contatore prosegue', () => {
  const per = MAX_HITS_PER_SESSION;
  const nSess = Math.ceil(MAX_TOTAL_HITS / per) + 3;
  const all = Array.from({ length: nSess }, (_, i) =>
    sess(`s${i}`, [['ai', Array.from({ length: per }, () => 'chiave').join(' ')]]),
  );
  const r = searchSessions(all, '', 'chiave', opts());
  assert.equal(r.shown, MAX_TOTAL_HITS);
  assert.equal(r.shown + r.hidden, nSess * per, 'trovate = mostrate + nascoste');
});

test('sessioni senza occorrenze non producono gruppi vuoti', () => {
  const all = [sess('a', [['ai', 'niente']]), sess('b', [['ai', 'la chiave']])];
  const r = searchSessions(all, '', 'chiave', opts());
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].session.sessionId, 'b');
});

test('ordine dei gruppi = ordine delle sessioni in ingresso (ts desc dall\'adapter)', () => {
  const all = [sess('primo', [['ai', 'chiave']]), sess('secondo', [['ai', 'chiave']])];
  const r = searchSessions(all, '', 'chiave', opts());
  assert.deepEqual(r.groups.map((g) => g.session.sessionId), ['primo', 'secondo']);
});

// ── righe e selezione ───────────────────────────────────────────────────────

test('raggruppata: una riga-sessione seguita dalle sue occorrenze', () => {
  const all = [
    sess('aaa', [['ai', 'chiave uno chiave due']]),
    sess('bbb', [['ai', 'chiave tre']]),
  ];
  const rows = buildRows(searchSessions(all, '', 'chiave', opts()), false);
  assert.deepEqual(rows.map((r) => r.kind), ['session', 'hit', 'hit', 'session', 'hit']);
});

test('piatta (hash valorizzato): nessuna riga-sessione', () => {
  const all = [sess('aaa', [['ai', 'chiave uno chiave due']])];
  const rows = buildRows(searchSessions(all, 'aaa', 'chiave', opts()), true);
  assert.deepEqual(rows.map((r) => r.kind), ['hit', 'hit']);
});

test('le chiavi di riga sono uniche e discriminano il TIPO', () => {
  const all = [sess('aaa', [['ai', 'chiave uno chiave due'], ['ai', 'chiave tre']])];
  const rows = buildRows(searchSessions(all, '', 'chiave', opts()), false);
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'chiavi duplicate');
  assert.ok(keys[0].startsWith('sess:'));
  assert.ok(keys.slice(1).every((k) => k.startsWith('hit:')));
});

test('due occorrenze nello stesso record hanno chiavi diverse', () => {
  const all = [sess('aaa', [['ai', 'chiave e chiave']])];
  const rows = buildRows(searchSessions(all, '', 'chiave', opts()), true);
  assert.notEqual(rows[0].key, rows[1].key);
});

test('navigazione: attraversa righe sessione e righe occorrenza', () => {
  const all = [sess('aaa', [['ai', 'chiave']]), sess('bbb', [['ai', 'chiave']])];
  const rows = buildRows(searchSessions(all, '', 'chiave', opts()), false);
  let k = firstRowKey(rows);
  assert.equal(rows[0].key, k);
  for (let i = 1; i < rows.length; i++) {
    k = moveRowSelection(rows, k, 1);
    assert.equal(k, rows[i].key, `passo ${i}`);
  }
  // Clampa in fondo, non wrappa.
  assert.equal(moveRowSelection(rows, k, 1), rows[rows.length - 1].key);
  // E in cima.
  assert.equal(moveRowSelection(rows, rows[0].key, -1), rows[0].key);
});

test('chiave persa dopo che la lista si è riordinata → prima riga, mai una a caso', () => {
  const rows = buildRows(searchSessions([sess('aaa', [['ai', 'chiave']])], '', 'chiave', opts()), false);
  assert.equal(moveRowSelection(rows, 'hit:sparita:9:ai:0', 1), rows[0].key);
  assert.equal(rowIndexOfKey(rows, 'hit:sparita:9:ai:0'), -1);
  assert.equal(selectedRow(rows, 'hit:sparita:9:ai:0'), null);
});

test('lista vuota: nessuna selezione, nessun crash', () => {
  assert.equal(firstRowKey([]), null);
  assert.equal(moveRowSelection([], null, 1), null);
  assert.equal(rowIndexOfKey([], null), -1);
  assert.equal(selectedRow([], null), null);
});

test('selectedRow restituisce la riga col suo tipo, per il ⏎ contestuale', () => {
  const all = [sess('aaa', [['ai', 'chiave']])];
  const rows = buildRows(searchSessions(all, '', 'chiave', opts()), false);
  assert.equal(selectedRow(rows, rows[0].key)?.kind, 'session');
  assert.equal(selectedRow(rows, rows[1].key)?.kind, 'hit');
});
