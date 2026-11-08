// 129-9: the scene for the season -- a small pixel animation in the header.
// 129-10: in the always-on hours the scene stays up without a break.
// 129-11: on a phone in zuckermode the scene is a row above the list.
// 129-12: a date in no season shows the neutral scenes. 129-15: a visit holds
// one scene. 129-16: the neutral scene has its own windows. 129-18: the neutral
// scenes are ten scripts, and reduced motion holds the still frame of a script.
//
// One component serves every season and the dates between them. The registry
// says which season it is, or null for a date in no season. season/scene.ts
// holds five scenes for each season and ten neutral scenes, and it moves the
// scene. A neutral scene is a script of season/offseason.ts. The schedule in
// season/peek.ts sets the bounds of a visit, and season/visits.ts grants a
// visit under the caps in peek.ts. For a date in no season, it grants at most
// one visit in each of the windows in peek.ts.
// App.tsx mounts the component in one of two places. On a wide screen it sits
// in the header, between the brand and the status bar. The box .chalk-season
// takes the empty middle of the header. The canvas inside it is out of flow,
// so the header keeps its height when the scene comes and goes.
// On a phone in zuckermode, with the `row` prop, ZuckerList renders the
// component as the first child of the list screen. The row has no height
// between visits and opens to 48 px while a visit shows. The classic phone
// layout mounts no scene.
// The list screen unmounts when a conversation opens, so the component starts
// again, with a first pause, when the user comes back to the list. The logs of
// visits are in localStorage, so the daily caps and the neutral windows hold
// across that restart.
// The component draws on the canvas only during a visit and for FADE_MS after
// it. A hidden canvas costs no frame. In the always-on hours (ALWAYS_ON in
// season/seasons.ts) the component draws without a break, claims no visit, and
// the daily caps do not count those hours.
// A visit makes a new scene, and the scene holds one scene of the key from
// the start of the visit to its end. It does not rotate and does not fade
// between scenes. nextRow in season/visits.ts picks the scene, and it is never
// the scene of the last visit of the same key. The always-on hours start at a
// random scene and rotate through all five scenes of a season. A scene rotates to the next one
// every SCENE_SECONDS (see season/scene.ts).
// The canvas has the attribute data-scene. Its value is the name of the scene
// on show.
// The fade is CSS. The only timer for the schedule is one timeout for each
// step.
// If the system asks for reduced motion, a visit paints one frame and holds
// it, and the CSS fade is off. A script paints its still frame.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Season } from "../season/seasons";
import { firstPeek, nextPeek, type Peek } from "../season/peek";
import {
  createScene,
  drawScene,
  FPS,
  holdStill,
  resizeScene,
  SCALE,
  sceneCount,
  stepScene,
  type SceneKey,
} from "../season/scene";
import { nextRow, takeVisit } from "../season/visits";

// The time that the canvas takes to fade out. It must equal the opacity
// transition of .chalk-season-canvas in theme.css.
const FADE_MS = 1200;

/**
 * runScene paints a new scene for the key on the canvas and returns the
 * function that ends the visit. If always is false, the scene is the one that
 * nextRow picks, and it holds that scene. If always is true, the scene starts
 * at a random one of the scenes of the key and rotates. The key has five
 * scenes, or ten for "neutral".
 *
 * The scene has the size of the canvas in scene pixels. A resize of the canvas
 * resizes the scene and paints it again. Unless the system asks for reduced
 * motion, a requestAnimationFrame loop steps and paints the scene at FPS
 * frames each second. With reduced motion, the scene paints one frame and
 * holds it.
 *
 * The returned function stops the loop FADE_MS later, not at once. The canvas
 * fades out during that time. If the loop stopped first, the scene would
 * freeze in the picture while it fades.
 */
function runScene(
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  key: SceneKey,
  always: boolean,
): () => void {
  const size = (): [number, number] => [
    Math.max(1, Math.round(el.clientWidth / SCALE)),
    Math.max(1, Math.round(el.clientHeight / SCALE)),
  ];
  const [w, h] = size();
  el.width = w;
  el.height = h;
  ctx.imageSmoothingEnabled = false;
  // 129-15: a visit holds the row that nextRow picks. The always-on hours
  // start at a random row and rotate.
  const count = sceneCount(key);
  const index = always ? Math.floor(Math.random() * count) : nextRow(key, count);
  const scene = createScene(key, w, h, index, always);
  el.dataset.scene = scene.row.name;
  const paint = () => {
    ctx.clearRect(0, 0, el.width, el.height);
    drawScene(ctx, scene);
  };
  const fit = () => {
    const [nw, nh] = size();
    if (nw === el.width && nh === el.height) return;
    el.width = nw;
    el.height = nh;
    ctx.imageSmoothingEnabled = false;
    resizeScene(scene, nw, nh);
    paint();
  };
  let raf = 0;
  let last = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const elapsed = now - last;
    if (elapsed < 1000 / FPS) return;
    last = now;
    stepScene(scene, elapsed / 1000);
    if (el.dataset.scene !== scene.row.name) el.dataset.scene = scene.row.name;
    paint();
  };
  // 129-18: with reduced motion, holdStill moves a script to its still frame
  // before the one paint.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) holdStill(scene);
  paint();
  if (!reduced) raf = requestAnimationFrame(frame);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  observer?.observe(el);
  return () => {
    setTimeout(() => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    }, FADE_MS);
  };
}

interface Props {
  /** the season to show, or null for a date in no season: the neutral scenes then show */
  season: Season | null;
  /** true in the always-on hours: the scene stays up and no visit is claimed */
  always: boolean;
  /** true for the row above the zuckermode list: the box has no height between visits */
  row?: boolean;
}

/**
 * SeasonScene renders the canvas of the season, or of the neutral scenes if
 * `season` is null, and runs the schedule of visits. The scene key is the id of
 * the season, or "neutral". The label for a screen reader is the label of the
 * season, or "Chalk". The canvas is hidden between visits. It has a label for a screen
 * reader while a visit shows. If `always` is true, the canvas stays up without
 * a break and the schedule claims no visit.
 */
export function SeasonScene({ season, always, row = false }: Props) {
  const [visit, setVisit] = useState<Peek>(() => firstPeek());
  const canvas = useRef<HTMLCanvasElement>(null);
  const neutral = season === null;
  useEffect(() => {
    const t = setTimeout(() => {
      // In the always-on hours no visit is claimed, so the hours do not use up
      // the daily caps.
      const show =
        !always && !visit.visible && document.visibilityState === "visible" &&
        takeVisit(Date.now(), neutral);
      setVisit(nextPeek(show));
    }, visit.ms);
    return () => clearTimeout(t);
  }, [visit, always, neutral]);
  const key: SceneKey = season?.id ?? "neutral";
  const label = season?.label ?? "Chalk";
  // The canvas is up in a visit and in the always-on hours.
  const live = always || visit.visible;
  useEffect(() => {
    const el = canvas.current;
    const ctx = live ? el?.getContext("2d") : null;
    if (!el || !ctx) return;
    return runScene(el, ctx, key, always);
  }, [live, key, always]);
  return (
    <div
      class={
        "chalk-season" +
        (row ? " chalk-season--row" : "") +
        (live ? " chalk-season--live" : "")
      }
      data-testid="season-anchor"
    >
      <canvas
        ref={canvas}
        class={"chalk-season-canvas" + (live ? " chalk-season-canvas--visible" : "")}
        data-testid="season-scene"
        data-season={key}
        data-visible={live ? "" : undefined}
        role="img"
        aria-label={`${label}, an animated pixel scene`}
        aria-hidden={!live}
      />
    </div>
  );
}
