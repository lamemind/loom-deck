// T161 — la PAGINA DELLE AZIONI DI SPAWN: ottava schermata sostitutiva.
//
// Una tabella di undici righe — una per azione che il deck sa aprire — con le
// quattro colonne funzione, titolo, modello, prompt. Le ultime tre si modificano
// e il salvataggio scrive il blocco `spawn` di `.claude/loom-works.json`.
//
// Due LIVELLI, non un edit dentro la cella (P14 preflight). Al primo si scorre
// la tabella; `⏎` apre sotto di essa l'area di compilazione della riga
// selezionata, che è la stessa forma già in esercizio nel detail della task —
// righe con un fuoco solo, `↑↓` fra le righe, `←→` sul valore o sul caret
// secondo il tipo (`fields.ts`). Un editor dentro la cella avrebbe voluto un
// caret che scorre dentro una colonna larga venti colonne, cioè una terza
// grammatica di input su una schermata che ne ha già due.
//
// La bozza vive IN MEMORIA fino a `w`. Comporre una configurazione non tocca il
// disco — stesso regime del salvataggio esplicito della vista (`w` sul deck) —
// e il file di progetto è committato: scriverci a ogni freccia produrrebbe un
// working tree sporco per una prova.
import { useState } from 'react';
import type { Key } from 'ink';
import { pageStep, spawnListCapacity } from '../viewport.js';
import { fieldsKey, type FieldSpec, type FieldsCursor, type FieldsIO } from '../fields.js';
import { cpLen } from '../layout.js';
import { saneTemplate } from '../sane-note.js';
import { configFilePath } from '../config.js';
import { cut } from '../width.js';
import {
  EXAMPLE_HOLES,
  MODELS,
  SPAWN_ACTIONS,
  editableFields,
  type ModelKind,
  type SpawnAction,
  type SpawnActionId,
  type SpawnField,
} from '../spawn-catalog.js';
import {
  rawSpawn,
  type SpawnOverride,
  type SpawnOverrides,
  type ResolvedSpawn,
} from '../spawn-config.js';
import type { CatalogEntry } from '../prompt-catalog.js';
import type { Mode } from '../model.js';

export interface SpawnPageDeps {
  /** Project root: serve alla nota del salvataggio, che nomina il file scritto. */
  cwd: string;
  rows: number;
  /** C'è una riga di stato da disegnare: la pagina è sostitutiva, quindi la
   *  paga dal proprio budget d'altezza. */
  hasNote: boolean;
  /** Gli override vivi del progetto, col loro saver (`useSpawnConfig`). */
  overrides: SpawnOverrides;
  save: (entries: SpawnOverrides) => void;
  /** Il catalogo dati dei prompt: è uno dei due gradini del default. */
  catalog: Map<string, CatalogEntry>;
  setMode: (m: Mode) => void;
  setNote: (s: string) => void;
}

/** Una riga della tabella, già risolta sulla BOZZA: quello che si vede è quello
 *  che `w` scriverebbe, non quello che il file dice adesso. */
export interface SpawnRow {
  action: SpawnAction;
  raw: ResolvedSpawn;
  /** Almeno una cella viene dalla bozza: la riga si marca (AC6). */
  touched: boolean;
}

/** Le tre righe dell'area di compilazione, nell'ordine in cui si leggono. Sono
 *  posizioni di SCHERMO e non indici del cursore: le righe non editabili si
 *  disegnano comunque (dicono perché non lo sono) ma il fuoco non ci passa. */
export const SROW: Readonly<Record<SpawnField, number>> = { title: 0, model: 1, prompt: 2 };

