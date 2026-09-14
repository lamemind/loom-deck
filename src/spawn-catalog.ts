// Il CATALOGO delle azioni di spawn: per ogni cosa che il deck sa aprire, un id
// stabile e la terna titolo/modello/prompt con la sorgente di ciascun valore.
//
// Prima di questo modulo un'azione di spawn non era un'entità: era un tasto che
// chiamava una funzione, e ogni funzione decideva da sé — nel proprio punto di
// chiamata — quale modello e quale prompt passare. Il modello veniva da quattro
// sorgenti diverse (il catalogo `prompt-catalog` per kind, il transcript per
// resume e fork, un selettore vivo per la nuda, un letterale in `actions.ts` per
// drain e srotolamento) e non esisteva nessun posto in cui leggerne l'elenco.
// Senza quell'elenco non c'è nessuna tabella da mostrare, e nessuna riga che un
// override di progetto possa indirizzare.
//
// DATO PURO: nessuna lettura di file, nessun React, nessun import di
// `spawn.ts`. La dipendenza va in un verso solo (coding-standards: nessun modulo
// estratto importa il file da cui è stato estratto) — `spawn.ts`, `actions.ts`,
// `sheet.ts`, `glyphs.ts` e `prompt-catalog.ts` importano da qui.
//
// Chi COMPONE i default con gli override di progetto è `spawn-config.ts`: lì
// vivono la lettura del file, la validazione al confine e la risoluzione della
// terna. Qui ci sono solo i default del deck.

// T56 — quale prompt iniziale riceve una sessione aperta su una task. È un
// SIMBOLO: il testo vive nel catalogo dati `scripts/prompt-catalog`, che il deck
// condivide con `deck-run` (T117). Nomi identici ai valori di `--prompt-kind`.
export type PromptKind =
  | 'none'
  | 'recap'
  | 'recap-task'
  | 'recap-epic'
  | 'preflight'
  | 'run'
  | 'checkpoint';

/**
 * `recap` → la sotto-skill giusta, quando chi spawna SA se la task è un cappello.
 *
 * `recap` resta il kind onesto per chi non lo sa: punta al dispatcher, che
 * risolve la task e classifica da sé. È il caso degli acceleratori della lista,
 * dove il deck ha in mano solo `tasks.md` — e lì il `Size` non c'è. Il DETAIL
 * invece il task file l'ha già letto, quindi può saltare il giro e pagare un
 * turno di modello in meno.
 *
 * Non è una classificazione duplicata: il criterio (`Size: Epic`) resta uno solo
 * e sta in `taskIsEpic`, che legge lo stesso campo che leggerebbe il dispatcher.
 * Quello che si evita è il RITARDO, non il giudizio.
 *
 * T161 — la stessa funzione è anche il ponte dal detail al catalogo: gli id
 * delle sette azioni su task SONO i sette kind, quindi specializzare un kind
 * significa già scegliere la riga di catalogo (e l'override che la indirizza).
 *
 * Ogni kind diverso da `recap` passa intatto: la specializzazione è un caso, non
 * una trasformazione da applicare a tutti.
 */
export function specializeRecap(kind: PromptKind, epic: boolean): PromptKind {
  if (kind !== 'recap') return kind;
  return epic ? 'recap-epic' : 'recap-task';
}

// T108 — quale modello riceve la sessione appena aperta. Quarto asse di
// deck-run, indipendente dagli altri tre: vale su una sessione bound come su una
// nuda, su una nuova come su una ripresa.
//
// Le voci sono gli ALIAS del CLI e restano tali fino dentro `claude --model`:
// un id versionato (`claude-opus-5`) cablato qui diventerebbe falso al primo
// cambio di generazione, e fallirebbe come modello inesistente invece che come
// configurazione da aggiornare.
export type ModelKind = 'fable' | 'opus' | 'sonnet' | 'haiku';

// L'ordine È il giro di `tab` nel detail, non una preferenza di lettura:
// cambiarlo sposta le voci sotto le dita di chi le ha imparate. Fino a T111 era
// anche il binding delle cifre `1`-`4`, passate poi al campo nota.
export const MODELS: readonly ModelKind[] = ['fable', 'opus', 'sonnet', 'haiku'];

