// T52 — semantica dell'estrazione dei corpi cercabili dal transcript.
// Fixture JSONL sintetiche: nessun accesso a ~/.claude, nessun file su disco.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, type Session } from '../src/sessions.js';

const PATH = '/p/aaaa-bbbb.jsonl';

/** Compone un transcript da record già oggetto. Ogni riga = un record. */
function transcript(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/** Record minimo valido: `cwd` serve o parseTranscript scarta l'intero file. */
const HEAD = { type: 'user', cwd: '/proj', gitBranch: 'main', message: { content: 'via' } };

function parse(records: unknown[]): Session {
  const s = parseTranscript(transcript([HEAD, ...records]), PATH, 1000, 42);
  assert.ok(s, 'transcript scartato: manca cwd?');
  return s;
}

const kindsOf = (s: Session, kind: string) => s.bodies.filter((b) => b.kind === kind);
const textsOf = (s: Session, kind: string) => kindsOf(s, kind).map((b) => b.text);

test('senza cwd il transcript non è una sessione di progetto', () => {
  const s = parseTranscript(transcript([{ type: 'user', message: { content: 'x' } }]), PATH, 1, 1);
  assert.equal(s, null);
});

test('content STRINGA: prompt umano nudo, corpo human', () => {
  const s = parse([{ type: 'user', message: { content: 'ricorda longest-label' } }]);
  assert.deepEqual(textsOf(s, 'human'), ['via', 'ricorda longest-label']);
});

test('content ARRAY: blocchi text di assistant → corpo ai', () => {
  const s = parse([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'la regola vince' }] } },
  ]);
  assert.deepEqual(textsOf(s, 'ai'), ['la regola vince']);
});

test('blocchi dello stesso kind nello stesso record sono UN corpo solo', () => {
  const s = parse([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'prima parte' },
          { type: 'text', text: 'seconda parte' },
        ],
      },
    },
  ]);
  const ai = kindsOf(s, 'ai');
  assert.equal(ai.length, 1, 'due blocchi text → un corpo concatenato');
  assert.equal(ai[0].text, 'prima parte\nseconda parte');
});

test('tool_use → corpo tool con nome e input serializzato', () => {
  const s = parse([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -rn foo' } }] },
    },
  ]);
  assert.deepEqual(textsOf(s, 'tool'), ['Bash {"command":"grep -rn foo"}']);
});

test('tool_result (type:user) → corpo tool, NON human', () => {
  const s = parse([
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'exit 0' }] } },
  ]);
  assert.deepEqual(textsOf(s, 'tool'), ['exit 0']);
  assert.deepEqual(textsOf(s, 'human'), ['via'], 'nessun human oltre al record di testa');
});

test('tool_result con content ad ARRAY di blocchi text', () => {
  const s = parse([
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: [{ type: 'text', text: 'riga uno' }, { type: 'text', text: 'riga due' }] },
        ],
      },
    },
  ]);
  assert.deepEqual(textsOf(s, 'tool'), ['riga uno\nriga due']);
});

test('thinking NON è indicizzato: il campo è sempre vuoto (persistita la sola signature)', () => {
  const s = parse([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '', signature: 'abc123' },
          { type: 'text', text: 'risposta' },
        ],
      },
    },
  ]);
  assert.deepEqual(s.bodies.map((b) => b.kind).filter((k) => k !== 'human'), ['ai']);
  assert.deepEqual(textsOf(s, 'ai'), ['risposta']);
});

test('[Request interrupted by user] non è un messaggio umano', () => {
  const s = parse([
    { type: 'user', message: { content: '[Request interrupted by user]' } },
    { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
    { type: 'user', message: { content: 'prompt vero' } },
  ]);
  assert.deepEqual(textsOf(s, 'human'), ['via', 'prompt vero']);
});

test("l'interruzione non conta nemmeno come turno né come primo prompt", () => {
  const s = parseTranscript(
    transcript([
      { type: 'user', cwd: '/proj', message: { content: '[Request interrupted by user]' } },
      { type: 'user', cwd: '/proj', message: { content: 'il vero primo prompt' } },
      { type: 'user', cwd: '/proj', message: { content: 'secondo' } },
    ]),
    PATH,
    1,
    1,
  );
  assert.ok(s);
  assert.equal(s.turns, 2);
  assert.equal(s.firstPrompt, 'il vero primo prompt');
});

test('idx = posizione del record fra i soli record VALIDI (righe rotte e vuote saltate)', () => {
  const raw = [
    JSON.stringify(HEAD), // idx 0
    '',
    '{ questo non è json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'due' }] } }), // idx 1
    JSON.stringify({ type: 'custom-title', customTitle: 'T' }), // idx 2 — conta, ma non ha corpi
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'quattro' }] } }), // idx 3
  ].join('\n');
  const s = parseTranscript(raw, PATH, 1, 1);
  assert.ok(s);
  assert.deepEqual(
    s.bodies.map((b) => [b.idx, b.kind, b.text]),
    [
      [0, 'human', 'via'],
      [1, 'ai', 'due'],
      [3, 'ai', 'quattro'],
    ],
  );
});

test('blocchi non testuali (image) e record senza message non producono corpi', () => {
  const s = parse([
    { type: 'user', message: { content: [{ type: 'image', source: {} }] } },
    { type: 'assistant' },
    { type: 'queue-operation', op: 'x' },
  ]);
  assert.deepEqual(s.bodies.map((b) => b.text), ['via']);
});

test('un record assistant misto produce DUE corpi, uno per kind', () => {
  const s = parse([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'ora eseguo' },
          { type: 'tool_use', name: 'Read', input: { file: 'a.ts' } },
        ],
      },
    },
  ]);
  const last = s.bodies.filter((b) => b.idx === 1);
  assert.deepEqual(last.map((b) => b.kind), ['ai', 'tool']);
});
