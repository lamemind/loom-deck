import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanTasksArgs,
  cleanTasksPrompt,
  deckArgs,
  emptyArgs,
  fallbackTitle,
  forkArgs,
  onInTabCommand,
  resumeArgs,
  shellCommand,
  shellQuote,
  spawnCleanTasks,
  terminalArgs,
  DETAIL_ACTIONS,
  specializeRecap,
  INTAB_MARKER,
  MODEL_DEFAULT,
} from '../src/spawn.js';
import { sanitize } from '../src/width.js';

// La forma degli argv È il contratto col primitive `deck-run`, e finora non la
// fissava nulla: un flag rinominato da un lato si scopriva solo aprendo una tab.

test('deckArgs pinna il sessionId e dichiara sempre il kind', () => {
  // Il kind non ha default qui: dal deck ogni tasto dichiara il proprio intento,
  // e un default silenzioso renderebbe indistinguibili `⏎` e `^K`.
  // Il modello sì (T108): i percorsi che non passano dal selettore del detail
  // non hanno un intento da dichiarare, e il loro unico valore sensato è quello
  // che il selettore stesso mostra all'apertura.
  // Il VALORE del default non si ricopia qui: quale sia lo decide `spawn.ts`, e
  // una cifra cablata in questa asserzione sarebbe una seconda dichiarazione da
  // tenere allineata a mano. Sotto misura c'è che il flag ci sia e porti IL
  // default, non quale modello sia il default oggi.
  assert.deepEqual(deckArgs('T104', 'sid-1', 'run'), [
    'T104',
    '--session-id',
    'sid-1',
    '--prompt-kind',
    'run',
    '--model',
    MODEL_DEFAULT,
  ]);
  assert.deepEqual(deckArgs('T104', 'sid-1', 'run', 'sonnet').slice(-2), ['--model', 'sonnet']);
});

// T111 — la nota data alla nascita viaggia sullo STESSO flag del resume, perché
// deck-run appende il suffisso al titolo prima che i rami si separino: il flag
// non appartiene alla ripresa, vale su ogni spawn.
test('deckArgs porta la nota nel titolo solo quando c\'è', () => {
  assert.deepEqual(deckArgs('T111', 'sid-1', 'preflight', 'opus', 'baluba'), [
    'T111',
    '--session-id',
    'sid-1',
    '--prompt-kind',
    'preflight',
    '--model',
    'opus',
    '--title-note',
    'baluba',
  ]);
  // Nota vuota = nessun flag, non `--title-note ''`: quello produrrebbe un `«»`
  // a vuoto nel titolo. Stesso regime già fissato per `resumeArgs`.
  assert.ok(!deckArgs('T111', 'sid-1', 'preflight', 'opus', '').includes('--title-note'));
  assert.ok(!deckArgs('T111', 'sid-1', 'preflight').includes('--title-note'));
});

// T117 — dal detail il prompt è un TESTO, non un simbolo: dopo una modifica a
// mano nessun kind lo descrive più. I due flag sono mutuamente esclusivi in
// deck-run, quindi qui l'uno sostituisce l'altro invece di affiancarlo.
test('deckArgs: un prompt letterale sostituisce il kind', () => {
  assert.deepEqual(deckArgs('T117', 'sid-1', 'run', 'opus', '', 'fai la cosa'), [
    'T117',
    '--session-id',
    'sid-1',
    '--prompt',
    'fai la cosa',
    '--model',
    'opus',
  ]);
});

test('deckArgs: prompt VUOTO → kind none, non un --prompt a vuoto', () => {
  // Senza flag deck-run cadrebbe sul proprio default `recap`, cioè su un prompt
  // che nessuno ha chiesto: «nessun prompt» va detto, non omesso. È il caso
  // dell'azione `open` e di un campo svuotato a mano.
  assert.deepEqual(deckArgs('T117', 'sid-1', 'none', 'opus', '', '').slice(3, 5), [
    '--prompt-kind',
    'none',
  ]);
  // `undefined` ≠ stringa vuota: chi non ha un campo prompt (gli acceleratori
  // della lista) continua a viaggiare col simbolo.
  assert.deepEqual(deckArgs('T117', 'sid-1', 'run').slice(3, 5), ['--prompt-kind', 'run']);
});

