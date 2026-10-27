import type { LayoutConfig, Scene } from "./layout";
import { genePoints, ribbonPath } from "./geometry";
import { labelScreenRect, placeGeneLabels } from "./labels";

export interface View {
  dpr: number;
  cssW: number;
  cssH: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** A similarity link spotlit from the inspector. Its endpoints' similarity groups
 * (`genes`) and the ribbons among them stay vivid while the rest of the figure
 * fades; the hovered partner (`focus`) gets a red outline and the inspected gene
 * (`origin`) a black one. Canvas only — never part of the exported figure. */
export interface Highlight {
  link: string;
  genes: Set<string>;
  focus: string;
  origin: string;
}

const HIGHLIGHT_FOCUS = "#dc2626"; // --danger
const HIGHLIGHT_ORIGIN = "#000000";
const HIGHLIGHT_FADE = 0.3;

export function draw(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  cfg: LayoutConfig,
  geneLabelEligible: Set<string> | null = null,
  highlight: Highlight | null = null,
): void {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.cssW, view.cssH);
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, view.cssW, view.cssH);

  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);

  for (const l of scene.links) {
    if (highlight?.link === l.link.uid) continue;
    const inGroup = !highlight || (highlight.genes.has(l.link.query) && highlight.genes.has(l.link.target));
    ctx.globalAlpha = inGroup ? l.alpha : l.alpha * HIGHLIGHT_FADE;
    ctx.fillStyle = l.colour;
    ctx.fill(new Path2D(ribbonPath(l, cfg.straight)));
  }
  // The spotlit ribbon goes over the faded ones, at a floor opacity so even a weak
  // match reads clearly. Only adjacent rows carry ribbons, so it may not exist.
  const lit = highlight ? scene.links.find((l) => l.link.uid === highlight.link) : undefined;
  if (lit) {
    const path = new Path2D(ribbonPath(lit, cfg.straight));
    ctx.globalAlpha = Math.max(lit.alpha, 0.6);
    ctx.fillStyle = lit.colour;
    ctx.fill(path);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = HIGHLIGHT_FOCUS;
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;

  ctx.globalAlpha = cfg.backboneOpacity;
  ctx.lineWidth = cfg.backboneWidth / view.zoom;
  ctx.strokeStyle = cfg.backboneColour;
  for (const lo of scene.loci) {
    ctx.beginPath();
    ctx.moveTo(lo.x0, lo.y);
    ctx.lineTo(lo.x1, lo.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tracePath = (g: Scene["genes"][number]) => {
    const pts = genePoints(g, cfg.trackHeight, cfg.geneShape, cfg.tipLength);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  ctx.strokeStyle = cfg.geneStroke;
  ctx.lineWidth = cfg.geneStrokeWidth / view.zoom;
  for (const g of scene.genes) {
    tracePath(g);
    ctx.globalAlpha = highlight && !highlight.genes.has(g.uid) ? HIGHLIGHT_FADE : 1;
    ctx.fillStyle = g.colour;
    ctx.fill();
    if (cfg.geneStrokeWidth > 0) ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The link's two genes get a background-coloured halo under a coloured outline, so
  // they stand out against any fill colour: red for the hovered partner, black for
  // the inspected gene. Stroke widths are screen px (÷ zoom) so the outline stays
  // visible even when the figure is zoomed far out; refilling after stroking keeps
  // only the outer half of each stroke, i.e. a 2px ring.
  if (highlight) {
    ctx.save();
    ctx.lineJoin = "round";
    for (const g of scene.genes) {
      if (g.uid !== highlight.focus && g.uid !== highlight.origin) continue;
      tracePath(g);
      ctx.strokeStyle = cfg.background;
      ctx.lineWidth = 7 / view.zoom;
      ctx.stroke();
      ctx.strokeStyle = g.uid === highlight.focus ? HIGHLIGHT_FOCUS : HIGHLIGHT_ORIGIN;
      ctx.lineWidth = 4 / view.zoom;
      ctx.stroke();
      ctx.fillStyle = g.colour;
      ctx.fill();
    }
    ctx.restore();
  }

  if (cfg.showLinkLabels) {
    const fontSize = 10 / view.zoom;
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 / view.zoom;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    for (const l of scene.links) {
      if (!l.label) continue;
      ctx.strokeText(l.label, l.mx, l.my);
    }
    ctx.fillStyle = "#202124";
    for (const l of scene.links) {
      if (!l.label) continue;
      ctx.fillText(l.label, l.mx, l.my);
    }
  }

  if (scene.scaleBar) {
    const sb = scene.scaleBar;
    // World-space stroke + font (not divided by zoom) so the bar, ticks and label
    // scale together with the figure and stay put relative to each other at any
    // zoom, matching the SVG export.
    ctx.strokeStyle = "#202124";
    ctx.fillStyle = "#202124";
    ctx.lineWidth = sb.strokeWidth;
    ctx.beginPath();
    ctx.moveTo(sb.x0, sb.y);
    ctx.lineTo(sb.x1, sb.y);
    ctx.moveTo(sb.x0, sb.y - sb.tick);
    ctx.lineTo(sb.x0, sb.y + sb.tick);
    ctx.moveTo(sb.x1, sb.y - sb.tick);
    ctx.lineTo(sb.x1, sb.y + sb.tick);
    ctx.stroke();
    ctx.font = `600 ${sb.fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(sb.label, sb.labelX, sb.labelY);
  }

  if (scene.legend) {
    const leg = scene.legend;
    // World-space font (not divided by zoom): the swatches and entry positions
    // live in world coordinates, so the text must scale with them or it desyncs
    // from its layout slot and overlaps neighbours when zoomed out. This also
    // matches the SVG export, which draws the legend at world font-size.
    ctx.font = `${leg.fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const e of leg.entries) {
      ctx.fillStyle = e.colour;
      ctx.fillRect(e.x, e.y, e.size, e.size);
      ctx.strokeStyle = "#33383f";
      ctx.lineWidth = 0.7 / view.zoom;
      ctx.strokeRect(e.x, e.y, e.size, e.size);
      ctx.fillStyle = "#202124";
      ctx.fillText(e.label, e.textX, e.textY);
    }
  }

  ctx.restore();

  // Cluster names draw last, in screen space. They render at a constant size at any
  // zoom, and when pinned they must stay put while the figure pans beneath them —
  // both of which fall out naturally once we're outside the world transform.
  // labelScreenRect is the same placement CanvasView uses for hit-testing, the drag
  // handle and the rename editor, so they can never disagree.
  if (cfg.showClusterNames) {
    ctx.font = `600 ${cfg.clusterFontSize}px system-ui, sans-serif`;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = cfg.background;
    for (const lab of scene.labels) {
      const r = labelScreenRect(lab, cfg, view);
      ctx.textAlign = r.align;
      ctx.textBaseline = r.middle ? "middle" : "alphabetic";
      // A pinned name overlays the figure when panned under it; a background-coloured
      // halo keeps it legible without a heavy backdrop.
      if (cfg.clusterLabelPinned) ctx.strokeText(lab.name, r.x, r.y);
      ctx.fillStyle = "#202124";
      ctx.fillText(lab.name, r.x, r.y);
    }
  }

  // CDS labels: adaptive, screen-space (constant size, placed against the live zoom
  // so they reveal on zoom-in). Labels off the arrow get a background halo to stay
  // legible over ribbons; ones on it contrast-pick their ink against the gene fill.
  if (cfg.showGeneLabels !== "never") {
    const placements = placeGeneLabels(
      scene.genes,
      { zoom: view.zoom, panX: view.panX, panY: view.panY, cssW: view.cssW },
      {
        mode: cfg.showGeneLabels,
        fontSize: cfg.geneLabelFontSize,
        trackHeight: cfg.trackHeight,
        position: cfg.geneLabelPosition,
        rotationDeg: cfg.geneLabelRotation,
        geneShape: cfg.geneShape,
        tipLength: cfg.tipLength,
        eligible: geneLabelEligible,
      },
    );
    if (placements.length) {
      ctx.font = `500 ${cfg.geneLabelFontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle"; // placement.y is the label's vertical centre
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      // Canvas +angle is clockwise (y-down); negate so a positive rotation reads
      // upward-to-the-right, matching the SVG export.
      const rad = -(cfg.geneLabelRotation * Math.PI) / 180;
      ctx.strokeStyle = cfg.background;
      if (rad === 0) {
        for (const p of placements) if (p.halo) ctx.strokeText(p.text, p.x, p.y);
        for (const p of placements) {
          ctx.fillStyle = p.ink;
          ctx.fillText(p.text, p.x, p.y);
        }
      } else {
        for (const p of placements) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(rad);
          if (p.halo) ctx.strokeText(p.text, 0, 0);
          ctx.fillStyle = p.ink;
          ctx.fillText(p.text, 0, 0);
          ctx.restore();
        }
      }
    }
  }
}