/** Il valore è uno dei quattro alias? Guardia del confine: la usano il parser
 *  del catalogo dati e quello del blocco `spawn` del file di progetto, che
 *  leggono entrambi testo scritto a mano. */
export function isModelKind(v: unknown): v is ModelKind {
  return typeof v === 'string' && (MODELS as readonly string[]).includes(v);
}

// Default del selettore e FALLBACK ultimo di ogni risoluzione. Duplicato del
// default di deck-run e non letto da lì: il deck deve poter MOSTRARE la
// selezione iniziale prima di spawnare alcunché, e un valore che si conosce solo
// a spawn avvenuto non è mostrabile.
//
// T161 — non è più il default di nessuna azione in particolare: ogni riga del
// catalogo porta il proprio (o lo prende dal catalogo dati), e qui si cade solo
// quando nessuna delle due sorgenti ha una voce.
export const MODEL_DEFAULT: ModelKind = 'fable';

// T152 — `recap-status-project` non è una chiave di `prompt-catalog` (le chiavi
// lì sono i valori di `--prompt-kind`, e lo spawn headless non ne passa mai
// uno): il suo default vive nella riga `project-status` di questo catalogo.
// Resta `opus` mentre i tre recap stanno su fable, ed è l'unico recap che gira
// in headless (`-p`), senza nessuno che ne legga l'esito mentre si forma e possa
// rilanciarlo — il testo prodotto è il deliverable, e viene riletto da disco
// anche giorni dopo.
export const PROJECT_STATUS_MODEL: ModelKind = 'opus';

// T66 — le azioni del detail. Non sono un catalogo a parte: ognuna nomina una
// riga di questo catalogo, per kind, e tutte passano dallo stesso `spawnForTask`
// dei CTRL della lista — una superficie in più, zero percorsi di spawn in più.
//
// L'etichetta è distinta dal kind dove il kind è il nome del MECCANISMO e
// l'etichetta quello dell'INTENZIONE: `none` è "aprire la task a mani nude",
// `recap` è "vedere a che punto sta".
export const DETAIL_ACTIONS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: 'none', label: 'open' },
  { kind: 'preflight', label: 'preflight' },
  { kind: 'run', label: 'run' },
  { kind: 'recap', label: 'status' },
  { kind: 'checkpoint', label: 'checkpoint' },
];

// T117 — selezione DIRETTA di un'azione con la sua iniziale (`o p r s c`),
// accanto allo scorrimento `←→`. Derivate dalle label e non cablate: una voce
// aggiunta al catalogo porta con sé la propria lettera, invece di lasciare
// indietro una seconda lista.
// Il vincolo che la derivazione impone al catalogo: le iniziali devono restare
// DISTINTE fra loro. Due label con la stessa lettera renderebbero la seconda
// irraggiungibile, e in silenzio — chi aggiunge una voce lo controlla qui.
export const ACTION_HOTKEYS: Readonly<Record<string, number>> = Object.fromEntries(
  DETAIL_ACTIONS.map((a, i) => [a.label[0]!, i]),
);

/**
 * L'id di un'azione di spawn — la chiave con cui un override di progetto la
 * indirizza, quindi un dato che viaggia su disco e non si rinomina a cuor
 * leggero.
 *
 * I sette kind SONO i sette id delle azioni su task: una seconda tabella
 * kind → id sarebbe una mappa da tenere allineata a mano, e `specializeRecap`
 * non potrebbe più fare da ponte fra il detail e il catalogo.
 */
export type SpawnActionId = PromptKind | 'bare' | 'drain' | 'unwrap' | 'project-status';

/** Le tre celle configurabili di una riga. */
export type SpawnField = 'title' | 'model' | 'prompt';

export const SPAWN_FIELDS: readonly SpawnField[] = ['title', 'model', 'prompt'];

