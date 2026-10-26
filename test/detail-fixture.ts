// T189 — progetto SINTETICO per il detail della task, condiviso dai due gate pty
// (`frame-width.test.ts` misura il frame, `modes-smoke.test.ts` l'argv dello
// spawn). Non è un file di test: il runner non lo esegue, lo importano.
//
// Perché sintetico. Gli scenari del detail sul cappello vero aprono la prima
// task della lista, e da T189 il MODO di apertura dipende da quella task:
// eseguibile con DLV aperti → lista DLV, altrimenti area di compilazione. Sui
// dati veri quella condizione cambia a ogni checkpoint, e uno scenario che batte
// `→` sui campi finirebbe a batterlo su una lista che lo ignora — verde, senza
// aver misurato niente. Qui la popolazione è del test.
//
// Ordine della lista (Pri ↓, poi id ↑): T1 è l'unico 🔥, quindi `DD` lo apre;
// `DDD`, `DDDD` e `DDDDD` aprono T2, T3 e T4.
//
//   T1  M, preflight fatto, 14 DLV (1, 3, 8 fatti) → si apre sulla lista DLV
//   T2  ✔️ in tasks.md, DLV tutti fatti            → campi; lista spenta
//   T3  Size L senza `### Preflight`               → lista DLV con l'avviso
//   T4  nessun `## Deliverables Checklist`          → campi; lista vuota
//
// Il blocco `spawn` sovrascrive modello e titolo di `run`: il modo DLV deve
// ereditarli (D3), ed è il caso che un default coincidente coprirebbe.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Il modello e il titolo che il blocco `spawn` della fixture dà a `run`. */
export const DETAIL_RUN_MODEL = 'sonnet';
export const DETAIL_RUN_TITLE = 'collaudo dlv';

/** `HOME` dirottato insieme alla cwd: la lista sessioni si legge da
 *  `~/.claude/projects/<hash della cwd>`, e non deve dipendere da chi lancia. */
export function detailProject(): { proj: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'deck-detail-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'runtime', 'tasks'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'loom'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(
    join(proj, '.claude', 'loom-works.json'),
    JSON.stringify({
      id: 'proj',
      emoji: '🧵',
      name: 'proj',
      spawn: { run: { model: DETAIL_RUN_MODEL, title: DETAIL_RUN_TITLE } },
    }),
  );
  const rows: Array<[string, string, string, string]> = [
    ['T1', '🔥', '🟢', 'eseguibile, più DLV dello spazio'],
    ['T2', '⚡', '✔️', 'chiusa'],
    ['T3', '⚡', '🔵', 'Size L senza preflight'],
    ['T4', '⚡', '🔵', 'senza deliverable'],
  ];
  writeFileSync(
    join(proj, 'runtime', 'tasks.md'),
    ['# Tasks', '', '## Tasks Overview', '', '| ID | Pri | Prog | Task |', '| --- | --- | --- | --- |']
      .concat(rows.map((r) => `| ${r.join(' | ')} |`))
      .join('\n') + '\n',
  );

  // Testo lungo davanti ai DLV: il box testo deve avere di che riempirsi a ogni
  // altezza, coi costrutti che il detail rende (grassetto, codice, glifi larghi).
  const body = Array.from(
    { length: 40 },
    (_, i) => `Riga ${i + 1} della **descrizione**, con \`codice\` e un glifo largo 🧵 nel testo della task.`,
  );
  const file = (id: string, size: string, dlvs: string[], decisions: string[]) =>
    [
      `# Task: ${id} del collaudo`,
      '',
      `- **ID**: ${id}`,
      `- **Size**: ${size}`,
      '',
      '## Description',
      '',
      ...body,
      '',
      ...(dlvs.length > 0 ? ['## Deliverables Checklist', '', ...dlvs, ''] : []),
      '## Decisions',
      '',
      ...decisions,
      '',
    ].join('\n');
  // Quattordici DLV: più di quanti la lista ne mostri a 38 righe (13), coi fatti
  // sparsi in mezzo — `↑↓` devono saltarli — e testi più larghi della riga a
  // ogni larghezza del gate, glifi larghi compresi.
  const many = Array.from({ length: 14 }, (_, i) => {
    const n = i + 1;
    const box = n === 1 || n === 3 || n === 8 ? '[x]' : '[ ]';
    return `- ${box} **DLV${n}** — voce di collaudo con \`codice\` e un 🧵 glifo largo, ${'testo lungo '.repeat(12)}`;
  });
  const preflight = ['### Preflight 2026-10-26 11:56', '', '- nessuna ambiguità'];
  const tasks = join(proj, 'runtime', 'tasks');
  writeFileSync(join(tasks, 'T1-eseguibile.md'), file('T1', 'M', many, preflight));
  writeFileSync(join(tasks, 'T2-chiusa.md'), file('T2', 'M', ['- [x] primo', '- [x] secondo'], preflight));
  writeFileSync(join(tasks, 'T3-size-l.md'), file('T3', 'L', ['- [ ] primo', '- [ ] secondo'], []));
  writeFileSync(join(tasks, 'T4-senza-dlv.md'), file('T4', 'M', [], preflight));
  return { proj, env: { HOME: join(root, 'home') } };
}
