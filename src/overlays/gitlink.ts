// T155 — il sensore del gitlink: stato, gate di attivazione, cadenza.
//
// Non è un overlay come `sheet` o `search` — non apre nessuna schermata e non
// entra in `MODE_KEYS`. Sta qui per la stessa ragione di `useProjectStatus` e
// `useWrapOverlay`: tiene uno stato che si legge in vista normale e possiede
// l'azione che quello stato abilita, e `hooks.ts` è già a 487 righe (P3
// preflight, D1/P12 — nessuno split dentro questa task).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  attentionCount,
  bumpableCount,
  disalignedCount,
  GITLINK_SCAN_INTERVAL_MS,
  hasGitmodules,
  scanGitlink,
  type GitlinkMember,
} from '../gitlink.js';

export interface GitlinkDeps {
  /** Project root: la radice su cui gira `git submodule status`. */
  cwd: string;
}

export function useGitlink(deps: GitlinkDeps) {
  const { cwd } = deps;

  /**
   * IL GATE. Senza `.gitmodules` il progetto non ha submodule, quindi non c'è
   * niente da misurare: nessun timer parte, nessuno spawn viene fatto, e
   * l'indicatore non compare affatto — non «0», che occuperebbe colonne della
   * riga legenda per dire che la funzione non si applica.
   *
   * Misurato UNA VOLTA per project root e non a ogni giro: un repo non guadagna
   * submodule mentre il deck è aperto, e se lo facesse basta riavviarlo. È lo
   * stesso limite accettato dalla cache del plugin (`plugin-cache.ts`), scritto
   * qui invece che scoperto dopo.
   */
  const enabled = useMemo(() => hasGitmodules(cwd), [cwd]);

  const [members, setMembers] = useState<GitlinkMember[]>([]);
  const [ok, setOk] = useState(true);
  /** Almeno un tentativo è stato fatto: distingue «non ho ancora misurato» da
   *  «ho misurato e sono tutti allineati», che a schermo sono due cose diverse. */
  const [scanned, setScanned] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // Il flag di corsa sta in un ref e non in stato, come in `useInboxScan`: due
  // richieste ravvicinate girano nello stesso tick di React, e un valore di
  // stato arriverebbe al render dopo — cioè troppo tardi per impedire il
  // secondo spawn.
  const busy = useRef(false);
  // `alive` vive fuori dall'effect perché la richiesta forzata sopravvive al
  // giro che l'ha ospitata: la scatena un gesto, non l'effect.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    scanGitlink(cwd).then((res) => {
      busy.current = false;
      if (!alive.current) return;
      // Un tentativo fallito NON butta via l'esito dell'ultimo riuscito: le
      // righe precedenti restano vere, e il guasto si dice col glifo di allerta
      // accanto al numero. Stessa regola del project status e della coda inbox.
      setOk(res.ok);
      setScanned(true);
      if (res.ok || res.members.length > 0) setMembers(res.members);
    });
  }, [cwd]);

  useEffect(() => {
    if (!enabled) return;
    run();
    const id = setInterval(run, GITLINK_SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, run, epoch]);

  /**
   * Rimisura adesso e riparte col timer da zero.
   *
   * Il reset non è cosmetico: senza, l'intervallo continuerebbe a scorrere
   * dall'ultimo tick automatico e potrebbe rimisurare pochi istanti dopo un
   * dato appena misurato — costo pieno, risultato identico. Stessa forma di
   * `useWrapScan` e `useInboxScan`.
   */
  const refresh = useCallback(() => {
    setEpoch((e) => e + 1);
  }, []);

  return {
    enabled,
    members,
    ok,
    scanned,
    count: disalignedCount(members),
    bumpable: bumpableCount(members),
    attention: attentionCount(members),
    refresh,
  };
}
