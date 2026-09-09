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
  bumpGitlink,
  disalignedCount,
  gitlinkNote,
  GITLINK_SCAN_INTERVAL_MS,
  hasGitmodules,
  scanGitlink,
  type GitlinkMember,
} from '../gitlink.js';

export interface GitlinkDeps {
  /** Project root: la radice su cui gira `git submodule status`. */
  cwd: string;
  setNote: (s: string) => void;
}

export function useGitlink(deps: GitlinkDeps) {
  const { cwd, setNote } = deps;

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
  const [bumping, setBumping] = useState(false);
  /** L'ultimo bump si è fermato prima di committare. STICKY: un giro di misura
   *  riuscito non lo azzera — dice com'è andata l'ultima AZIONE, che è un fatto
   *  diverso da com'è andata l'ultima misura, e i due restano entrambi veri.
   *  Stessa regola del `failed` del project status. */
  const [failed, setFailed] = useState(false);

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

  const count = disalignedCount(members);
  const bumpable = bumpableCount(members);

  /**
   * Il bump vero — l'unica azione del sensore.
   *
   * NESSUNA CONFERMA (P6 preflight): il commit è locale e si annulla con un
   * `git reset` che non tocca nessun remote, e lo script non pusha il cappello.
   * È la stessa forma di `^G`, che genera senza chiedere.
   *
   * I quattro rifiuti dicono SEMPRE perché (AC: il tasto su zero disallineati
   * non spawna niente e lo dice). Un tasto che non facesse niente in silenzio
   * sarebbe indistinguibile da un binding mancante.
   */
  function bump() {
    if (!enabled) {
      setNote('^U → questo progetto non ha submodule: nessun gitlink da bumpare');
      return;
    }
    if (busy.current || bumping) {
      setNote('^U → bump del gitlink già in corso');
      return;
    }
    if (!scanned) {
      setNote('^U → gitlink non ancora misurato');
      return;
    }
    if (bumpable === 0) {
      const why = gitlinkNote(members);
      setNote(
        count === 0
          ? '^U → gitlink già allineato: niente da bumpare'
          : `^U → nessun membro bumpabile · ${why}`,
      );
      return;
    }
    busy.current = true;
    setBumping(true);
    setNote(`⏳ bump del gitlink su ${bumpable} membro${bumpable > 1 ? 'i' : ''}…`);
    bumpGitlink(cwd).then((res) => {
      busy.current = false;
      if (!alive.current) return;
      setBumping(false);
      setOk(res.ok);
      setScanned(true);
      setFailed(!res.ok);
      if (res.members.length > 0) setMembers(res.members);
      const note = gitlinkNote(res.members);
      setNote(note || (res.ok ? '✔ gitlink: nessun membro bumpato' : '⚠ bump del gitlink fallito'));
      // Rimisura: l'output del bump porta già gli stati nuovi, ma il giro
      // successivo li conferma da `git submodule status` invece che dalla
      // memoria di ciò che si è appena fatto — ed è ciò che fa scendere il
      // contatore senza riavviare il deck anche quando il commit ha toccato più
      // di quanto lo script credeva.
      refresh();
    });
  }

  return {
    enabled,
    members,
    ok,
    scanned,
    bumping,
    failed,
    count,
    bumpable,
    attention: attentionCount(members),
    bump,
    refresh,
  };
}