test('resumeArgs scoped porta la task, spot porta --no-task', () => {
  assert.deepEqual(resumeArgs('T81', 'sid-1', 'opus'), [
    'T81',
    '--resume',
    'sid-1',
    '--model',
    'opus',
  ]);
  assert.deepEqual(resumeArgs(null, 'sid-1', 'opus'), [
    '--no-task',
    '--resume',
    'sid-1',
    '--model',
    'opus',
  ]);
});

test('resumeArgs aggiunge la nota al titolo solo quando c\'è', () => {
  // La nota sta PRIMA di `--resume`, e la posizione è sotto misura quanto la
  // presenza: la riga di stato taglia il comando al mezzo tenendo la coda, e un
  // `--title-note` in fondo — l'unico argomento a lunghezza libera — spinge
  // fuori `--resume <uuid>`, cioè l'unica cosa che distingue una ripresa da
  // un'altra. Con la nota qui la coda porta sempre sessione e modello.
  assert.deepEqual(resumeArgs('T81', 'sid-1', 'opus', 'parser'), [
    'T81',
    '--title-note',
    'parser',
    '--resume',
    'sid-1',
    '--model',
    'opus',
  ]);
  // La coda dell'argv resta identica con e senza nota: è l'invariante che tiene
  // la riga di stato leggibile su un titolo di qualunque lunghezza.
  assert.deepEqual(
    resumeArgs('T81', 'sid-1', 'opus', 'x'.repeat(200)).slice(-4),
    resumeArgs('T81', 'sid-1', 'opus').slice(-4),
  );
  // Nota vuota = nessuna nota: un `--title-note ''` metterebbe nel titolo una
  // maniglia che in lista non compare.
  assert.deepEqual(resumeArgs('T81', 'sid-1', 'opus', ''), [
    'T81',
    '--resume',
    'sid-1',
    '--model',
    'opus',
  ]);
});

// T148 — il modello viaggia SEMPRE nell'argv: un resume senza `--model`
// lascerebbe `deck-run` risolvere il proprio default fisso invece del valore
// che il chiamante ha già deciso (P2 preflight).
test('resumeArgs porta --model con qualunque valore il chiamante scelga', () => {
  for (const m of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
    assert.ok(resumeArgs('T81', 'sid-1', m).includes('--model'));
    assert.ok(resumeArgs('T81', 'sid-1', m).includes(m));
  }
});

// T154 — la nuda (`c`) porta il modello SEMPRE, come deckArgs/resumeArgs/forkArgs.
test('emptyArgs porta sempre --model, anche sul valore di default', () => {
  assert.deepEqual(emptyArgs('fable'), ['--no-task', '--model', 'fable']);
  for (const m of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
    assert.deepEqual(emptyArgs(m), ['--no-task', '--model', m]);
  }
});

test('forkArgs porta insieme --resume, --session-id e --model', () => {
  // È l'unico punto in cui `--resume`/`--session-id` convivono: CC apre un id
  // NUOVO invece di riprendere a scrivere sull'origine — due writer sullo
  // stesso JSONL non esistono mai, che è l'intero punto del fork.
  const args = forkArgs('T81', 'origine', 'nuovo', 'sonnet');
  assert.deepEqual(args, [
    'T81',
    '--resume',
    'origine',
    '--fork',
    '--session-id',
    'nuovo',
    '--model',
    'sonnet',
  ]);
  assert.ok(args.includes('--resume') && args.includes('--session-id') && args.includes('--model'));
});

test('forkArgs senza task resta spot', () => {
  assert.deepEqual(forkArgs(null, 'origine', 'nuovo', 'opus'), [
    '--no-task',
    '--resume',
    'origine',
    '--fork',
    '--session-id',
    'nuovo',
    '--model',
    'opus',
  ]);
});

test('il fork non eredita la nota dell\'origine', () => {
  assert.ok(!forkArgs('T81', 'origine', 'nuovo', 'opus').includes('--title-note'));
});

test('terminalArgs titola la tab quando il progetto ha un\'identità', () => {
  // Senza titolo la surface resta funzionante, ma il progetto esce dal radar di
  // compass finché quella tab è in primo piano.
  assert.deepEqual(terminalArgs('/p', '🖥️ loom-works'), [
    '--tab',
    '-T',
    '🖥️ loom-works',
    '-d',
    '/p',
  ]);
  assert.deepEqual(terminalArgs('/p', null), ['--tab', '-d', '/p']);
});

