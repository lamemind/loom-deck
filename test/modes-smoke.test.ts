// GATE dei dieci modi — che ognuno si APRA, si navighi e si CHIUDA.
//
// `frame-width*.test.ts` misura la larghezza del frame e passa anche se un modo
// non si apre più: è cieco al comportamento per costruzione. Questo gate copre
// esattamente quel buco. Non verifica il layout — verifica che premendo il tasto
// il modo compaia a schermo, che `esc` riporti alla lista, e che i due casi di
// modale-dentro-modale (reader dentro search, `^F` dentro detail) reggano.
//
// Stessa infrastruttura pty del gate di larghezza: Ink renderizza solo su un TTY
// vero. `LOOM_DECK_NO_SPAWN=1` tiene inerti gli spawn — senza, ogni run
// aprirebbe tab Ptyxis reali sulla macchina di chi lancia i test.
//
// T232 — i gate dei modi stanno in più file `modes-smoke*.test.ts`, uno per
// gruppo di comportamenti: il runner esegue i file in parallelo e le catture di
// un file in serie. La cattura e la lettura del frame sono in `modes-kit.ts`,
// il lancio del deck in `pty-harness.ts`. Questo file tiene i modi che si aprono
// dalla lista e si richiudono con `esc`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANC, CTRL_F, CTRL_L, CTRL_S, ESC, PROJECT, SKIP } from './pty-harness.js';
import { LIST_FRAME, capture, lastFrame } from './modes-kit.js';

// Ogni voce: i tasti da battere e un frammento che DEVE comparire nel frame
// finale. Il frammento è scelto fra ciò che solo quel modo disegna.
const MODES: Array<{ name: string; keys: string; expect: RegExp; env?: NodeJS.ProcessEnv }> = [
  // La testata porta risoluzione e versione: è ciò che dice «il deck ha
  // disegnato il suo frame».
  { name: 'normal', keys: '', expect: LIST_FRAME },
  { name: 'create', keys: 'C', expect: /nuova task|create/i },
  { name: 'sort', keys: 'S', expect: /sort|ordina/i },
  { name: 'filter', keys: 'F', expect: /filtr/i },
  { name: 'search', keys: CTRL_F, expect: /ricerca|hash/i },
  { name: 'detail', keys: 'DD\r', expect: /preflight|checkpoint/i },
  // T111 ha rinominato il concetto in «titolo della conversazione»: l'attesa
  // deve citare ciò che la barra disegna oggi, non il nome di prima.
  { name: 'note', keys: 'RN', expect: /titolo conversazione/i },
  { name: 'assign', keys: 'RA', expect: /assegn|detach/i },
  // `DD` prima di `E`: il deck apre su `≡ tutte` (D4), e le righe meta non
  // sono task — `E` lì risponde «nessuna task selezionata», correttamente.
  { name: 'edit', keys: 'DDE', expect: /priorit|progress/i },
  // T112 — `DD` porta sulla prima task reale, `CANC` apre la conferma. La
  // conferma NOMINA l'effetto sul disco, non l'etichetta della vista.
  { name: 'purge', keys: `DD${CANC}`, expect: /eliminare/i },
  // T161 — la pagina delle azioni di spawn. L'attesa è sulla riga di TESTATA,
  // che è l'unica a nominare la pagina: le celle della tabella portano valori
  // che il progetto può aver cambiato.
  { name: 'spawn', keys: CTRL_S, expect: /azioni di spawn/i },
  // T168 — la pagina delle voci launch: l'attesa è sulla testata, l'unica a
  // nominarla (le righe portano le voci del progetto, che cambiano).
  { name: 'launch', keys: CTRL_L, expect: /voci launch/i },
  // T169 — il finder si apre con `T` maiuscola, che nel driver pty è il tab: il
  // backtick la manda letterale. L'attesa è la riga hint, l'unica a nominarlo.
  { name: 'finder', keys: '`T', expect: /trova task/i },
  // T194 — il modale delle combo: l'attesa è sulla sua testata, perché le voci
  // stanno anche in altre schermate.
  { name: 'combo', keys: 'H', expect: /tutte le azioni del deck/ },
];

for (const m of MODES) {
  test(`modo ${m.name}: si apre`, { skip: SKIP }, () => {
    const frame = capture(m.keys, PROJECT, m.env);
    assert.match(frame, m.expect, `il modo ${m.name} non ha disegnato il proprio frame`);
  });
}

// Il reader è l'unico modo che non si apre dalla lista: ci si arriva da dentro
// la ricerca, con `⏎` su una riga occorrenza.
test('modo reader: si apre da dentro la ricerca', { skip: SKIP }, () => {
  const frame = capture(`${CTRL_F}task\r`);
  // Nel reader la barra dice `esc torna` (alla lista), non `esc chiude`.
  assert.match(frame, /reader|esc torna/i);
});

// I due punti dove la precedenza fra i rami è già stata corretta una volta.
test('esc dal reader torna alla ricerca, non al deck', { skip: SKIP }, () => {
  // Il reader è un modale DENTRO la ricerca: `esc` smonta uno strato solo, e la
  // lista occorrenze si ritrova com'era. Se smontasse due strati si tornerebbe
  // alla lista task, cioè si perderebbe la ricerca appena fatta.
  const frame = lastFrame(capture(`${CTRL_F}task\r${ESC}`));
  assert.match(frame, /ricerca|hash/i);
});

test('^F dentro il detail apre la ricerca nel testo, non quella conversazioni', {
  skip: SKIP,
}, () => {
  const frame = lastFrame(capture(`DD\r${CTRL_F}`));
  // La ricerca conversazioni ha il campo `hash`; quella del detail no — e la
  // barra azioni del detail resta a schermo sotto il campo.
  assert.match(frame, /preflight|checkpoint/i);
});

// Gli acceleratori sono inerti dentro il detail: è l'informazione che prima
// viveva solo nell'ordine testuale delle `if`, e che ora `input-modes.ts`
// dichiara. Con NO_SPAWN un `^K` che passasse non aprirebbe una tab, ma
// scriverebbe comunque la sua nota di spawn nella riga di stato.
test('^K dentro il detail non spawna', { skip: SKIP }, () => {
  const frame = lastFrame(capture('DD\r\x0b'));
  // La riga di stato di uno spawn è il COMANDO: `--prompt-kind` è la sua firma,
  // e non compare in nessun altro punto del frame.
  assert.doesNotMatch(frame, /--prompt-kind/);
  assert.match(frame, /preflight|checkpoint/i);
});

// Chiusura: ogni modale torna alla lista con `esc`, e il deck resta vivo.
for (const m of MODES.filter((x) => x.name !== 'normal')) {
  test(`modo ${m.name}: esc riporta alla lista`, { skip: SKIP }, () => {
    const frame = lastFrame(capture(`${m.keys}${ESC}`, PROJECT, m.env));
    // La riga delle surface built-in esiste SOLO in modalità normale
    // (`launchLine`): è il marcatore che dice «siamo tornati alla lista».
    assert.match(frame, /t 💻/, `${m.name} non è tornato alla lista`);
  });
}
