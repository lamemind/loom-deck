// T155 — il lettore del gitlink: parser TSV, contatori, riga di stato.
//
// Nessun git e nessuno pseudo-terminale: il deck non classifica da sé — legge il
// TSV che `bump-gitlink.sh --dry-run` gli mette davanti — quindi tutto ciò che
// resta da provare qui è la lettura. La classificazione ha il suo banco, in
// bash, dove le due guardie si possono provare su repo veri
// (`plugin-tests/git/run.sh`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attentionCount,
  bumpableCount,
  disalignedCount,
  gitlinkNote,
  GITLINK_STATES,
  hasGitmodules,
  parseGitlinkTsv,
} from '../src/gitlink.js';

/** Un TSV con TUTTI gli stati che lo script sa emettere, uno per riga. */
const TSV_COMPLETO = [
  'loom-compass\tallineato\t-',
  'vendor/nuovo\tnon-inizializzato\tgit submodule update --init -- vendor/nuovo',
  'vendor/rotto\tconflitto\trisolvi il conflitto di merge in vendor/rotto',
  'loom-deck\tavanti\tcf1df3b→19bb984 DLV1 rilevatore gitlink',
  'loom-works-plugin\tindietro\tgit submodule update -- loom-works-plugin',
  'vendor/locale\tnon-pushato\tgit -C vendor/locale push',
  'vendor/offline\tremote-irraggiungibile\tgit -C vendor/offline fetch origin',
].join('\n');

test('il parser legge i sette stati che lo script emette', () => {
  const rows = parseGitlinkTsv(TSV_COMPLETO);
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((r) => r.state),
    [
      'allineato',
      'non-inizializzato',
      'conflitto',
      'avanti',
      'indietro',
      'non-pushato',
      'remote-irraggiungibile',
    ],
  );
  // Il dettaglio arriva intero: è il gesto che manca, e la riga di stato lo
  // ricopia invece di ricomporlo.
  assert.equal(rows[5]!.detail, 'git -C vendor/locale push');
});

test('lo stato `bumpato` esiste e non è `avanti`', () => {
  // Due fatti diversi — «lo bumperei» e «l'ho bumpato» — con due nomi. Se
  // collassassero, la riga di stato dopo il tasto sarebbe indistinguibile
  // dall'anteprima che c'era prima di premerlo.
  const rows = parseGitlinkTsv('loom-deck\tbumpato\tcf1df3b→19bb984 messaggio');
  assert.equal(rows[0]!.state, 'bumpato');
  assert.ok(GITLINK_STATES.includes('bumpato'));
  assert.equal(disalignedCount(rows), 0, 'un membro appena bumpato non è più disallineato');
});

test('uno stato non previsto diventa `sconosciuto` invece di sparire', () => {
  // Scartare la riga farebbe CALARE il contatore ogni volta che lo script
  // guadagna uno stato nuovo — cioè proprio quando il deck deve dirlo.
  const rows = parseGitlinkTsv('vendor/x\tstato-che-non-esiste\tdettaglio');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'sconosciuto');
  assert.equal(attentionCount(rows), 1, 'uno stato ignoto vale il glifo di allerta');
});

test('il dettaglio è l’ultimo campo e sopravvive a un tab al suo interno', () => {
  const rows = parseGitlinkTsv('vendor/x\tnon-pushato\tgit -C vendor/x\tpush');
  assert.equal(rows[0]!.detail, 'git -C vendor/x\tpush');
});

test('righe vuote e righe monche non producono membri', () => {
  const rows = parseGitlinkTsv('\n\nloom-deck\n\t\tsolo-dettaglio\n\nloom-deck\tallineato\t-\n');
  assert.deepEqual(
    rows.map((r) => r.path),
    ['loom-deck'],
  );
});

test('il contatore somma i disallineati, non chi nessun bump sistema', () => {
  const rows = parseGitlinkTsv(TSV_COMPLETO);
  // avanti + indietro + non-pushato + remote-irraggiungibile
  assert.equal(disalignedCount(rows), 4);
  // Fuori: `allineato`, più `non-inizializzato` e `conflitto` — nessun bump li
  // porta a zero, e un contatore che non arriva a zero smette di essere letto.
  assert.equal(attentionCount(rows), 2);
  // Bumpabile è solo chi passa entrambe le guardie.
  assert.equal(bumpableCount(rows), 1);
});

test('la riga di stato nomina i membri: bumpati prima, saltati dopo', () => {
  // Il caso MISTO — uno pushato, uno no — è quello che rende necessario
  // nominarli: un totale direbbe «1 bumpato» e lascerebbe fuori il comando che
  // sblocca l'altro.
  const rows = parseGitlinkTsv(
    [
      'loom-compass\tallineato\t-',
      'vendor/locale\tnon-pushato\tgit -C vendor/locale push',
      'loom-deck\tbumpato\tcf1df3b→19bb984 DLV1',
    ].join('\n'),
  );
  const note = gitlinkNote(rows);
  assert.ok(note.startsWith('✔ loom-deck'), `bumpato non in testa: ${note}`);
  assert.ok(note.includes('git -C vendor/locale push'), `gesto mancante assente: ${note}`);
  // Un membro allineato non compare: la riga dice cosa è successo, non cosa
  // esiste.
  assert.ok(!note.includes('loom-compass'), `un allineato è finito in riga: ${note}`);
});

test('la riga di stato è vuota quando non è successo niente', () => {
  assert.equal(gitlinkNote(parseGitlinkTsv('loom-deck\tallineato\t-')), '');
  assert.equal(gitlinkNote([]), '');
});

test('il gate legge `.gitmodules`, non la lista dei submodule', () => {
  // Rispondere a «ci sono submodule?» con `git submodule status` sarebbe
  // esattamente lo spawn che il gate esiste per non pagare.
  //
  // Due cartelle COSTRUITE e non il checkout vero: il deck si pubblica su npm e
  // si clona da solo, quindi un test ancorato alla presenza del cappello attorno
  // misurerebbe il layout di chi lo lancia invece del gate.
  const senza = mkdtempSync(join(tmpdir(), 'deck-nomod-'));
  assert.equal(hasGitmodules(senza), false);
  const con = mkdtempSync(join(tmpdir(), 'deck-mod-'));
  writeFileSync(join(con, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ../x.git\n');
  assert.equal(hasGitmodules(con), true);
});