export function useSpawnPage(deps: SpawnPageDeps) {
  const { cwd, rows, hasNote, overrides, save, catalog, setMode, setNote } = deps;

  /** La bozza, `null` a pagina chiusa. Copia degli override all'apertura: una
   *  bozza che sopravvive alla chiusura sarebbe uno stato invisibile che `w`
   *  scriverebbe la volta dopo. */
  const [draft, setDraft] = useState<Map<SpawnActionId, SpawnOverride> | null>(null);
  const [sel, setSel] = useState(0);
  const [top, setTop] = useState(0);
  const [dirty, setDirty] = useState(false);
  /** L'area di compilazione è aperta sulla riga selezionata. */
  const [editing, setEditing] = useState(false);
  const [fieldTitle, setFieldTitle] = useState('');
  const [fieldModel, setFieldModel] = useState<ModelKind>(MODELS[0]!);
  const [fieldPrompt, setFieldPrompt] = useState('');
  const [cursor, setCursor] = useState<FieldsCursor>({ row: 0, caret: 0 });

  const capacity = spawnListCapacity(rows, editing, hasNote);
  const maxTop = Math.max(0, SPAWN_ACTIONS.length - capacity);

  const open = draft !== null;
  const action = SPAWN_ACTIONS[sel]!;
  const editable = editableFields(action);
  /** Le specifiche che `fields.ts` consuma: SOLO le celle editabili di questa
   *  riga, nell'ordine di schermo. Il cursore indicizza qui, non le tre righe
   *  disegnate — su `bare`, che ha il solo modello, `↑↓` non hanno dove andare e
   *  non devono finire su una riga che non si modifica. */
  const specs: FieldSpec[] = editable.map((f) =>
    f === 'model' ? { kind: 'choice', count: MODELS.length } : { kind: 'text' },
  );

  const table: SpawnRow[] = SPAWN_ACTIONS.map((a) => ({
    action: a,
    raw: rawSpawn(a, draft ?? overrides, catalog),
    touched: (draft ?? overrides).has(a.id),
  }));

  function openPage() {
    setDraft(new Map(overrides));
    setSel(0);
    setTop(0);
    setDirty(false);
    setEditing(false);
    setNote('');
    setMode('spawn');
  }

  function close() {
    setMode('normal');
    setDraft(null);
    setEditing(false);
  }

  function scroll(delta: number) {
    const next = Math.max(0, Math.min(SPAWN_ACTIONS.length - 1, sel + delta));
    setSel(next);
    // La finestra INSEGUE la selezione invece di centrarla: la tabella è di
    // undici righe e su un terminale normale ci sta intera, quindi centrare
    // farebbe saltare la lista sotto il caret per niente.
    setTop(Math.max(0, Math.min(next, Math.max(Math.min(top, maxTop), next - capacity + 1))));
  }

  /** Apre l'area sulla riga selezionata, coi valori GREZZI correnti. */
  function openFields() {
    const raw = rawSpawn(action, draft ?? overrides, catalog);
    const title = raw.title ?? '';
    const prompt = raw.prompt ?? '';
    setFieldTitle(title);
    setFieldModel(raw.model);
    setFieldPrompt(prompt);
    // Caret in coda al primo campo editabile, come `caretAtEnd`: è la posizione
    // da cui si continua a scrivere, e l'unica che non dipende da dove stava il
    // cursore l'ultima volta che l'area era aperta.
    const first = editable[0]!;
    setCursor({ row: 0, caret: first === 'model' ? 0 : cpLen(first === 'title' ? title : prompt) });
    setEditing(true);
  }

  /**
   * Congela l'area nella bozza, tenendo solo ciò che DIFFERISCE dal default.
   *
   * È ciò che rende reversibile una modifica senza un gesto apposta: un valore
   * riportato a mano a quello di partenza smette di essere un override, invece
   * di restare nel file come una riga che non cambia niente (AC7). Il gesto
   * apposta — `CANC` — resta per togliere tutte e tre le celle in un colpo.
   */
  function commitFields() {
    const base = rawSpawn(action, new Map(), catalog);
    const next: SpawnOverride = {};
    for (const f of editable) {
      if (f === 'model') {
        if (fieldModel !== base.model) next.model = fieldModel;
      } else if (f === 'title') {
        // P10 — la riduzione al confine: quello che entra nella bozza è quello
        // che comparirà nella tab, coi buchi preservati. Farla solo al
        // salvataggio mostrerebbe per tutta la sessione un titolo che la tab non
        // porterà mai.
        const title = saneTemplate(fieldTitle);
        if (title !== (base.title ?? '')) next.title = title;
      } else if (fieldPrompt !== (base.prompt ?? '')) {
        next.prompt = fieldPrompt;
      }
    }
    setDraft((d) => {
      const m = new Map(d ?? overrides);
      if (Object.keys(next).length > 0) m.set(action.id, next);
      else m.delete(action.id);
      return m;
    });
    setDirty(true);
    setEditing(false);
  }

  /** `CANC` sulla riga: via l'override, la riga torna al default. */
  function clearRow() {
    if (!(draft ?? overrides).has(action.id)) {
      setNote(`CANC → ${action.id}: nessun override da togliere`);
      return;
    }
    setDraft((d) => {
      const m = new Map(d ?? overrides);
      m.delete(action.id);
      return m;
    });
    setDirty(true);
    setNote(`CANC → ${action.id}: override rimosso, torna al default`);
  }

  function write() {
    const entries = draft ?? overrides;
    try {
      save(entries);
    } catch (e) {
      // Il file non è del deck: se non si parsa il saver rifiuta invece di
      // rigenerarlo, e qui si dice perché. La bozza resta viva — chi ripara il
      // file a mano può ripremere `w` senza rifare le modifiche.
      setNote(`⚠ ${cut((e as Error).message, 70)}`);
      return;
    }
    setDirty(false);
    const n = entries.size;
    setNote(
      `w → ${n === 0 ? 'nessun override' : `${n} azione${n > 1 ? 'i' : ''} configurate`} · ${configFilePath(cwd)}`,
    );
  }

  const fieldsIO: FieldsIO = {
    text: (row) => (editable[row] === 'title' ? fieldTitle : fieldPrompt),
    setText: (row, next) =>
      editable[row] === 'title' ? setFieldTitle(next) : setFieldPrompt(next),
    choice: () => Math.max(0, MODELS.indexOf(fieldModel)),
    setChoice: (_row, index) => setFieldModel(MODELS[index]!),
  };

  function onFieldsKey(input: string, key: Key) {
    if (key.escape) {
      setEditing(false);
      return;
    }
    if (key.return) {
      commitFields();
      return;
    }
    fieldsKey(input, key, specs, cursor, setCursor, fieldsIO);
  }

  function onKey(input: string, key: Key) {
    if (!open) return;
    if (editing) {
      onFieldsKey(input, key);
      return;
    }
    if (key.escape) {
      // Una bozza non salvata si perde: dirlo è l'unico modo di non perderla per
      // sbaglio, e un modale di conferma su una pagina di configurazione
      // costerebbe una domanda a ogni uscita.
      if (dirty) setNote('modifiche non salvate perse · w salva prima di uscire');
      close();
      return;
    }
    if (key.return) {
      openFields();
      return;
    }
    if (key.delete) {
      clearRow();
      return;
    }
    if (key.upArrow) scroll(-1);
    else if (key.downArrow) scroll(1);
    else if (key.pageUp) scroll(-pageStep(capacity));
    else if (key.pageDown) scroll(pageStep(capacity));
    else if (input === 'w' && !key.ctrl) write();
  }

  return {
    open,
    table,
    sel,
    top,
    capacity,
    maxTop,
    dirty,
    editing,
    editable,
    fieldTitle,
    fieldModel,
    fieldPrompt,
    cursor,
    /** L'anteprima resa della riga aperta: i buchi riempiti coi valori finti. */
    example: EXAMPLE_HOLES,
    openPage,
    onKey,
  };
}
