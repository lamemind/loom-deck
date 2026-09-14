// T161 — il catalogo delle azioni di spawn.
//
// Quasi tutte le asserzioni qui sono su INVARIANTI del dato, non su valori: un
// id duplicato, un buco nominato in un template e non dichiarato, una riga senza
// nessuna cella editabile non producono un errore a runtime — producono una
// pagina che mostra una riga muta o un override che non arriva mai a
// destinazione. Sono i guasti che si scoprono usando il deck, non lanciando i
// test, ed è per questo che stanno qui.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_HOTKEYS,
  DETAIL_ACTIONS,
  MODELS,
  SPAWN_ACTIONS,
  editableFields,
  isModelKind,
  isSpawnActionId,
  spawnAction,
  specializeRecap,
} from '../src/spawn-catalog.js';

test('gli id sono unici: un duplicato renderebbe irraggiungibile la seconda riga', () => {
  const ids = SPAWN_ACTIONS.map((a) => a.id);
  assert.deepEqual([...new Set(ids)], ids);
});

test('undici righe: il perimetro di D1, cioè le azioni con almeno una cella editabile', () => {
  assert.equal(SPAWN_ACTIONS.length, 11);
  for (const a of SPAWN_ACTIONS) {
    assert.ok(
      editableFields(a).length > 0,
      `l'azione ${a.id} non ha nessuna cella editabile: non deve stare in catalogo (D1)`,
    );
  }
});

test('resume, fork e le due skill headless restano fuori', () => {
  // Resume e fork ereditano il modello dal transcript dell'origine, e un
  // override lì sarebbe una cella che mente; create-task e clean-tasks non
  // passano `--model` e girano sul default del CLI.
  for (const id of ['resume', 'fork', 'create-task', 'clean-tasks', 'terminal', 'launch']) {
    assert.equal(spawnAction(id), undefined, `${id} non deve avere una riga`);
  }
});

test('i sette kind sono anche sette id: nessuna mappa kind → id da tenere allineata', () => {
  for (const kind of ['none', 'recap', 'recap-task', 'recap-epic', 'preflight', 'run', 'checkpoint']) {
    assert.ok(isSpawnActionId(kind), `il kind ${kind} non ha una riga di catalogo`);
  }
  // Il ponte fra detail e catalogo: specializzare un kind sceglie già la riga.
  assert.ok(isSpawnActionId(specializeRecap('recap', true)));
  assert.ok(isSpawnActionId(specializeRecap('recap', false)));
});

test('ogni azione del detail nomina una riga del catalogo', () => {
  for (const a of DETAIL_ACTIONS) {
    for (const epic of [false, true]) {
      const id = specializeRecap(a.kind, epic);
      assert.ok(spawnAction(id), `l'azione '${a.label}' punta a '${id}', che non è in catalogo`);
    }
  }
});

test('le iniziali delle azioni del detail restano distinte', () => {
  // Due label con la stessa lettera renderebbero la seconda irraggiungibile, e
  // in silenzio: `ACTION_HOTKEYS` è un `Object.fromEntries`, quindi l'ultima
  // vincerebbe senza che niente lo segnali.
  assert.equal(Object.keys(ACTION_HOTKEYS).length, DETAIL_ACTIONS.length);
});

test('editableFields è il complemento esatto di fixed', () => {
  for (const a of SPAWN_ACTIONS) {
    const editable = new Set(editableFields(a));
    for (const f of Object.keys(a.fixed)) {
      assert.ok(!editable.has(f as never), `${a.id}: ${f} è insieme fisso ed editabile`);
    }
    assert.equal(editable.size + Object.keys(a.fixed).length, 3);
  }
});

test('ogni cella fissa dice il PERCHÉ, non solo che lo è', () => {
  // La pagina mostra quella frase al posto del valore: una stringa vuota
  // lascerebbe una cella muta, che si legge come un valore mancante.
  for (const a of SPAWN_ACTIONS) {
    for (const [field, reason] of Object.entries(a.fixed)) {
      assert.ok(reason && reason.trim().length > 0, `${a.id}.${field} è fissa senza ragione`);
    }
  }
});

test('i buchi usati nei template sono tutti dichiarati', () => {
  // Un buco non dichiarato resta letterale nel titolo (`📐 {slag}` finisce
  // nella tab così com'è, graffe comprese, e `_sane_note` le toglie lasciando
  // la parola): nessun errore, solo un titolo sbagliato.
  for (const a of SPAWN_ACTIONS) {
    for (const template of [a.title, a.prompt]) {
      if (!template) continue;
      for (const m of template.matchAll(/\{([A-Za-z]+)\}/g)) {
        assert.ok(
          a.holes.includes(m[1]!),
          `${a.id}: il template nomina {${m[1]}}, che non è fra i buchi dichiarati`,
        );
      }
    }
  }
});

test('un modello cablato è uno dei quattro alias', () => {
  for (const a of SPAWN_ACTIONS) {
    if (a.model !== null) {
      assert.ok(isModelKind(a.model), `${a.id}: modello '${a.model}' fuori da MODELS`);
    }
  }
});

test('nessun apice singolo nei prompt cablati', () => {
  // Il testo finisce dentro `'…'` nel comando passato a `bash -lc`: `deck-run`
  // lo quota, ma un apice qui è una scrittura da rileggere due volte.
  for (const a of SPAWN_ACTIONS) {
    assert.ok(!a.prompt?.includes("'"), `${a.id}: apice singolo nel prompt cablato`);
  }
});

test('un titolo esiste se e solo se non è dichiarato fisso', () => {
  // Le due assenze sono distinte: `title: null` dice che l'azione non porta un
  // titolo, `fixed.title` dice perché. Una senza l'altra è una riga che nella
  // pagina mostra una cella vuota senza spiegazione, o una cella editabile che
  // non finisce da nessuna parte.
  for (const a of SPAWN_ACTIONS) {
    assert.equal(
      a.title === null,
      'title' in a.fixed,
      `${a.id}: titolo e ragione della sua assenza non concordano`,
    );
  }
});

test('MODELS e MODEL_DEFAULT restano gli alias del CLI, mai id versionati', () => {
  // Un id versionato cablato qui diventerebbe falso al primo cambio di
  // generazione, e fallirebbe come modello inesistente invece che come
  // configurazione da aggiornare.
  for (const m of MODELS) assert.ok(!m.includes('-'), `alias sospetto: ${m}`);
});
