// T232 — gli strumenti comuni dei gate dei MODI (`modes-smoke*.test.ts`): la
// cattura a geometria fissa, la lettura del frame come testo, i progetti
// sintetici che più file usano.
//
// I gate dei modi verificano un COMPORTAMENTO — il modo compare, `esc` torna,
// lo spawn porta l'argv giusto — e non il layout: leggono il frame come testo
// senza sequenze, su un terminale di 120×44 sempre uguale. La larghezza la
// misura `frame-width*.test.ts`, coi suoi strumenti in `frame-kit.ts`.
//
// Non è un file di test (`*.test.ts`): il runner non lo esegue, lo importano.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAN_RUN, PROJECT, TASKS, runDeck, stripAnsi } from './pty-harness.js';

export function capture(
  keys: string,
  cwd: string = PROJECT,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return stripAnsi(captureRaw(keys, cwd, extraEnv));
}

/** I byte come sono usciti dal pty. Serve solo a chi misura le SEQUENZE invece
 *  del testo — il tracking mouse acceso e poi ripristinato (T21), che
 *  `stripAnsi` cancellerebbe insieme al resto. */
export function captureRaw(
  keys: string,
  cwd: string = PROJECT,
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  return runDeck({ cols: 120, rows: 44, keys, cwd, env: extraEnv });
}

/**
 * L'ULTIMO frame INTERO disegnato, cioè lo stato in cui il deck è rimasto.
 *
 * Il pty accumula ogni redraw e Ink NON emette un clear-screen fra l'uno e
 * l'altro (aggiorna per differenza finché il frame sta sotto `rows`): splittare
 * su `\x1b[2J` restituisce quindi un pezzo arbitrario, non l'ultimo stato.
 * L'ancora sono i due angoli della cornice, che ogni frame completo disegna una
 * volta ciascuno.
 *
 * Si prende l'ultima APERTURA che ha una chiusura dopo di sé, non l'ultima in
 * assoluto: il deck ridisegna anche mentre la cattura si sta chiudendo, quindi
 * l'ultima apertura può appartenere a un redraw scritto a metà — e un frammento
 * si legge come «il modo non ha disegnato la sua riga».
 */
export function lastFrame(captured: string): string {
  const end = captured.lastIndexOf('╰');
  if (end < 0) return captured;
  const at = captured.lastIndexOf('╭', end);
  return at >= 0 ? captured.slice(at, end + 1) : captured;
}

/** T116 — il deck è sopravvissuto alla sequenza: `pty-frame.py` lo dichiara in
 *  coda (`<<PROC alive|exit=N>>`). Il buffer di un deck vivo e quello di un deck
 *  appena morto sono indistinguibili senza quella riga — l'ultimo frame
 *  disegnato è lo stesso. */
export const alive = (captured: string) => /<<PROC alive>>/.test(captured);

/**
 * Il frame della LISTA: la testata porta a destra risoluzione e versione
 * (`120×38 · v0.98.0`), e nessuna schermata sostitutiva la disegna. È ciò che
 * dice «il deck ha disegnato il suo frame», o «è tornato alla lista».
 */
export const LIST_FRAME = /\d+×\d+ · v\d/;

/**
 * T154 — progetto SINTETICO con una sola conversazione, di modello NOTO e
 * deterministico: i test sul bersaglio RESUME di `m` non possono appoggiarsi
 * al cappello vero, la cui storia di sessioni cambia a ogni conversazione
 * lanciata su di esso — un modello «oggi» diventerebbe un calco che scade alla
 * prima sessione nuova. `HOME` dirottato con la cwd, come per il progetto a id
 * misti di `frame-kit.ts` (`mixedIdProject`): la lista sessioni si legge da
 * `~/.claude/projects/<hash della cwd>`.
 */
export function singleSessionProject(): { proj: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-onesession-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'runtime', 'tasks'), { recursive: true });
  writeFileSync(
    join(proj, 'runtime', 'tasks.md'),
    ['# Tasks', '', '## Tasks Overview', '', '| ID | Pri | Prog | Task |', '| --- | --- | --- | --- |'].join(
      '\n',
    ) + '\n',
  );
  const projects = join(root, 'home', '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, 'sid1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'sid1',
        cwd: proj,
        message: { role: 'user', content: 'ciao' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sid1',
        cwd: proj,
        message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'ok' }] },
      }),
    ].join('\n') + '\n',
  );
  return { proj, env: { HOME: join(root, 'home') } };
}

/**
 * T161 — un progetto con tasks.md e config, su cui la pagina delle azioni può
 * salvare. TEMPORANEO e col suo `.claude/loom-works.json`: `w` scrive davvero,
 * e scriverlo nel cappello vero significherebbe che lanciare i test riconfigura
 * il deck di chi li lancia.
 */
export function configProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'loom-deck-spawncfg-'));
  mkdirSync(join(root, 'runtime', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (CAN_RUN) copyFileSync(TASKS, join(root, 'runtime', 'tasks.md'));
  writeFileSync(
    join(root, '.claude', 'loom-works.json'),
    JSON.stringify({ id: 'prova', emoji: '🧵', name: 'prova' }, null, 2) + '\n',
  );
  return root;
}
