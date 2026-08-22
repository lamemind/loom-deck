import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStatusCache,
  statusDir,
  statusFilePath,
  statusLabel,
  writeStatusCache,
  STATUS_MISSING,
} from '../src/project-status.js';
import { WARN } from '../src/glyphs.js';

// ── coordinata del file ──────────────────────────────────────────────────

test('la coordinata è una funzione pura del path del progetto', () => {
  const a = statusFilePath('/home/tizio/work/alpha');
  const b = statusFilePath('/home/tizio/work/beta');
  assert.notEqual(a, b, 'due progetti condividono lo stesso file di cache');
  assert.equal(a, statusFilePath('/home/tizio/work/alpha'), 'la coordinata non è stabile');
  assert.ok(a.startsWith(statusDir()), `il file non sta nella cartella della cache: ${a}`);
  // Stessa trasformazione del transcript store di Claude Code: nessun separatore
  // di path sopravvive, quindi il nome resta un solo segmento.
  assert.ok(!a.slice(statusDir().length + 1).includes('/'), `il nome contiene un path: ${a}`);
});

test('la cartella della cache è per-utente', () => {
  // `/tmp` è world-writable: senza l'uid nel nome, un file a coordinata
  // prevedibile può essere preceduto dal symlink di un altro utente.
  assert.match(statusDir(), new RegExp(`loom-deck-status-${process.getuid?.() ?? 0}$`));
});

test("l'env override scavalca la derivazione", () => {
  const prev = process.env.LOOM_DECK_STATUS_FILE;
  process.env.LOOM_DECK_STATUS_FILE = '/tmp/finto.md';
  try {
    assert.equal(statusFilePath('/qualunque/progetto'), '/tmp/finto.md');
  } finally {
    if (prev === undefined) delete process.env.LOOM_DECK_STATUS_FILE;
    else process.env.LOOM_DECK_STATUS_FILE = prev;
  }
});

// ── round-trip ───────────────────────────────────────────────────────────

test('cache assente → null, mai un throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-status-'));
  assert.equal(readStatusCache(join(dir, 'mai-scritto.md')), null);
});

test('scrittura e rilettura conservano il testo, e il tempo è l\'mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-status-'));
  const path = join(dir, 'sub', 'recap.md');
  const text = '# Stato\n\nDue **task** aperte.\n';
  writeStatusCache(path, text);

  // L'mtime è la fonte dell'ora mostrata: un timestamp scritto dentro il testo
  // sarebbe lo stesso fatto scritto due volte, divergibile alla prima
  // riscrittura parziale.
  const backdate = new Date(Date.now() - 3600_000);
  utimesSync(path, backdate, backdate);

  const cache = readStatusCache(path);
  assert.ok(cache, 'cache non riletta');
  assert.equal(cache.text, text);
  assert.equal(cache.mtime, statSync(path).mtimeMs);
  assert.equal(readFileSync(path, 'utf8'), text, 'il file non è markdown nudo');
});

test('gli heading scritti per la chat tornano markdown', () => {
  // La skill produce per la chat di Claude Code, dove l'output style impone un
  // `#` in più: senza traduzione il viewer mostrerebbe `## Sezione` come TESTO
  // dentro un H1.
  const dir = mkdtempSync(join(tmpdir(), 'deck-status-'));
  const path = join(dir, 'recap.md');
  writeStatusCache(
    path,
    ['# ## Task aperte', '', '# ### Dettaglio', '', '# Titolo vero', '', 'testo # non heading'].join(
      '\n',
    ),
  );
  const text = readStatusCache(path)?.text ?? '';
  assert.match(text, /^## Task aperte$/m);
  assert.match(text, /^### Dettaglio$/m);
  // Un H1 legittimo non va toccato, e nemmeno un cancelletto in mezzo al testo.
  assert.match(text, /^# Titolo vero$/m);
  assert.match(text, /^testo # non heading$/m);
});

test('la riscrittura sostituisce, non accoda', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-status-'));
  const path = join(dir, 'recap.md');
  writeStatusCache(path, 'primo');
  writeStatusCache(path, 'secondo');
  assert.equal(readStatusCache(path)?.text, 'secondo');
});

// ── i tre stati dell'indicatore ──────────────────────────────────────────

const AT_0942 = new Date(2026, 7, 22, 9, 42).getTime();

test('nessuna cache e nessuna generazione → missing', () => {
  assert.equal(
    statusLabel({ mtime: null, startedAt: null, now: AT_0942, failed: false }),
    STATUS_MISSING,
  );
});

test('cache presente → ora dell\'ultima generazione riuscita', () => {
  assert.equal(
    statusLabel({ mtime: AT_0942, startedAt: null, now: AT_0942 + 60_000, failed: false }),
    '09:42',
  );
});

test('generazione in corso → i secondi trascorsi, che avanzano', () => {
  const started = AT_0942;
  assert.equal(
    statusLabel({ mtime: null, startedAt: started, now: started + 3_400, failed: false }),
    'building 3...',
  );
  assert.equal(
    statusLabel({ mtime: null, startedAt: started, now: started + 125_000, failed: false }),
    'building 125...',
  );
});

test('la generazione in corso copre l\'ora in cache, non la somma', () => {
  // Durante una generazione ciò che conta è che sta girando: l'ora del recap
  // vecchio resta leggibile nel viewer, che è dove serve.
  assert.equal(
    statusLabel({ mtime: AT_0942, startedAt: AT_0942 + 60_000, now: AT_0942 + 62_000, failed: false }),
    'building 2...',
  );
});

test('un now precedente allo spawn non produce secondi negativi', () => {
  // L'orologio di sistema può tornare indietro (ntp): un `building -4...` è una
  // riga che nessuno sa leggere.
  assert.equal(
    statusLabel({ mtime: null, startedAt: AT_0942, now: AT_0942 - 4_000, failed: false }),
    'building 0...',
  );
});

// ── il marker di fallimento ──────────────────────────────────────────────

test('il fallimento si AGGIUNGE al dato in cache, non lo sostituisce', () => {
  // D5 — i due fatti (cosa c'è in cache, com'è andato l'ultimo tentativo) sono
  // sempre entrambi veri nello stesso istante: un `failed` al posto dell'ora
  // butterebbe via un recap ancora leggibile e ancora apribile.
  assert.equal(
    statusLabel({ mtime: AT_0942, startedAt: null, now: AT_0942, failed: true }),
    `09:42 ${WARN}`,
  );
});

test('fallimento senza cache → missing col marker', () => {
  assert.equal(
    statusLabel({ mtime: null, startedAt: null, now: AT_0942, failed: true }),
    `${STATUS_MISSING} ${WARN}`,
  );
});
