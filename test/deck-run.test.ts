import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T56 — gate sul COMANDO IN-TAB che deck-run compone: è la superficie dove il
// prompt viene scelto e quotato, e nessun altro test la copre (il resto della
// suite è TypeScript, questo è l'unico anello bash).
//
// Tecnica: uno shim `ptyxis` in testa al PATH che stampa i propri argv invece di
// aprire una tab. deck-run finisce con `exec ptyxis … -- bash -lc "$IN_TAB_CMD"`,
// quindi l'ULTIMO argomento stampato è esattamente il comando che girerebbe
// dentro la tab. Nessun --dry-run da aggiungere allo script: il test osserva il
// codice vero, non un ramo scritto per lui.
//
// LOOM_DECK_WORKDIR punta a una dir temporanea SENZA .claude/loom-works.json →
// label e permissionMode cadono sui fallback (`cc <task>`, `manual`), così le
// asserzioni non dipendono dal progetto in cui gira la suite.

const DECK_RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deck-run');
const SID = '11111111-2222-3333-4444-555555555555';

const shimDir = mkdtempSync(join(tmpdir(), 'loom-deck-shim-'));
writeFileSync(join(shimDir, 'ptyxis'), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n");
chmodSync(join(shimDir, 'ptyxis'), 0o755);

const workdir = mkdtempSync(join(tmpdir(), 'loom-deck-wd-'));
mkdirSync(workdir, { recursive: true });

type Run = { ok: boolean; out: string; err: string };

// spawnSync e non execFileSync: quest'ultimo espone lo stderr solo lanciando,
// cioè solo sui fallimenti — ma deck-run avvisa su stderr anche quando riesce
// (valore scartato con fallback), e quella riga è essa stessa sotto gate.
function deckRun(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [DECK_RUN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      LOOM_DECK_WORKDIR: workdir,
      LOOM_DECK_PERMISSION_MODE: 'manual',
      LOOM_DECK_ENTER_PROMPT: '',
      // Settata a VUOTO = "niente lookup dconf": senza questo la suite
      // leggerebbe il registry della macchina su cui gira, e il comando atteso
      // dipenderebbe dai progetti registrati lì. I test che vogliono il
      // prefisso lo passano esplicito via `env`.
      LOOM_DECK_STATE_PROFILE: '',
      // Vuota per la stessa ragione del profilo di stato: senza, il comando
      // atteso dipenderebbe dall'ambiente di chi lancia la suite.
      LOOM_DECK_MODEL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Ultimo argv dello shim = il comando passato a `bash -lc` dentro la tab. */
function inTabCmd(args: string[], env: Record<string, string> = {}): string {
  const r = deckRun(args, env);
  assert.ok(r.ok, `deck-run ${args.join(' ')} è fallito: ${r.err}`);
  const lines = r.out.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

const PROMPTS: Array<[string, string | null]> = [
  ['none', null],
  ['recap', '/loom-works:recap-status T56'],
  ['recap-task', '/loom-works:recap-status-task T56'],
  ['recap-epic', '/loom-works:recap-status-epic T56'],
  ['preflight', '/loom-works:preflight-task T56'],
  ['run', '/loom-works:run-task T56'],
  ['checkpoint', '/loom-works:checkpoint-task T56'],
];

for (const [kind, prompt] of PROMPTS) {
  test(`--prompt-kind ${kind}: sessione bound, prompt ${prompt ?? 'assente'}`, () => {
    const cmd = inTabCmd(['T56', '--session-id', SID, '--prompt-kind', kind]);
    // Task-bound su TUTTI e quattro: è ciò che distingue questi spawn da
    // `--no-task`, che spegne il prompt ma perde anche la task.
    assert.match(cmd, /^LOOM_TASK=T56 claude /);
    assert.ok(cmd.includes(`--session-id ${SID}`));
    if (prompt === null) {
      // `none` non è stringa vuota: l'argomento posizionale sparisce del tutto,
      // altrimenti CC riceverebbe un prompt vuoto. Il prompt è sempre l'ULTIMO
      // elemento ed è single-quoted → assenza = la riga non finisce per apice
      // (gli apici di `--name '…'` stanno in mezzo, non in coda).
      assert.ok(!cmd.trimEnd().endsWith("'"), `atteso nessun prompt, trovato: ${cmd}`);
    } else {
      // Il prompt è single-quoted: è così che `/loom-works:…` arriva intero,
      // senza che lo shell tocchi slash e due punti.
      assert.ok(cmd.endsWith(`'${prompt}'`), `atteso prompt '${prompt}', trovato: ${cmd}`);
    }
  });
}

// Lista monofamiglia: ogni kind è un template diretto sull'id, nessuno
// discrimina sulla forma dell'id.
test('ogni kind interpola l’id senza dispacciare', () => {
  assert.ok(
    inTabCmd(['T02', '--prompt-kind', 'recap']).endsWith("'/loom-works:recap-status T02'"),
  );
  assert.ok(inTabCmd(['T02', '--prompt-kind', 'run']).endsWith("'/loom-works:run-task T02'"));
  assert.ok(
    inTabCmd(['T02', '--prompt-kind', 'preflight']).endsWith("'/loom-works:preflight-task T02'"),
  );
  assert.ok(
    inTabCmd(['T02', '--prompt-kind', 'checkpoint']).endsWith("'/loom-works:checkpoint-task T02'"),
  );
});

// Il flag assente vale `recap`, e ci vale ancora dopo che il TESTO del kind è
// cambiato: l'invariante è il default, non la stringa. Asserirli entrambi separa
// una regressione del default da un edit del catalogo.
test('senza flag il prompt è quello del kind recap', () => {
  const nudo = inTabCmd(['T56', '--session-id', SID]);
  const esplicito = inTabCmd(['T56', '--session-id', SID, '--prompt-kind', 'recap']);
  assert.equal(nudo, esplicito);
  assert.ok(nudo.endsWith("'/loom-works:recap-status T56'"));
});

test('LOOM_DECK_ENTER_PROMPT vince sul kind, ma non su none', () => {
  const env = { LOOM_DECK_ENTER_PROMPT: 'x {TASK} y' };
  assert.ok(inTabCmd(['T56'], env).endsWith("'x T56 y'"));
  assert.ok(inTabCmd(['T56', '--prompt-kind', 'run'], env).endsWith("'x T56 y'"));
  // Chi chiede esplicitamente nessun prompt non vuole quello d'ambiente.
  assert.ok(!inTabCmd(['T56', '--prompt-kind', 'none'], env).includes("'x T56 y'"));
});

// ── T117 · il prompt letterale ─────────────────────────────────────────────

test('--prompt passa il testo verbatim, senza toccare il catalogo', () => {
  const cmd = inTabCmd(['T56', '--session-id', SID, '--prompt', 'fai la cosa']);
  assert.ok(cmd.endsWith("'fai la cosa'"), `prompt letterale non arrivato: ${cmd}`);
  assert.match(cmd, /^LOOM_TASK=T56 claude /);
});

// SICUREZZA — il prompt è l'unico ingresso di testo LIBERO che finisce in una
// riga che una shell parsa (`bash -lc "$IN_TAB_CMD"`). Un apice singolo non
// quotato chiuderebbe la stringa e consegnerebbe alla shell tutto ciò che segue
// come comando: `'; rm -rf ~; echo '` diventerebbe eseguibile. La forma canonica
// (`'\''`) lo rende un carattere letterale come gli altri.
test('--prompt: un apice singolo non evade dalla stringa', () => {
  const cmd = inTabCmd(['T56', '--prompt', "non e' finita; echo PWNED"]);
  assert.ok(cmd.endsWith(`'non e'\\'' finita; echo PWNED'`), `quoting rotto: ${cmd}`);
  // Prova sul campo: dato lo stesso comando a una shell vera, il prompt deve
  // arrivare come UN argomento. Se l'apice evadesse, `echo PWNED` girerebbe come
  // comando a sé e l'output sarebbe di DUE righe — da cui l'asserzione sul
  // numero di righe e non sulla presenza della parola, che compare comunque
  // dentro il prompt legittimo.
  const probe = spawnSync('bash', ['-c', `claude() { printf '%s\\n' "\${@: -1}"; }; ${cmd}`], {
    encoding: 'utf8',
  });
  assert.deepEqual(probe.stdout.trimEnd().split('\n'), ["non e' finita; echo PWNED"]);
});

test('--prompt vuoto = nessun prompt, non un posizionale vuoto', () => {
  // `--prompt ''` è una richiesta legittima (campo svuotato a mano), distinta
  // dal flag assente — che cadrebbe sul default `recap`.
  const cmd = inTabCmd(['T56', '--prompt', '']);
  assert.ok(!cmd.trimEnd().endsWith("'"), `atteso nessun prompt, trovato: ${cmd}`);
});

test('--prompt e --prompt-kind sono mutuamente esclusivi', () => {
  const r = deckRun(['T56', '--prompt', 'x', '--prompt-kind', 'run']);
  assert.equal(r.ok, false);
  assert.match(r.err, /mutuamente esclusivi/);
});

// T134/D9 — il divieto è caduto, e l'asimmetria col kind è il punto: i sette
// template del catalogo interpolano tutti `{TASK}`, un testo già composto no.
// Il caso vivo è il deck che offre il drain di un file inbox e lo srotolamento
// dei `.md` di un path: due lavori sulla doc, che non appartengono a nessuna
// task e non devono ereditarne una.
test('--prompt con --no-task: ammesso, e il prompt arriva alla sessione', () => {
  const cmd = inTabCmd(['--no-task', '--prompt', '/loom-works:drain-notions T134-x.md']);
  assert.ok(
    cmd.endsWith("'/loom-works:drain-notions T134-x.md'"),
    `il prompt non è arrivato nella sessione nuda: ${cmd}`,
  );
  // Nuda resta nuda: nessun LOOM_TASK, nessun suffisso di task nel titolo.
  assert.ok(!cmd.includes('LOOM_TASK='), `sessione nuda con un binding task: ${cmd}`);
});

test('--prompt-kind con --no-task resta rifiutato: il catalogo nomina un TaskID', () => {
  // L'asimmetria col ramo sopra non è una dimenticanza: un kind senza task
  // produrrebbe `/loom-works:run-task ` con l'id vuoto, cioè una tab che parte
  // su un comando monco.
  const r = deckRun(['--no-task', '--prompt-kind', 'run']);
  assert.equal(r.ok, false);
  assert.match(r.err, /--prompt-kind richiede una task/);
});

test('LOOM_DECK_ENTER_PROMPT non scavalca un --prompt esplicito', () => {
  // L'override d'ambiente esiste per la retro-compat sul KIND; scavalcare un
  // testo già composto a mano butterebbe via proprio la modifica che il flag
  // esiste per portare.
  const cmd = inTabCmd(['T56', '--prompt', 'mio testo'], { LOOM_DECK_ENTER_PROMPT: 'x {TASK} y' });
  assert.ok(cmd.endsWith("'mio testo'"), `l'env ha scavalcato --prompt: ${cmd}`);
});

// Il catalogo è un file DATI letto a runtime, non più un `case` dentro lo
// script: se sparisce, deck-run lo dice e apre una sessione senza prompt invece
// di inventarne uno.
test('catalogo assente: avviso su stderr e nessun prompt', () => {
  const r = deckRun(['T56', '--prompt-kind', 'run'], {
    LOOM_DECK_PROMPT_CATALOG: '/non/esiste/affatto',
  });
  assert.equal(r.ok, true);
  assert.match(r.err, /catalogo prompt non leggibile/);
  const cmd = r.out.trimEnd().split('\n').pop() ?? '';
  assert.ok(!cmd.trimEnd().endsWith("'"), `prompt inventato senza catalogo: ${cmd}`);
});

test('--prompt-kind ignoto: errore d’uso, non fallback silenzioso', () => {
  const r = deckRun(['T56', '--prompt-kind', 'bogus']);
  assert.equal(r.ok, false);
  assert.match(r.err, /--prompt-kind ignoto: 'bogus'/);
});

test('--prompt-kind con --no-task: richiesta contraddittoria, rifiutata', () => {
  const r = deckRun(['--no-task', '--prompt-kind', 'run']);
  assert.equal(r.ok, false);
  assert.match(r.err, /--prompt-kind richiede una task/);
});

test('--resume: nessun prompt, qualunque sia il kind', () => {
  const cmd = inTabCmd(['T56', '--resume', SID, '--prompt-kind', 'run']);
  assert.ok(cmd.includes(`--resume ${SID}`));
  // Riprendere una conversazione significa continuarla, non iniettarle un
  // messaggio nuovo: il kind non riapre quella porta.
  assert.ok(!cmd.includes("'/loom-works:run-task"), `prompt inatteso sul resume: ${cmd}`);
});

// T58 — derivazione della label dal file config. Il resto della suite gira su un
// workdir SENZA `.claude/loom-works.json` (fallback `cc <task>`): questo è
// l'unico punto che osserva la formula vera, cioè la chiave con cui compass
// riconosce la finestra.
const labeledWd = mkdtempSync(join(tmpdir(), 'loom-deck-wd-cfg-'));
mkdirSync(join(labeledWd, '.claude'), { recursive: true });
writeFileSync(
  join(labeledWd, '.claude', 'loom-works.json'),
  JSON.stringify({ id: 'demo', emoji: '🧵', owner: 'LOCAL', name: 'demo', surfaces: { claude: true } }),
);

test('titolo tab: `<emoji> <name>` + suffisso task, owner escluso', () => {
  const cmd = inTabCmd(['T58'], { LOOM_DECK_WORKDIR: labeledWd });
  assert.ok(cmd.includes("--name '🧵 demo · T58'"), `titolo inatteso: ${cmd}`);
  assert.ok(!cmd.includes('LOCAL'), `owner presente nel titolo: ${cmd}`);
});

test('titolo tab senza task: solo la label, nessun suffisso', () => {
  const cmd = inTabCmd(['--no-task'], { LOOM_DECK_WORKDIR: labeledWd });
  assert.ok(cmd.includes("--name '🧵 demo'"), `titolo inatteso: ${cmd}`);
});

// T64 — nota nel titolo. Il gate vero non è il formato ma la RIDUZIONE: la nota
// è l'unico testo libero che entra in un titolo destinato a viaggiare dentro
// apici singoli in `bash -lc`, quindi un apice che sopravvive non è un titolo
// brutto, è un comando in-tab rotto.
test('--title-note: suffisso «nota» dopo la task, label intatta in testa', () => {
  const cmd = inTabCmd(['T64', '--resume', SID, '--title-note', 'Puppa'], {
    LOOM_DECK_WORKDIR: labeledWd,
  });
  assert.ok(cmd.includes("--name '🧵 demo · T64 «Puppa»'"), `titolo inatteso: ${cmd}`);
});

test('--title-note: alfabeto ridotto, apici e metacaratteri spariti', () => {
  const sporca = `l'ordine "conta" $(id) \`x\` ; rm -rf / & àèéìòù 🔥  spazi__ok`;
  const cmd = inTabCmd(['T64', '--resume', SID, '--title-note', sporca], {
    LOOM_DECK_WORKDIR: labeledWd,
  });
  const title = cmd.match(/--name '([^']*)'/)?.[1];
  assert.ok(title, `titolo non estraibile (apice sopravvissuto?): ${cmd}`);
  // Solo lettere/cifre/accentate/spazio/-/_ , spazi collassati.
  assert.equal(title, '🧵 demo · T64 «lordine conta id x rm -rf àèéìòù spazi__ok»');
  // Il comando resta una riga sola: nessun `;` o `&` che spezzi in due comandi.
  assert.ok(!/[;&`$]/.test(title!), `metacarattere superstite: ${title}`);
});

test('--title-note: nota tutta scartata → nessun «» a vuoto', () => {
  const cmd = inTabCmd(['T64', '--resume', SID, '--title-note', '🔥🔥 !!! 🔥'], {
    LOOM_DECK_WORKDIR: labeledWd,
  });
  assert.ok(cmd.includes("--name '🧵 demo · T64'"), `titolo inatteso: ${cmd}`);
  assert.ok(!cmd.includes('«'), `suffisso vuoto emesso: ${cmd}`);
});

test('--title-note: cap a 60 caratteri, taglio non a metà di un multibyte', () => {
  const cmd = inTabCmd(['T64', '--resume', SID, '--title-note', 'à'.repeat(80)], {
    LOOM_DECK_WORKDIR: labeledWd,
  });
  const nota = cmd.match(/«([^»]*)»/)?.[1] ?? '';
  assert.equal(nota, 'à'.repeat(60));
});

// T111 — la nota alla NASCITA. Fino a qui ogni caso `--title-note` passava da
// `--resume`, cioè dal ramo dove il prompt iniziale non c'è: il flag sembrava
// appartenere alla ripresa. Nello script il suffisso è appeso a `TITLE` prima
// che i rami si separino, e questo è il gate che lo fissa — titolo annotato E
// prompt della task nello stesso comando.
test('--title-note su sessione nuova: titolo annotato e prompt della task intatto', () => {
  const cmd = inTabCmd(
    ['T111', '--session-id', SID, '--prompt-kind', 'preflight', '--title-note', 'baluba'],
    { LOOM_DECK_WORKDIR: labeledWd },
  );
  assert.ok(cmd.includes("--name '🧵 demo · T111 «baluba»'"), `titolo inatteso: ${cmd}`);
  // La label resta in TESTA: il match compass è un `.includes` sulla chiave, e
  // una nota che si infilasse prima la spezzerebbe.
  assert.ok(cmd.includes("--name '🧵 demo · "), `label spostata: ${cmd}`);
  assert.ok(cmd.endsWith("'/loom-works:preflight-task T111'"), `prompt perso: ${cmd}`);
  assert.match(cmd, /^LOOM_TASK=T111 claude /);
});

test('--title-note con --fork: il suffisso fork resta in coda', () => {
  const cmd = inTabCmd(
    ['T64', '--resume', SID, '--fork', '--title-note', 'ramo'],
    { LOOM_DECK_WORKDIR: labeledWd },
  );
  assert.ok(cmd.includes("--name '🧵 demo · T64 «ramo» · fork'"), `titolo inatteso: ${cmd}`);
});

// Profilo di stato per compass. Il canale è invisibile al resto della suite: il
// titolo (match FINESTRA) e lo stato (annuncio D-Bus keyed su PTYXIS_PROFILE)
// sono due canali distinti, e finora solo il primo era sotto gate — motivo per
// cui una tab poteva risultare presente e insieme senza stato per sempre.
const STATE_UUID = '64b5dc77eed04031ae0c0ab8431088b8';

test('profilo di stato: PTYXIS_PROFILE forzata in testa al comando in-tab', () => {
  const cmd = inTabCmd(['T60'], { LOOM_DECK_STATE_PROFILE: STATE_UUID });
  // In TESTA e prima di LOOM_TASK: sono due assegnazioni env dello stesso
  // prefisso, ma l'ordine tiene stabile l'unica riga che i test leggono.
  assert.match(cmd, new RegExp(`^PTYXIS_PROFILE=${STATE_UUID} LOOM_TASK=T60 claude `));
});

test('profilo di stato: presente anche sulla sessione nuda (--no-task)', () => {
  // Lo stato è proprietà della sessione, non della task: una sessione spot che
  // chiede conferma deve accendere il pallino come qualunque altra.
  const cmd = inTabCmd(['--no-task'], { LOOM_DECK_STATE_PROFILE: STATE_UUID });
  assert.match(cmd, new RegExp(`^PTYXIS_PROFILE=${STATE_UUID} claude `));
});

test('profilo di stato assente: comando invariato, nessun prefisso a vuoto', () => {
  // Progetto non registrato nel registry → si degrada al comportamento di prima
  // (stato orfano), non a uno spawn rotto.
  const cmd = inTabCmd(['T60'], { LOOM_DECK_STATE_PROFILE: '' });
  assert.match(cmd, /^LOOM_TASK=T60 claude /);
  assert.ok(!cmd.includes('PTYXIS_PROFILE'), `prefisso emesso a vuoto: ${cmd}`);
});

test('profilo di stato con caratteri non ammessi: scartato, non quotato', () => {
  // Il valore arriva da dconf, che è un file editabile a mano, e finisce dentro
  // `bash -lc "…"`: whitelist come per la nota del titolo.
  const r = deckRun(['T60'], { LOOM_DECK_STATE_PROFILE: 'abc"; id; #' });
  assert.equal(r.ok, true);
  const cmd = r.out.trimEnd().split('\n').pop() ?? '';
  assert.ok(!cmd.includes('PTYXIS_PROFILE'), `valore ostile passato in-tab: ${cmd}`);
  assert.match(r.err, /profilo di stato ignorato/);
});

// T108 — quarto asse: il modello. Ortogonale agli altri tre, quindi il gate lo
// verifica su TUTTI i rami che avviano `claude`, non solo su quello bound.
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

for (const m of MODELS) {
  test(`--model ${m}: il flag arriva al CLI sul ramo task-bound`, () => {
    const cmd = inTabCmd(['T108', '--session-id', SID, '--model', m]);
    assert.match(cmd, new RegExp(`--model ${m}\\b`), `flag assente: ${cmd}`);
  });
}

test('--model senza flag: default opus, passato comunque', () => {
  // Passato SEMPRE, anche sul default: lo spawn resta leggibile nel process tree
  // invece di dipendere dal default del CLI, che cambia fra versioni.
  assert.match(inTabCmd(['T108']), /--model opus\b/);
});

test('--model viaggia anche su --no-task e su --resume', () => {
  assert.match(inTabCmd(['--no-task', '--model', 'haiku']), /--model haiku\b/);
  assert.match(inTabCmd(['T108', '--resume', SID, '--model', 'sonnet']), /--model sonnet\b/);
});

test('--model ignoto: fallback opus con avviso, mai una tab rotta', () => {
  // Regime opposto a --prompt-kind: quel valore si ferma dentro lo script, il
  // modello arriverebbe al CLI e produrrebbe un comando che fallisce all'avvio.
  const r = deckRun(['T108', '--model', 'bogus']);
  assert.equal(r.ok, true);
  const cmd = r.out.trimEnd().split('\n').pop() ?? '';
  assert.match(cmd, /--model opus\b/, `fallback non applicato: ${cmd}`);
  assert.ok(!cmd.includes('bogus'), `valore ignoto passato in-tab: ${cmd}`);
  assert.match(r.err, /modello ignoto: 'bogus'/);
});

test('LOOM_DECK_MODEL: default d’ambiente, il flag esplicito vince', () => {
  assert.match(inTabCmd(['T108'], { LOOM_DECK_MODEL: 'haiku' }), /--model haiku\b/);
  assert.match(
    inTabCmd(['T108', '--model', 'fable'], { LOOM_DECK_MODEL: 'haiku' }),
    /--model fable\b/,
  );
});

// ── annuncio del comando in-tab ───────────────────────────────────────────

test('deck-run annuncia su stdout il comando che eseguirà nella tab', () => {
  // È il canale con cui il deck mostra l'invocazione `claude` vera senza
  // ricomporla per conto proprio. L'asserzione lega l'annuncio all'ULTIMO argv
  // dello shim, cioè al comando davvero passato a `bash -lc`: se un giorno la
  // riga finisse prima di un'assegnazione di IN_TAB_CMD, annuncerebbe qualcosa
  // di diverso da quello eseguito e questo test cadrebbe.
  const r = deckRun(['T56', '--session-id', SID, '--prompt-kind', 'run']);
  assert.ok(r.ok, `deck-run è fallito: ${r.err}`);
  const lines = r.out.trimEnd().split('\n');
  const announced = lines.find((l) => l.startsWith('LOOM_DECK_INTAB '));
  assert.ok(announced, `nessun annuncio in stdout: ${JSON.stringify(lines)}`);
  assert.equal(announced.slice('LOOM_DECK_INTAB '.length), lines[lines.length - 1]);
  assert.match(announced, /claude --name/);
});

test("l'annuncio esce su stdout anche nella forma nuda (--no-task)", () => {
  const r = deckRun(['--no-task', '--resume', SID]);
  assert.ok(r.ok, `deck-run è fallito: ${r.err}`);
  const announced = r.out.trimEnd().split('\n').find((l) => l.startsWith('LOOM_DECK_INTAB '));
  assert.ok(announced, 'annuncio assente nel ramo --no-task');
  assert.match(announced, new RegExp(`claude --name .* --resume ${SID}`));
  // Nessuna LOOM_TASK: è il ramo nudo, e l'annuncio deve mostrarlo com'è.
  assert.doesNotMatch(announced, /LOOM_TASK=/);
});

test('un errore di validazione non annuncia niente', () => {
  // L'annuncio significa «sto per eseguire questo»: su un rifiuto non c'è
  // nessun comando, e stamparlo lo farebbe sembrare partito.
  const r = deckRun(['T56', '--prompt-kind', 'bogus']);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.out, /LOOM_DECK_INTAB/);
});