test('terminalArgs non passa mai un comando da eseguire', () => {
  // L'azione È aprire la shell — differenza dalle launch custom, che eseguono un
  // comando dentro `bash -lic`.
  assert.ok(!terminalArgs('/p', 't').includes('--'));
});

// ── T112 · potatura ordinata a clean-tasks ────────────────────────────────

test('cleanTasksPrompt dichiara la conferma già raccolta ed elenca gli ID', () => {
  // `yolo` non è una comodità: senza, `clean-tasks` apre un `AskUserQuestion`
  // sui target non-Done e in `claude -p` non c'è nessuno che risponda — la
  // sessione resta appesa e per il deck è indistinguibile da un'operazione lenta.
  assert.equal(cleanTasksPrompt(['T31'], null), '/loom-works:clean-tasks yolo T31');
  assert.equal(
    cleanTasksPrompt(['T31', 'T40', 'T52'], null),
    '/loom-works:clean-tasks yolo T31 T40 T52',
  );
});

test('cleanTasksPrompt passa --ignored-files solo quando la scelta è stata fatta', () => {
  // Passarlo sempre significherebbe decidere di default se dei file si perdono.
  assert.equal(
    cleanTasksPrompt(['T31'], 'keep'),
    '/loom-works:clean-tasks yolo --ignored-files keep T31',
  );
  assert.equal(
    cleanTasksPrompt(['T31'], 'purge'),
    '/loom-works:clean-tasks yolo --ignored-files purge T31',
  );
  assert.ok(!cleanTasksPrompt(['T31'], null).includes('--ignored-files'));
});

test('cleanTasksArgs porta il prompt come SINGOLO argv', () => {
  const args = cleanTasksArgs(['T31', 'T40'], 'sid-1', null);
  assert.deepEqual(args.slice(0, 6), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    'sid-1',
  ]);
  // Un argv solo: gli ID non passano mai da una shell, quindi non c'è quoting
  // da sbagliare né injection possibile dal contenuto della lista.
  assert.equal(args.length, 7);
  assert.equal(args[6], '/loom-works:clean-tasks yolo T31 T40');
});

test('nessuno spawn su bersaglio vuoto', () => {
  // `clean-tasks` senza SPEC esce 1: spawnarlo comunque farebbe riportare al
  // deck il fallimento di un'operazione che nessuno ha chiesto.
  let called = false;
  const child = spawnCleanTasks([], '/p', 'sid-1', null, () => {
    called = true;
  });
  assert.equal(child, null);
  assert.equal(called, false);
});

test('ogni azione del detail è un prompt-kind valido', () => {
  const kinds = DETAIL_ACTIONS.map((a) => a.kind);
  assert.deepEqual(kinds, ['none', 'preflight', 'run', 'recap', 'checkpoint']);
  // Le etichette non ripetono i kind: dove differiscono, il kind nomina il
  // MECCANISMO e l'etichetta l'INTENZIONE.
  assert.equal(DETAIL_ACTIONS[0]!.label, 'open');
  assert.equal(DETAIL_ACTIONS[3]!.label, 'status');
});

test('specializeRecap: solo `recap` si sdoppia, gli altri kind passano intatti', () => {
  assert.equal(specializeRecap('recap', false), 'recap-task');
  assert.equal(specializeRecap('recap', true), 'recap-epic');
  // Il flag epic non deve poter deviare un kind che non lo riguarda: un `run` su
  // un cappello resta un `run` (che poi run-task rifiuta, ed è un altro strato).
  for (const k of ['none', 'preflight', 'run', 'checkpoint'] as const) {
    assert.equal(specializeRecap(k, true), k);
    assert.equal(specializeRecap(k, false), k);
  }
  // Idempotente: un kind già specializzato non si ri-specializza.
  assert.equal(specializeRecap('recap-epic', false), 'recap-epic');
  assert.equal(specializeRecap('recap-task', true), 'recap-task');
});

// ── T150 · titolo di fallback quando il campo nota è vuoto ────────────────

