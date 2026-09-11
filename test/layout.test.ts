import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignTextWidth,
  conversationLabel,
  cpLen,
  insertAt,
  isDone,
  paneTextWidth,
  previewTextWidth,
  previewTitleParts,
  removeAt,
  searchExcerptWidth,
  searchTitleWidth,
} from '../src/layout.js';
import { cutParts, termWidth } from '../src/width.js';
import type { Session } from '../src/sessions.js';

test('cpLen conta code point, non code unit UTF-16', () => {
  assert.equal(cpLen('abc'), 3);
  // Un'emoji astrale è UN code point e DUE code unit: se il caret indicizzasse
  // `.length` si fermerebbe a metà glifo.
  assert.equal(cpLen('a🎴b'), 3);
  assert.equal('a🎴b'.length, 4);
});

test('insertAt inserisce alla posizione in code point', () => {
  assert.equal(insertAt('ac', 1, 'b'), 'abc');
  assert.equal(insertAt('🎴x', 1, '-'), '🎴-x');
  assert.equal(insertAt('ab', 0, 'X'), 'Xab');
  assert.equal(insertAt('ab', 2, 'X'), 'abX');
});

test('removeAt toglie un code point; fuori range lascia invariato', () => {
  assert.equal(removeAt('abc', 1), 'ac');
  assert.equal(removeAt('🎴x', 0), 'x');
  assert.equal(removeAt('ab', -1), 'ab');
  assert.equal(removeAt('ab', 2), 'ab');
});

test('isDone riconosce il glifo di tasks.md, non la parola', () => {
  assert.equal(isDone('✔️'), true);
  assert.equal(isDone('🔵'), false);
  assert.equal(isDone('done'), false);
});

// Invariante condivisa dalle cinque larghezze: sono un TETTO derivato dalle
// colonne, mai un pavimento, e non scendono sotto il proprio minimo nemmeno su
// un terminale assurdo. Un valore che sfora manderebbe a capo una riga che il
// budget d'altezza non ha contato.
test('le larghezze derivate restano sotto le colonne e sopra il minimo', () => {
  for (const cols of [0, 1, 40, 80, 120, 190]) {
    assert.ok(searchExcerptWidth(cols) >= 30);
    assert.ok(searchTitleWidth(cols) >= 24);
    assert.ok(assignTextWidth(cols) >= 20);
    assert.ok(previewTextWidth(cols) >= 10);
    assert.ok(paneTextWidth(cols) >= 20);
  }
  // Su un terminale largo la cornice è l'unica cosa tolta.
  assert.equal(assignTextWidth(200), 192);
  assert.equal(previewTextWidth(200), 192);
  // Il pane sta al 50%, quindi la sua larghezza è circa la metà.
  assert.ok(paneTextWidth(200) < previewTextWidth(200) / 2 + 4);
});

// T155 — la riga d'apertura del blocco preview di una conversazione: sid, nota
// facoltativa e titolo tagliato dal deck. Il gate pty la misura solo quando una
// conversazione VIVA sul disco porta un titolo abbastanza lungo con dentro
// un'emoji, cioè quando capita; qui la somma si misura sempre.
test('sid + nota + titolo stanno nel testo del blocco preview', () => {
  // Il titolo auto-generato porta il prefisso `[ <emoji> ]`, e l'emoji è il
  // carattere su cui `cli-truncate` sfora: se il taglio lo facesse Ink questa
  // somma uscirebbe di due colonne e mangerebbe il bordo destro del box.
  const titolo = '[ 📊 ] deck sensore gitlink disallineato 🧵 loom-works · T155 '.repeat(3);
  for (const cols of [0, 1, 40, 80, 100, 176]) {
    for (const nota of ['', '[ 🔬 ]', 'una nota lunga scritta a mano 🧵 con emoji in coda']) {
      const parti = cutParts(previewTitleParts('dbae82fe-9983', nota, titolo), previewTextWidth(cols));
      const larghezza = parti.reduce((w, p) => w + termWidth(p), 0);
      assert.ok(
        larghezza <= previewTextWidth(cols),
        `cols=${cols} nota=${JSON.stringify(nota)}: ${larghezza} > ${previewTextWidth(cols)}`,
      );
    }
  }
  // La sid non cade mai per prima: è la coordinata con cui si riprende la
  // conversazione, e una riga che perde lei tiene a schermo solo del testo.
  const parti = cutParts(previewTitleParts('dbae82fe-9983', '', 'un titolo qualunque'), 80);
  assert.equal(parti[0], 'dbae82fe ');
});

test('colonne a 0 (stdout non tty) ricadono sul default 80', () => {
  assert.equal(assignTextWidth(0), assignTextWidth(80));
  assert.equal(paneTextWidth(0), paneTextWidth(80));
});

function session(title: string, firstPrompt = ''): Session {
  return { sessionId: 's1', title, firstPrompt, ts: 0, size: 0, turns: 0, path: '' } as Session;
}

test('conversationLabel toglie il core di progetto dal titolo', () => {
  // Il separatore in testa cade con lo strip: resta solo ciò che distingue.
  assert.equal(conversationLabel(session('🧵 loom-works · T81'), 'loom-works', undefined), 'T81');
});

test('conversationLabel ripiega sul primo prompt quando resta il solo binding', () => {
  // Il titolo si riduce alla task già mostrata nella sua colonna: ripeterla
  // sprecherebbe la riga, quindi si mostra ciò che identifica DAVVERO la
  // conversazione.
  assert.equal(
    conversationLabel(session('🧵 loom-works T81', 'sistemare il parser'), 'loom-works', 'T81'),
    'sistemare il parser',
  );
});

test('conversationLabel senza titolo né prompt non lascia la riga vuota', () => {
  assert.equal(conversationLabel(session('loom-works', ''), 'loom-works', undefined), '(senza titolo)');
});