export interface SpawnAction {
  id: SpawnActionId;
  /** Cosa apre, in una o due parole: la colonna «funzione» della pagina. */
  label: string;
  /** Da quale tasto o superficie parte. */
  surface: string;
  /**
   * La chiave con cui si legge `scripts/prompt-catalog`, o `null` per le azioni
   * che non hanno una riga lì (P2 preflight): il catalogo dati indicizza sui
   * valori di `--prompt-kind`, e drain, srotolamento, nuda e project status non
   * ne passano nessuno — una riga lì sarebbe irraggiungibile da ogni chiamante.
   */
  kind: PromptKind | null;
  /**
   * Template della NOTA del titolo, coi propri buchi. `null` = l'azione non
   * porta un titolo.
   *
   * È solo la nota: label del progetto, `· <TaskID>` e `· fork` li monta
   * `deck-run` e restano suoi (P9 preflight).
   */
  title: string | null;
  /** Modello cablato dell'azione. `null` = lo porta la riga di `kind` nel
   *  catalogo dati. */
  model: ModelKind | null;
  /**
   * Prompt cablato. `null` con un `kind` = lo porta il catalogo dati; `null`
   * senza `kind` = il testo lo compone il CHIAMANTE (il drain, dove la skill è
   * una funzione della natura del file); `''` = nessun prompt, che è un valore
   * e non un'assenza.
   */
  prompt: string | null;
  /** I buchi che titolo e prompt di questa azione sanno interpolare, senza
   *  graffe. Un template che ne nomina un altro resta letterale. */
  holes: readonly string[];
  /**
   * Le celle NON editabili, con la ragione per cui non lo sono — che la pagina
   * mostra al posto del valore.
   *
   * Il complemento (`editableFields`) è derivato e non scritto: due elenchi da
   * tenere allineati a mano divergono alla prima riga aggiunta, e la ragione è
   * l'unica delle due informazioni che non si deduce.
   */
  fixed: Readonly<Partial<Record<SpawnField, string>>>;
}

/**
 * Il prompt cablato della sessione che srotola l'hard-wrap di un path.
 *
 * Le tre cose che dice sono le tre che rendono l'operazione reversibile e
 * verificabile — backup fuori dal repo, rapporto, commit solo se il diff è
 * chiaramente innocuo. Era cablato in `wrap-scan.ts` e da T161 è il DEFAULT di
 * una riga del catalogo: resta la stessa frase, ma ora è sovrascrivibile dal
 * progetto invece che dal solo sorgente.
 *
 * Nessun apice singolo, come i template di `prompt-catalog`: il testo finisce
 * dentro `'…'` nel comando passato a `bash -lc`, e `deck-run` lo quota, ma un
 * apice qui sarebbe comunque una scrittura da rileggere due volte.
 */
const UNWRAP_PROMPT =
  'lancia md-wrap modo apply su {path} e backup in cartella tmp dedicata. ' +
  'verifica risultato e fai rapporto. se le modifiche sono tutte chiaramente safe, ' +
  'puoi committare direttamente';

/**
 * Le UNDICI azioni configurabili, nell'ordine in cui la pagina le elenca.
 *
 * Il perimetro è quello di D1: entra una riga se ha almeno una cella editabile.
 * Ne restano fuori resume e fork — lì il modello non è una preferenza ma
 * un'EREDITÀ, letta dal transcript della conversazione d'origine, e un override
 * sarebbe una cella che mente — insieme a `create-task` e `clean-tasks`, che non
 * passano `--model` e girano sul default del CLI (dargliene una sarebbe un
 * cambio di comportamento fatto per riempire una riga), al terminale e alle voci
 * `launch`, che non sono sessioni Claude e non hanno né modello né prompt.
 *
 * T156 — le emoji dei titoli sono ASTRALI (code point ≥ U+10000) per necessità,
 * non per gusto: `sanitize` (`src/width.ts`) sostituisce con `·` ogni glifo su
 * cui le due contabilità di larghezza divergono, e le emoji del BMP a
 * presentazione testo divergono sempre. Le stesse sei stanno nella whitelist di
 * `_sane_note` in `deck-run` e nel suo gemello `src/sane-note.ts`: un'emoji
 * cambiata qui e non là sparisce fra la tabella e la tab, senza errore.
 */