function withTaskFiles(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'deck-fallback-title-'));
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fallbackTitle: ogni azione del detail produce un titolo distinto', () => {
  withTaskFiles({ 'T150-deck-titolo-conversazione-auto.md': '# Task: x\n' }, (dir) => {
    const titles = DETAIL_ACTIONS.map((a) => fallbackTitle(dir, 'T150', a.kind));
    assert.deepEqual(titles, [
      'deck titolo conversazione auto',
      '[ 📐 ] deck titolo conversazione auto',
      '[ 🚀 ] deck titolo conversazione auto',
      '[ 📊 ] deck titolo conversazione auto',
      '[ 🏁 ] deck titolo conversazione auto',
    ]);
    // Cinque azioni, cinque titoli: nessuna collisione.
    assert.equal(new Set(titles).size, titles.length);
  });
});

// T156 — il prefisso è fatto di caratteri che `_sane_note` toglierebbe, se non
// li avesse in whitelist: senza l'altra metà della modifica il titolo della tab
// perderebbe il prefisso mentre la lista del deck lo tiene. Il gate che lo
// misura sul vero script bash sta in `deck-run.test.ts`; qui si fissa la FORMA
// che quel gate si aspetta, così un cambio di formato fatto da un lato solo
// rompe subito invece di produrre due titoli divergenti in silenzio.
test('fallbackTitle: il prefisso è `[ emoji ]` con spazi interni, e lo slug lo segue', () => {
  withTaskFiles({ 'T150-deck-titolo-conversazione-auto.md': '# Task: x\n' }, (dir) => {
    for (const kind of ['preflight', 'run', 'recap', 'checkpoint'] as const) {
      const title = fallbackTitle(dir, 'T150', kind) ?? '';
      // Flag `u`: `\p{Extended_Pictographic}` è UN code point anche per
      // un'emoji astrale, che senza il flag conterebbe come due unità UTF-16.
      assert.match(
        title,
        /^\[ \p{Extended_Pictographic} \] deck titolo/u,
        `formato del prefisso: ${title}`,
      );
    }
  });
});

test('fallbackTitle: `open` (kind `none`) è il solo slug, senza prefisso (D2/P7)', () => {
  withTaskFiles({ 'T99-drop-di-tag.md': '# Task: x\n' }, (dir) => {
    assert.equal(fallbackTitle(dir, 'T99', 'none'), 'drop di tag');
  });
});

test('fallbackTitle: le tre varianti di recap condividono lo stesso prefisso (P3)', () => {
  withTaskFiles({ 'T81-fix-deck.md': '# Task: x\n' }, (dir) => {
    const recap = fallbackTitle(dir, 'T81', 'recap');
    assert.equal(recap, '[ 📊 ] fix deck');
    assert.equal(fallbackTitle(dir, 'T81', 'recap-task'), recap);
    assert.equal(fallbackTitle(dir, 'T81', 'recap-epic'), recap);
  });
});

test('fallbackTitle: lo slug viene dal NOME del file, non dalla descrizione — apici e `/` non esistono da saldare', () => {
  withTaskFiles({ 'T16-valutare-integrazione-obsidian-viewer.md': '# Task: x\n' }, (dir) => {
    assert.equal(
      fallbackTitle(dir, 'T16', 'run'),
      '[ 🚀 ] valutare integrazione obsidian viewer',
    );
  });
});

test('fallbackTitle: task file assente → null, il chiamante decide il ripiego', () => {
  withTaskFiles({}, (dir) => {
    assert.equal(fallbackTitle(dir, 'T404', 'run'), null);
  });
});

test('fallbackTitle → deckArgs: il fallback sostituisce la nota vuota e porta --title-note', () => {
  withTaskFiles({ 'T150-deck-titolo-conversazione-auto.md': '# Task: x\n' }, (dir) => {
    const note = fallbackTitle(dir, 'T150', 'run') ?? '';
    const args = deckArgs('T150', 'sid-1', 'run', 'opus', note);
    assert.ok(args.includes('--title-note'));
    assert.equal(args[args.indexOf('--title-note') + 1], '[ 🚀 ] deck titolo conversazione auto');
  });
});

