// Versione del pacchetto, letta dal `package.json` vero invece che cablata in
// un `const`: una costante duplicata dal manifest è un calco — al primo bump
// dimenticato il deck mostrerebbe con sicurezza un numero falso, ed è
// esattamente il caso in cui serve (capire quale build sto guardando).
//
// Il path relativo `../package.json` vale per entrambe le forme in cui questo
// modulo gira: `src/version.ts` sotto `tsx` e `dist/version.js` dopo il build —
// il manifest sta un livello sopra in tutti e due i casi.

import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '?';
  } catch {
    // Installazione monca o manifest illeggibile: la versione è cosmetica,
    // non vale far cadere il deck per averla persa.
    return '?';
  }
}

export const VERSION = readVersion();
