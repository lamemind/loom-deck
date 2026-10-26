// T176 — la COMPOSIZIONE di una tab di conversazione: dai quattro assi di
// `deck-run` (`tab-args.ts`) a titolo, flag di `claude`, env di sessione e
// comando in-tab.
//
// Un composer solo per Linux e Windows (D1 preflight). Cambia per piattaforma
// solo CHI riceve il risultato: su Linux una riga per `bash -lc` dentro una tab
// Ptyxis, su Windows l'argv di `claude` in una variabile d'ambiente letta dal
// wrapper della tab (`windows-terminal.ts`). Titolo, modello, permission mode e
// prompt si risolvono qui una volta, per entrambe.
//
// Modulo PURO: il file di progetto, il catalogo dei prompt e l'env arrivano già
// letti. Le regole e i messaggi sono quelli dello script bash che questo modulo
// ha sostituito, e il gate di parità su Linux (`test/deck-run.test.ts`) li
// misura sul comando in-tab.
import { saneNote } from './sane-note.js';
import { MODEL_DEFAULT, MODELS, type PromptKind } from './spawn-catalog.js';
import type { CatalogEntry } from './prompt-catalog.js';
import { shellQuote } from './spawn.js';
import type { TabRequest } from './tab-args.js';
import { twinTitle } from './twin-title.js';

/** Gli ingressi della composizione oltre alla richiesta. */
export interface ComposeContext {
  env: Readonly<Record<string, string | undefined>>;
  /** `.claude/loom-works.json` della project root, già parsato; `null` se il
   *  progetto non ne ha uno o il file non si legge. */
  config: unknown;
  catalog: ReadonlyMap<string, CatalogEntry>;
  /** Il path del catalogo, per l'avviso quando manca. */
  catalogPath: string;
  platform: NodeJS.Platform;
  /** T182 — i nomi chiesti con `--name` dalle conversazioni vive
   *  (`liveRequestedNames`): decidono il carattere del gemello in coda al
   *  titolo. Assente = nessuna conversazione viva, titolo base. */
  liveRequestedNames?: readonly string[];
}

/** Cosa gira nella tab, in due forme che non divergono: la stessa terna di
 *  campi produce l'argv e la riga. */