// Le quattro emoji del prefisso sono ASTRALI per necessità: `sanitize` rende
// `·` ogni glifo su cui string-width e la larghezza del terminale divergono, e
// le emoji del BMP a presentazione testo divergono sempre. Un'emoji che non
// sopravvive qui arriverebbe intera nella tab Ptyxis (la whitelist di
// `_sane_note` la nomina) e `·` nella lista del deck: la stessa divergenza fra
// i due titoli che T156 chiude, nel verso opposto.
test('fallbackTitle: le emoji del prefisso sopravvivono a sanitize', () => {
  withTaskFiles({ 'T150-deck-titolo-conversazione-auto.md': '# Task: x\n' }, (dir) => {
    for (const kind of ['preflight', 'run', 'recap', 'checkpoint'] as const) {
      const title = fallbackTitle(dir, 'T150', kind) ?? '';
      assert.equal(sanitize(title), title, `sanitize ha toccato il prefisso: ${title}`);
      assert.ok(!sanitize(title).includes('·'), `emoji ridotta a ·: ${title}`);
    }
  });
});

// ── il comando esatto nella riga di stato ─────────────────────────────────

test('shellQuote lascia nudo ciò che una shell non interpreta', () => {
  for (const arg of ['T115', '--prompt-kind', 'opus', '/home/tizio/.local/bin/deck-run', 'a-b_c.d']) {
    assert.equal(shellQuote(arg), arg);
  }
});

test('shellQuote chiude in apici tutto il resto', () => {
  assert.equal(shellQuote('due parole'), "'due parole'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('$HOME'), "'$HOME'");
  assert.equal(shellQuote('nota 🔥'), "'nota 🔥'");
});

test("shellQuote esce dagli apici per l'apice, non lo escapa dentro", () => {
  // Dentro apici singoli nessun escape esiste: `\'` resterebbe backslash+apice.
  // L'unica forma corretta è chiudere, mettere l'apice quotato, riaprire.
  assert.equal(shellQuote("l'apice"), "'l'\\''apice'");
});

test('shellCommand ricompone eseguibile e argv come si scriverebbero in bash', () => {
  // È la riga che finisce nella riga di stato a ogni spawn di sessione Claude:
  // deve poter essere ricopiata in un terminale e fare la stessa cosa.
  assert.equal(
    shellCommand('/opt/deck-run', deckArgs('T115', 'sid-1', 'run', 'sonnet', 'due parole')),
    "/opt/deck-run T115 --session-id sid-1 --prompt-kind run --model sonnet --title-note 'due parole'",
  );
  assert.equal(shellCommand('/opt/deck-run', ['--no-task']), '/opt/deck-run --no-task');
});

// ── l'annuncio del comando in-tab, letto dallo stdout di deck-run ─────────

/** Figlio finto col solo stdout: è tutto ciò che `onInTabCommand` guarda. */
function fakeChild(): { child: ChildProcess; out: PassThrough } {
  const out = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  (child as { stdout: PassThrough }).stdout = out;
  return { child, out };
}

test('onInTabCommand consegna la riga annunciata, senza il marker', () => {
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`${INTAB_MARKER}LOOM_TASK=T115 claude --name 'x' --model opus\n`);
  assert.deepEqual(seen, ["LOOM_TASK=T115 claude --name 'x' --model opus"]);
});

test('onInTabCommand regge la riga spezzata fra due chunk', () => {
  // Una pipe non consegna righe, consegna byte: l'annuncio può arrivare a metà.
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`${INTAB_MARKER}claude --na`);
  assert.deepEqual(seen, [], 'consegnato prima dell’a-capo');
  out.write("me 'x'\n");
  assert.deepEqual(seen, ["claude --name 'x'"]);
});

test('onInTabCommand ignora quel che precede e quel che segue', () => {
  // Prima dell'annuncio può uscire altro; dopo l'exec lo stdout è di ptyxis,
  // e una sua riga non deve sostituire il comando mostrato.
  const { child, out } = fakeChild();
  const seen: string[] = [];
  onInTabCommand(child, (c) => seen.push(c));
  out.write(`rumore\n${INTAB_MARKER}claude\naltro rumore\n${INTAB_MARKER}secondo\n`);
  assert.deepEqual(seen, ['claude']);
});

test('onInTabCommand su un figlio senza stdout non chiama nessuno', () => {
  // È il caso `LOOM_DECK_NO_SPAWN`: il figlio è inerte e non annuncia mai.
  // Il chiamante resta con la nota che ha già scritto.
  const child = new EventEmitter() as ChildProcess;
  let called = false;
  onInTabCommand(child, () => {
    called = true;
  });
  assert.equal(called, false);
});