export const SPAWN_ACTIONS: readonly SpawnAction[] = [
  {
    id: 'none',
    label: 'apri la task',
    surface: 'detail o · ⏎⏎',
    kind: 'none',
    // D2 di T150 — nessun prefisso: `open` è "nessuna azione", e inventargliene
    // uno contraddirebbe l'intenzione di chi la sceglie.
    title: '{slug}',
    model: null,
    prompt: '',
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'recap',
    label: 'stato · dispatcher',
    surface: 'lista ^K',
    kind: 'recap',
    // P3 di T150 — le tre varianti di recap condividono il prefisso: la
    // specializzazione sceglie quale skill parte, non cosa si sta chiedendo.
    title: '📊 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'recap-task',
    label: 'stato task',
    surface: 'detail s',
    kind: 'recap-task',
    title: '📊 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'recap-epic',
    label: 'stato epica',
    surface: 'detail s · cappello',
    kind: 'recap-epic',
    title: '📊 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'preflight',
    label: 'preflight',
    surface: 'detail p · lista ^P',
    kind: 'preflight',
    title: '📐 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'run',
    label: 'run',
    surface: 'detail r · lista ^R',
    kind: 'run',
    title: '🚀 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    id: 'checkpoint',
    label: 'checkpoint',
    surface: 'detail c',
    kind: 'checkpoint',
    title: '🏁 {slug}',
    model: null,
    prompt: null,
    holes: ['TASK', 'slug'],
    fixed: {},
  },
  {
    // T42/T154 — la sessione a mani nude. Configurabile sul solo modello (P12):
    // non pinna un `sessionId` e non scrive nel sidecar, quindi un titolo
    // comparirebbe nella tab e non in lista — la divergenza che `bareArgs`
    // esiste per non avere — e un prompt la renderebbe non nuda.
    id: 'bare',
    label: 'sessione nuda',
    surface: 'tasto c',
    kind: null,
    title: null,
    model: MODEL_DEFAULT,
    prompt: '',
    holes: [],
    fixed: {
      title: 'nessun sessionId pinnato',
      prompt: 'la renderebbe non nuda',
    },
  },
  {
    // T134 — il drain di un file inbox. Il prompt lo compone `inboxPrompt`
    // (`src/inbox.ts`), che è l'unico posto in cui vive la mappa natura →
    // skill: un template unico non saprebbe esprimerla, e spezzare la riga in
    // una per natura contraddirebbe il perimetro di D1.
    id: 'drain',
    label: 'drain di un file inbox',
    surface: 'pane inbox ⏎⏎',
    kind: null,
    title: '🧹 {file}',
    model: MODEL_DEFAULT,
    prompt: null,
    holes: ['file'],
    fixed: { prompt: 'natura del file' },
  },
  {
    // T134 — lo srotolamento dell'hard-wrap. `sonnet` e non il default: è una
    // passata meccanica con un verificatore deterministico dietro (`md-wrap
    // --apply` confronta le due versioni normalizzate e rimette indietro il
    // file se differiscono), quindi il giudizio chiesto al modello è leggere un
    // diff e decidere se committarlo — non progettare niente.
    id: 'unwrap',
    label: 'srotolamento hard-wrap',
    surface: 'lista ^W ⏎',
    kind: null,
    title: '📏 {path}',
    model: 'sonnet',
    prompt: UNWRAP_PROMPT,
    holes: ['path'],
    fixed: {},
  },
  {
    // T121 — il recap di progetto, headless (`claude -p`): nessuna tab, quindi
    // nessun titolo da configurare.
    id: 'project-status',
    label: 'project status',
    surface: 'tasto ^G',
    kind: null,
    title: null,
    model: PROJECT_STATUS_MODEL,
    prompt: '/loom-works:recap-status-project',
    holes: [],
    fixed: { title: 'headless: nessuna tab' },
  },
];

