// T232 — gate di larghezza (vedi `frame-width.test.ts`): il detail della task —
// il testo, la ricerca dentro il detail, l'area di compilazione.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_F, SKIP } from './pty-harness.js';
import { assertFrameFits, capture, lastFrame } from './frame-kit.js';
import { detailProject } from './detail-fixture.js';

/** `[label, tasti, larghezze, env?]` — le due schermate sostitutive (T52) si
 *  provano a una larghezza sola: il costo è un deck vero avviato per ogni
 *  combinazione. */
const SCENARIOS: Array<[string, string, number[], NodeJS.ProcessEnv?]> = [
  // T66 — il detail: `DD` porta la selezione sulla prima task (il deck atterra
  // su `≡ tutte`), `\r` apre l'overlay. Le righe del task file sono l'unico
  // testo a lunghezza libera lì dentro, e la riga bottoni l'unica riga fissa
  // aggiunta — cioè i due modi in cui l'overlay può sfondare.
  ['detail task', 'DD\r', [100, 176]],
  // Fondo del testo (`G`): l'ultima schermata è quella con meno righe di
  // contenuto, dove uno scroll non clampato lascerebbe righe vuote e il box si
  // accorcerebbe sotto il budget.
  ['detail · fondo del testo', 'DD\rG', [100]],
  // T189 — gli scenari che battono tasti sull'area di compilazione sono usciti
  // da qui: il detail si apre sulla lista DLV o sui campi secondo la task, e sul
  // cappello vero quella condizione cambia a ogni checkpoint. Stanno nelle
  // tabelle `DETAIL_SCENARIOS`, sul progetto sintetico — qui sotto e in
  // `frame-width-dlv.test.ts`. Restano qui quelli che valgono
  // in entrambi i modi — testo e ricerca.
  // T91 — la ricerca dentro il detail: modale dentro modale. Il campo è l'unico
  // testo a lunghezza libera della riga che lo ospita, e la riga stessa è la
  // seconda riga FISSA aggiunta dentro l'overlay.
  ['detail · ricerca aperta', `DD\r${CTRL_F}task`, [100, 176]],
  // `D` dopo la query muove fra le occorrenze (non scrolla): il contatore `n/N`
  // cambia e con esso la larghezza della coda della riga.
  ['detail · ricerca · seconda occorrenza', `DD\r${CTRL_F}taskD`, [100]],
  // Zero occorrenze: la riga porta un avviso invece del contatore, ed è più
  // lunga di quello — il caso che sfonda se il budget è tarato sul contatore.
  ['detail · ricerca senza occorrenze', `DD\r${CTRL_F}zzqqww`, [100]],
  // Query più larga del campo: la finestra si ancora al caret, come nel modale
  // edit, e il testo non deve uscire dal box.
  ['detail · ricerca · query lunga', `DD\r${CTRL_F}X`, [100]],
];

for (const [label, keys, widths, extraEnv] of SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      assertFrameFits(capture(cols, 38, keys, extraEnv), cols, `${label}@${cols}`);
    });
  }
}

// T189 — gli scenari del DETAIL sul progetto sintetico di `detail-fixture.ts`:
// l'area di compilazione, raggiunta con `T` da T1, che si apre sui DLV. La lista
// DLV nei suoi stati sta in `frame-width-dlv.test.ts`. Il contenuto si asserisce come per il modo
// doc: un gate di sola larghezza resterebbe verde anche sul modo sbagliato.
const DETAIL_SCENARIOS: Array<[string, string, number[], string]> = [
  // Quattro `→` portano sull'ultima azione (`checkpoint`, l'etichetta più
  // lunga): il bottone selezionato è reso `inverse`, ed è la cella che deve
  // restare dentro il frame anche in coda alla riga.
  ['detail · ultima azione', 'DD\rTRRRR', [100, 176], 'priorità'],
  // T108 — la riga del selettore modello, con selezionata la voce più larga
  // (`sonnet`): è quella che `cutParts` deve tenere a schermo per prima, quindi
  // il caso in cui il taglio prioritario può sfondare la riga. T117 — due `D`
  // portano il fuoco sulla riga modello, `R` avanza di una voce nel giro.
  ['detail · modello sonnet', 'DD\rTDDR', [100, 176], 'priorità'],
  // T117 — il campo PROMPT pieno: è pre-riempito da un template (`checkpoint`,
  // il più lungo) e per giunta editabile, quindi l'unica riga dell'area che
  // porta due sorgenti di lunghezza libera insieme. `c` sceglie checkpoint, `D`
  // scende sul campo, `X` incolla 60 caratteri in coda al template.
  ['detail · prompt lungo', 'DD\rTcDX', [100, 176], 'priorità'],
  // T111 — la riga titolo piena: `X` incolla 60 caratteri in un chunk solo, cioè
  // un titolo più largo della riga che lo ospita.
  ['detail · titolo lungo', 'DD\rTDDDX', [100, 176], 'priorità'],
];

for (const [label, keys, widths, needle] of DETAIL_SCENARIOS) {
  for (const cols of widths) {
    test(`gate larghezza · ${label} @ ${cols} colonne`, { skip: SKIP }, () => {
      const { proj, env } = detailProject();
      const raw = capture(cols, 38, keys, env, proj);
      assertFrameFits(raw, cols, `${label}@${cols}`);
      if (cols >= 100) {
        assert.ok(
          lastFrame(raw).join('\n').includes(needle),
          `${label}@${cols}: atteso "${needle}" a schermo — il gate stava misurando un'altra schermata`,
        );
      }
    });
  }
}
