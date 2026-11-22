// La resa di un header di pane già tagliato: ogni parte col suo stile, l'attiva
// in video inverso.
//
// Sta in un file proprio e non in `ui/panes.tsx`: i pane importano questo,
// questo non importa nessuno di loro, e la dipendenza resta in un verso solo.
//
// Il video inverso e non un colore (T100/D5): costa 0 colonne e non entra in
// gara con la semantica di colore già occupata dalle voci del catalogo.
import { Text } from 'ink';
import type { HeaderPart } from '../pane-header.js';

export function HeaderLine({
  parts,
  shown,
  focused,
}: {
  parts: HeaderPart[];
  /** Testo di ogni parte DOPO il taglio al budget: `''` = parte caduta. Il
   *  taglio lo fa `pane-header.ts`, non questo componente — è il taglio a
   *  decidere quali parti esistono a schermo, e una parte caduta non deve
   *  rispondere a un click. */
  shown: string[];
  focused: boolean;
}) {
  return (
    <Text bold color={focused ? 'cyan' : undefined} wrap="truncate-end">
      {parts.map((seg, i) =>
        shown[i] ? (
          <Text key={i} color={seg.color} dimColor={seg.dim} inverse={seg.active}>
            {shown[i]}
          </Text>
        ) : null,
      )}
    </Text>
  );
}
