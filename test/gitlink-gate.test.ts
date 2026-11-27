// T178 — il gate del sensore del gitlink: la decisione, e la firma su repo veri.
//
// La firma deve cambiare per ogni fatto che cambia l'esito del dry-run — un
// commit nel membro, un push che sposta il suo remote-tracking ref, un checkout
// indietro, un gitlink nell'indice o in un commit del cappello — e restare
// ferma a repo fermi, che è il caso in cui il tick non lancia niente. I repo
// si costruiscono con `git`, nessuno script del plugin: il test misura la sola
// lettura del filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GITLINK_FORCE_INTERVAL_MS,
  gitlinkScanDue,
  gitlinkSignature,
  gitmodulePaths,
} from '../src/gitlink-gate.js';
import { commitFile, fakeCappello, git } from './gitlink-kit.js';

test('il giro parte senza un giro riuscito da confrontare, o senza firma', () => {
  assert.equal(gitlinkScanDue(null, 'firma', 0), true);
  assert.equal(gitlinkScanDue({ sig: 'firma', at: 0 }, null, 1), true);
});

test('a firma ferma il giro si salta fino al giro forzato', () => {
  const memo = { sig: 'firma', at: 1000 };
  assert.equal(gitlinkScanDue(memo, 'firma', 1000 + 30_000), false);
  assert.equal(gitlinkScanDue(memo, 'firma', 1000 + GITLINK_FORCE_INTERVAL_MS - 1), false);
  assert.equal(gitlinkScanDue(memo, 'firma', 1000 + GITLINK_FORCE_INTERVAL_MS), true);
});

test('una firma cambiata fa partire il giro subito', () => {
  assert.equal(gitlinkScanDue({ sig: 'prima', at: 1000 }, 'dopo', 1001), true);
});

test('i path dei submodule vengono da .gitmodules', () => {
  const text = '[submodule "a"]\n\tpath = loom-deck\n\turl = ../a.git\n[submodule "b"]\n  path=vendor/x y\n';
  assert.deepEqual(gitmodulePaths(text), ['loom-deck', 'vendor/x y']);
});

test('senza .git nella root la firma non si legge, e il giro parte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-gate-nogit-'));
  assert.equal(await gitlinkSignature(dir), null);
});

test('la firma resta ferma a repo fermi e cambia per ogni fatto che il dry-run legge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deck-gate-'));
  const cappello = fakeCappello(root);
  const sub = join(cappello, 'sub');

  const s0 = await gitlinkSignature(cappello);
  assert.notEqual(s0, null);
  assert.equal(await gitlinkSignature(cappello), s0, 'a repo fermi la firma cambia');

  // Un commit nel membro, non pushato: HEAD del membro avanza.
  commitFile(sub, 'b.txt', 'commit locale');
  const s1 = await gitlinkSignature(cappello);
  assert.notEqual(s1, s0, 'il commit nel membro non cambia la firma');

  // Il push sposta il remote-tracking ref: il membro passa da non-pushato ad avanti.
  git(sub, 'push', '-q', 'origin', 'HEAD:main');
  const s2 = await gitlinkSignature(cappello);
  assert.notEqual(s2, s1, 'il push nel membro non cambia la firma');

  // Il gitlink nell'indice del cappello, poi nel suo commit.
  git(cappello, 'add', '--', 'sub');
  const s3 = await gitlinkSignature(cappello);
  assert.notEqual(s3, s2, 'il gitlink nell\'indice non cambia la firma');
  git(cappello, 'commit', '-q', '-m', 'bump del gitlink');
  const s4 = await gitlinkSignature(cappello);
  assert.notEqual(s4, s3, 'il commit del cappello non cambia la firma');

  // Il checkout indietro del membro: HEAD staccato su un commit più vecchio.
  git(sub, 'checkout', '-q', 'HEAD~1');
  const s5 = await gitlinkSignature(cappello);
  assert.notEqual(s5, s4, 'il checkout del membro non cambia la firma');

  // Un file del lavoro, fuori da git, non conta.
  writeFileSync(join(sub, 'appunti.txt'), 'niente\n');
  assert.equal(await gitlinkSignature(cappello), s5, 'un file non tracciato cambia la firma');
});