/**
 * Valori d'esempio dei buchi, per l'ANTEPRIMA dell'area di compilazione.
 *
 * La cella della tabella mostra il template grezzo (`🚀 {slug}`), l'area mostra
 * come verrebbe reso: senza l'esempio un template si scrive alla cieca, e
 * l'effetto si scopre alla prima conversazione aperta.
 *
 * Sono valori FINTI e dichiarati tali dalla pagina, non la task selezionata: la
 * pagina non ha una selezione — si apre da qualunque punto del deck — e legare
 * l'anteprima a ciò che capita di avere sotto il caret la renderebbe diversa a
 * ogni apertura, per la stessa configurazione.
 */
export const EXAMPLE_HOLES: Readonly<Record<string, string>> = {
  TASK: 'T42',
  slug: 'esempio di task',
  file: 'T42-nozioni',
  path: 'runtime reference',
};

/**
 * I valori sono quelli che i FORNITORI dei buchi producono davvero, non testo
 * grezzo: lo slug arriva dal nome del task file coi trattini già sciolti in
 * spazi, il basename dell'inbox senza `.md`, il path già reso in parole. Un
 * esempio con dentro un `/` o un `.` mostrerebbe l'effetto della riduzione — le
 * parole saldate — su un caso che allo spawn non si presenta mai, e chi lo
 * legge correggerebbe un titolo che non è rotto.
 */

const BY_ID = new Map<string, SpawnAction>(SPAWN_ACTIONS.map((a) => [a.id, a]));

/** L'azione di un id, o `undefined` per un id che il catalogo non conosce — il
 *  caso di un override scritto a mano per un'azione che non esiste più. */
export function spawnAction(id: string): SpawnAction | undefined {
  return BY_ID.get(id);
}

/** L'id è nel catalogo? Guardia del parser degli override. */
export function isSpawnActionId(id: unknown): id is SpawnActionId {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Le celle editabili di una riga: il complemento di `fixed`, derivato e mai
 *  scritto a mano. */
export function editableFields(action: SpawnAction): readonly SpawnField[] {
  return SPAWN_FIELDS.filter((f) => !(f in action.fixed));
}

/**
 * Cosa mostra una cella della tabella.
 *
 * Il perimetro di D1 fa entrare righe che non sono commensurabili — la nuda non
 * ha un titolo, il project status gira headless, il prompt del drain è una
 * funzione della natura del file — quindi alcune celle non hanno un valore da
 * mostrare. La regola è che una cella senza valore **dice perché**, invece di
 * restare vuota: una cella muta si legge come un dato mancante, cioè come un
 * difetto, e manda a cercare un guasto che non c'è.
 *
 * `placeholder` distingue il testo che È il valore da quello che ne sta al
 * posto: la pagina lo rende smorzato, così la colonna resta leggibile come
 * elenco di valori anche quando metà delle sue celle sono spiegazioni.
 */
export interface SpawnCell {
  text: string;
  /** La cella si apre in compilazione. */
  editable: boolean;
  /** `fisso` = nessun valore da configurare; `override` = il progetto l'ha
   *  scritto; `default` = viene dal deck (o dal catalogo dati). */
  origin: 'override' | 'default' | 'fisso';
  /** Il testo sta al posto del valore, non è il valore. */
  placeholder: boolean;
}

/** Il segnaposto di una cella editabile ma a vuoto. Il vuoto è un valore
 *  legittimo e distinto dall'assenza (P15): un titolo svuotato significa
 *  «nessuna nota», un prompt svuotato «nessun prompt». */
const EMPTY_LABEL: Readonly<Record<SpawnField, string>> = {
  title: '(nessun titolo)',
  model: '(nessun modello)',
  prompt: '(nessun prompt)',
};

export function spawnCell(
  action: SpawnAction,
  field: SpawnField,
  /** Il valore risolto: `null` quando la cella non ne ha uno. */
  value: string | null,
  /** Il valore viene da un override di progetto. */
  overridden: boolean,
): SpawnCell {
  const reason = action.fixed[field];
  if (reason !== undefined) {
    return { text: `(${reason})`, editable: false, origin: 'fisso', placeholder: true };
  }
  const origin = overridden ? 'override' : 'default';
  if (value === null || value === '') {
    return { text: EMPTY_LABEL[field], editable: true, origin, placeholder: true };
  }
  return { text: value, editable: true, origin, placeholder: false };
}