export interface TabPlan {
  title: string;
  /** Gli argomenti di `claude`, nome del comando escluso. */
  claudeArgs: string[];
  /** Le env che legano la sessione: `LOOM_TASK` sul ramo bound, la chiave di
   *  stato per compass su Linux. */
  sessionEnv: Record<string, string>;
  /** La riga in-tab. Su Linux è il comando passato a `bash -lc`; su Windows è
   *  la sua resa, perché lì nessuna shell la parsa — l'argv vero viaggia in
   *  `claudeArgs`. */
  inTab: string;
  /** Avvisi su stderr: un valore scartato con fallback, il catalogo mancante. */
  warnings: string[];
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

/** L'alfabeto della chiave di stato: il valore entra in `bash -lc "…"` e il
 *  file di progetto è editabile a mano, quindi si scarta invece di quotare. */
const STATE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Un campo del file di progetto come lo leggeva `jq -r '.campo // empty'`:
 * `null`, `false` o assente danno vuoto, una stringa passa com'è, ogni altro
 * valore diventa il suo JSON (`jq -r` stampa così numeri e oggetti).
 */
function configField(config: unknown, key: string): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return '';
  const v = (config as Record<string, unknown>)[key];
  if (v === undefined || v === null || v === false) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * La label del progetto, `{emoji} {name}`: la chiave con cui compass riconosce
 * la finestra cercando nel titolo della tab attiva. Vuota se il file manca o
 * non porta entrambi i campi, e il titolo ricade su `cc`.
 */
export function projectLabel(config: unknown): string {
  const emoji = configField(config, 'emoji');
  const name = configField(config, 'name');
  return emoji && name ? `${emoji} ${name}` : '';
}

/**
 * Il titolo della tab: label + `· <task>` + nota + `· fork`.
 *
 * La label sta in TESTA perché il match di compass è un `.includes` sulla
 * chiave, e tutto il resto va in coda per non spezzarla. Il suffisso task
 * distingue le tab di più task, la nota (T64) quelle di più conversazioni sulla
 * stessa task, `· fork` (T28) un ramo dalla sua origine. La nota è l'unico testo
 * libero del titolo: non si quota, si RIDUCE (`saneNote`) — e ridotta a vuoto
 * non lascia nessun suffisso.
 */
export function tabTitle(req: TabRequest, label: string): string {
  let title: string;
  if (req.noTask) title = label || 'cc';
  else title = label ? `${label} · ${req.task}` : `cc ${req.task}`;
  if (req.titleNote) {
    const note = saneNote(req.titleNote);
    if (note) title = `${title} ${note}`;
  }
  if (req.fork) title = `${title} · fork`;
  return title;
}

/**
 * Il permission mode: env `LOOM_DECK_PERMISSION_MODE` > campo del file > `manual`.
 *
 * Passato SEMPRE al CLI, anche `manual`: lo spawn resta deterministico invece
 * di dipendere da un default che cambia fra versioni. Un valore fuori elenco
 * non arriva al CLI — produrrebbe una tab con un comando rotto — e degrada a
 * `manual` con un avviso.
 */
function permissionMode(ctx: ComposeContext, warnings: string[]): string {
  const raw = ctx.env.LOOM_DECK_PERMISSION_MODE || configField(ctx.config, 'permissionMode');
  if (!raw) return 'manual';
  if (PERMISSION_MODES.includes(raw)) return raw;
  warnings.push(`permissionMode ignoto: '${raw}' → fallback 'manual'`);
  return 'manual';
}

/**
 * Il kind di catalogo effettivo: solo sul ramo bound senza prompt letterale.
 * `--no-task` e `--prompt` non hanno una riga di catalogo da consultare, né per
 * il prompt né per il modello.
 */
function catalogKind(req: TabRequest): string {
  return !req.promptGiven && !req.noTask ? req.promptKind || 'recap' : '';
}

/**
 * Il modello: `--model` > env `LOOM_DECK_MODEL` > modello del kind nel catalogo
 * > `MODEL_DEFAULT`.
 *
 * Il deck TUI passa SEMPRE `--model` già risolto (T161), quindi dal deck la
 * cascata si ferma al primo gradino: i tre sotto servono a chi invoca a mano.
 * Le voci restano ALIAS fino dentro `claude --model`: un id versionato cablato
 * qui diventerebbe un modello inesistente al primo cambio di generazione. Un
 * valore ignoto degrada al default con un avviso — arriverebbe al CLI, che lo
 * rifiuterebbe all'avvio.
 */
function modelOf(req: TabRequest, ctx: ComposeContext, warnings: string[]): string {
  let model = req.model || ctx.env.LOOM_DECK_MODEL || '';
  const kind = catalogKind(req);
  if (!model && kind && kind !== 'none') model = ctx.catalog.get(kind)?.model ?? '';
  if (!model) return MODEL_DEFAULT;
  if ((MODELS as readonly string[]).includes(model)) return model;
  warnings.push(`modello ignoto: '${model}' → fallback '${MODEL_DEFAULT}' (usa ${MODELS.join('|')})`);
  return MODEL_DEFAULT;
}

/**
 * Il prompt iniziale, vuoto = nessun prompt.
 *
 * `--prompt` vince su tutto ed è usato così com'è. Una sessione nuda senza
 * `--prompt` non ha prompt: il default `recap` del catalogo non si applica,
 * perché ogni template interpola `{TASK}` e con la task vuota sarebbe un
 * comando monco. Sul ramo bound il kind sceglie il template; un catalogo che
 * non ha la voce è un'installazione mutila, e la sessione parte senza prompt
 * dicendolo. `LOOM_DECK_ENTER_PROMPT` vince sul kind, tranne su `none`.
 */
function promptOf(req: TabRequest, ctx: ComposeContext, warnings: string[]): string {
  if (req.promptGiven) return req.promptText;
  if (req.noTask) return '';
  const kind = catalogKind(req) as PromptKind;
  if (kind === 'none') return '';
  const enter = ctx.env.LOOM_DECK_ENTER_PROMPT;
  const template = ctx.catalog.get(kind)?.template;
  if (template === undefined) {
    warnings.push(
      `catalogo prompt non leggibile ('${ctx.catalogPath}'): sessione senza prompt iniziale`,
    );
  }
  const text = enter || template || '';
  return text.replaceAll('{TASK}', req.task);
}

/**
 * La chiave di stato per compass, solo su Linux: env `LOOM_DECK_STATE_PROFILE`
 * (anche vuota = nessun annuncio) > `id` del file di progetto.
 *
 * Lo stato di una sessione viaggia verso compass via D-Bus keyed su
 * `PTYXIS_PROFILE`, e compass lo associa a un progetto solo se la chiave è l'`id`
 * di un progetto del registry. Senza la variabile forzata in-tab, Ptyxis ne
 * esporterebbe una col valore del profilo di default, e il badge resterebbe
 * fermo senza nessun errore. Il nome della variabile è storico: non contiene
 * l'UUID di un profilo. Su Windows compass non esiste, e la chiave non serve.
 */
function stateKey(ctx: ComposeContext, warnings: string[]): string {
  if (ctx.platform === 'win32') return '';
  const raw =
    ctx.env.LOOM_DECK_STATE_PROFILE !== undefined
      ? ctx.env.LOOM_DECK_STATE_PROFILE
      : configField(ctx.config, 'id');
  if (raw && !STATE_KEY_RE.test(raw)) {
    warnings.push(`profilo di stato ignorato (caratteri non ammessi): '${raw}'`);
    return '';
  }
  return raw;
}

/** Un testo come UN argomento di una shell POSIX: sempre fra apici singoli, con
 *  l'apice stesso chiuso, escapato e riaperto (`'\''`). Dentro gli apici nessun
 *  altro carattere resta speciale, newline compresi. */
export function posixQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * La composizione intera.
 *
 * Il titolo è `tabTitle` più, solo se una conversazione viva ha già chiesto lo
 * stesso nome, il carattere del gemello (`twinTitle`, T182). Il carattere entra
 * nel titolo intero — label, task, nota e fork compresi — perché due
 * conversazioni della stessa task con note diverse hanno già titoli distinti e
 * non sono gemelle. Lo stesso `title` alimenta `-T` di Ptyxis e `--name`.
 *
 * Ordine degli argomenti di `claude`: nome, permission mode e modello prima dei
 * flag di continuità, il prompt sempre ultimo. Il modello sta accanto al
 * permission mode perché sono la stessa cosa — la scelta di chi apre la
 * sessione — e non una proprietà della task né della ripresa.
 *
 * Su una ripresa il prompt salta anche sul ramo bound: riprendere significa
 * continuare la conversazione, non iniettarle un messaggio nuovo; il fork è una
 * ripresa con id nuovo e ricade nello stesso ramo. Il `--session-id` vale invece
 * anche sul ramo nudo: nel fork di una sessione spot rende noto in anticipo
 * l'id del ramo, senza il quale il lineage non sarebbe registrabile.
 */
export function composeTab(req: TabRequest, ctx: ComposeContext): TabPlan {
  const warnings: string[] = [];
  const title = twinTitle(tabTitle(req, projectLabel(ctx.config)), ctx.liveRequestedNames ?? []);
  const mode = permissionMode(ctx, warnings);
  const model = modelOf(req, ctx, warnings);
  const key = stateKey(ctx, warnings);
  const prompt = promptOf(req, ctx, warnings);
  const withPrompt = prompt !== '' && !req.resumeId;

  const flags: string[] = ['--permission-mode', mode, '--model', model];
  if (req.sessionId) flags.push('--session-id', req.sessionId);
  if (req.resumeId) flags.push('--resume', req.resumeId);
  if (req.fork) flags.push('--fork-session');

  const sessionEnv: Record<string, string> = {};
  if (key) sessionEnv.PTYXIS_PROFILE = key;
  if (!req.noTask) sessionEnv.LOOM_TASK = req.task;

  // La riga in-tab nella grafia storica dello script: ogni flag seguito da uno
  // spazio, il prompt in coda fra apici. Il gate di parità su Linux confronta
  // questa riga byte per byte, spazio finale compreso quando il prompt manca.
  const envPrefix = Object.entries(sessionEnv)
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join('');
  const flagText = flags.map((f) => `${f} `).join('');
  const inTab =
    `${envPrefix}claude --name ${posixQuote(title)} ${flagText}` +
    (withPrompt ? posixQuote(prompt) : '');

  return {
    title,
    claudeArgs: ['--name', title, ...flags, ...(withPrompt ? [prompt] : [])],
    sessionEnv,
    inTab,
    warnings,
  };
}

/**
 * L'argv di Ptyxis: una tab nella finestra attiva (quella col focus, cioè il
 * deck), o una finestra nuova con `--new-window` (T162) per chi chiama da fuori
 * dalla finestra del progetto. Il comando gira dentro `bash -lc`, e le env di
 * sessione viaggiano DENTRO il comando: `ptyxis --tab` consegna la tab
 * all'istanza già aperta, che non eredita l'env di chi la chiede.
 */
export function ptyxisArgv(newWindow: boolean, workdir: string, title: string, inTab: string): string[] {
  return [newWindow ? '--new-window' : '--tab', '-d', workdir, '-T', title, '--', 'bash', '-lc', inTab];
}
