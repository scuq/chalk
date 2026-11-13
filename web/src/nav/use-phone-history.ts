// 135-3: connects the layers of the phone to the browser history.
// phone-stack.ts describes the model. The code does not use the Navigation
// API, by design.

import { useEffect, useRef } from "preact/hooks";
import { hasDepth, historyDepth, popSteps, reconcile, stackDepth, type PhoneLayers, type PopStep } from "./phone-stack";

/** usePhoneHistory keeps the history entries and the open layers equal
 * while enabled is true. When the app opens a layer, it pushes entries with
 * the same URL. When the app closes a layer, it calls history.go. After a
 * browser back, it calls onPop with the steps that close the layers. An
 * entry without a depth gets chalkDepth 1. */
export function usePhoneHistory(enabled: boolean, layers: PhoneLayers, onPop: (steps: PopStep[]) => void): void {
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  // True from our own history.go() until its popstate arrives. In that
  // time the history depth is about to change. A push or a second go()
  // would use the old depth.
  const pending = useRef(false);
  const depth = stackDepth(layers);

  const sync = () => {
    if (pending.current) return;
    if (!hasDepth(history.state)) {
      history.replaceState({ ...(history.state ?? {}), chalkDepth: 1 }, "", location.href);
    }
    const cur = historyDepth(history.state);
    const r = reconcile(stackDepth(layersRef.current), cur);
    if (!r) return;
    if ("push" in r) {
      for (let k = cur + 1; k <= cur + r.push; k++) history.pushState({ chalkDepth: k }, "", location.href);
    } else {
      pending.current = true;
      history.go(r.go);
    }
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (enabled) sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, depth]);

  useEffect(() => {
    if (!enabled) return;
    const onPopState = () => {
      if (pending.current) {
        pending.current = false;
        syncRef.current();
        return;
      }
      const landed = historyDepth(history.state);
      const want = stackDepth(layersRef.current);
      if (landed < want) onPopRef.current(popSteps(layersRef.current, landed));
      else if (landed > want) {
        pending.current = true;
        history.go(want - landed);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      pending.current = false;
    };
  }, [enabled]);
}
