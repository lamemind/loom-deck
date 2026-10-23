// T175 — COME il deck lancia `claude`, senza shell, su ogni installazione.
//
// Su Linux `claude` è un eseguibile nel `PATH` e basta il nome. Su Windows le
// installazioni sono due e si comportano in modo opposto davanti a `spawn`:
//
//  - l'installer nativo dà `claude.exe`, e `spawn('claude')` lo trova — libuv
//    prova da sé `.com` ed `.exe`;
//  - l'installazione npm dà uno shim `claude.cmd`, e `spawn` non lo trova
//    (`ENOENT` col nome nudo) né lo lancia (`EINVAL` col nome intero: Node ≥
//    18.20.2 rifiuta un `.cmd` senza shell).
//
// La shell non è un rimedio: con `shell: true` il prompt passerebbe da cmd.exe,
// che interpreta `& | % ^`, e un prompt è testo arbitrario. Lo shim invece è un
// file generato da cmd-shim con una forma fissa, e dice in chiaro cosa lancia:
// il deck lo legge e lancia il bersaglio da sé (P5 preflight).
//
// Modulo PURO nel cuore (`resolveClaude` riceve il filesystem come funzioni),
// con un involucro che legge quello vero.
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

/** Il comando e gli argomenti che precedono quelli di `claude`. */
export interface ClaudeLauncher {
  cmd: string;
  prefix: string[];
}

/**
 * Il bersaglio di uno shim di cmd-shim, o `null` se il testo non ne ha uno che
 * il deck sappia lanciare.
 *
 * Il bersaglio è l'ultimo `"%dp0%\<path>"` seguito da `%*` (le due forme dello
 * shim: `%dp0%` dalla v4 di cmd-shim, `%~dp0` prima). Un `.js` parte col node
 * del deck — è il node che lo shim userebbe in assenza di un `node.exe`
 * accanto, cioè quello del `PATH` —, un `.exe` parte da sé. Ogni altro bersaglio
 * (uno script sh, per esempio) vorrebbe il suo interprete, e il deck non lo
 * indovina.
 */
export function parseCmdShim(text: string, shimPath: string, nodePath: string): ClaudeLauncher | null {
  const re = /"%~?dp0%?\\?([^"]+)"\s+%\*/g;
  let rel: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) rel = m[1]!;
  if (!rel) return null;
  const target = win32.join(win32.dirname(shimPath), rel);
  if (/\.(c|m)?js$/i.test(target)) return { cmd: nodePath, prefix: [target] };
  if (/\.(exe|com)$/i.test(target)) return { cmd: target, prefix: [] };
  return null;
}

export interface ClaudeFs {
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

/**
 * La cascata (P5 preflight): `LOOM_DECK_CLAUDE_CMD` → `claude` così com'è →
 * shim `claude.cmd` nel `PATH`.
 *
 * Su win32 «così com'è» vuol dire che un `claude.exe` o `claude.com` sta nel
 * `PATH`: è lo stesso giro che farebbe libuv, fatto prima per sapere se serve
 * il gradino dopo. Un override che nomina un `.cmd` passa dallo stesso parser,
 * o cadrebbe nell'`EINVAL`. Niente trovato → `claude` nudo: lo spawn fallirà,
 * e l'errore dirà «`claude` non lanciabile», che è il fatto.
 */
export function resolveClaude(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  nodePath: string,
  fs: ClaudeFs,
): ClaudeLauncher {
  const fromShim = (shim: string) => {
    try {
      return parseCmdShim(fs.read(shim), shim, nodePath);
    } catch {
      return null;
    }
  };
  const override = env.LOOM_DECK_CLAUDE_CMD;
  if (override) {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(override)) {
      return fromShim(override) ?? { cmd: override, prefix: [] };
    }
    return { cmd: override, prefix: [] };
  }
  const bare: ClaudeLauncher = { cmd: 'claude', prefix: [] };
  if (platform !== 'win32') return bare;
  const dirs = (env.PATH ?? env.Path ?? '').split(win32.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (fs.exists(win32.join(dir, 'claude.com')) || fs.exists(win32.join(dir, 'claude.exe'))) return bare;
  }
  for (const dir of dirs) {
    const shim = win32.join(dir, 'claude.cmd');
    if (!fs.exists(shim)) continue;
    const launcher = fromShim(shim);
    if (launcher) return launcher;
  }
  return bare;
}

let cached: ClaudeLauncher | undefined;

/** Il `claude` di questa macchina, risolto alla prima richiesta e tenuto per la
 *  vita del deck. */
export function claudeLauncher(): ClaudeLauncher {
  if (!cached) {
    cached = resolveClaude(process.env, process.platform, process.execPath, {
      exists: existsSync,
      read: (p) => readFileSync(p, 'utf8'),
    });
  }
  return cached;
}
