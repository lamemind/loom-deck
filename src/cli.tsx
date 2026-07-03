#!/usr/bin/env node
import { render, Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';

// Scaffold minimo (step ①). La lista è un placeholder: lo step ③ la popolerà
// leggendo il tasks.md del progetto, e ⏎ chiamerà scripts/deck-run <task>.
const PLACEHOLDER_TASKS = ['T18', 'T16', 'T12', 'T11'];

function Deck() {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState('');

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelected((i) => Math.min(PLACEHOLDER_TASKS.length - 1, i + 1));
    } else if (key.return) {
      // step ③: qui → spawn via scripts/deck-run <task>
      setNote(`⏎ spawn ${PLACEHOLDER_TASKS[selected]} (collegato allo step ③)`);
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">loom-deck</Text>
      <Text dimColor>deck · ↑↓ naviga · ⏎ spawn · q esci</Text>
      <Box flexDirection="column" marginTop={1}>
        {PLACEHOLDER_TASKS.map((task, i) => (
          <Text key={task} inverse={i === selected}>
            {i === selected ? '▶ ' : '  '}
            {task}
          </Text>
        ))}
      </Box>
      {note ? <Text color="green">{note}</Text> : null}
    </Box>
  );
}

render(<Deck />);
