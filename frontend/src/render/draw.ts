import type { LayoutConfig, Scene } from "./layout";
import { genePoints, ribbonPath } from "./geometry";

export interface View {
  dpr: number;
  cssW: number;
  cssH: number;
  zoom: number;
  panX: number;
  panY: number;
}

export function draw(ctx: CanvasRenderingContext2D, scene: Scene, view: View, cfg: LayoutConfig): void {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.cssW, view.cssH);
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, view.cssW, view.cssH);

  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);

  for (const l of scene.links) {
    ctx.globalAlpha = l.alpha;
    ctx.fillStyle = l.colour;
    ctx.fill(new Path2D(ribbonPath(l, cfg.straight)));
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

  ctx.strokeStyle = cfg.geneStroke;
  ctx.lineWidth = cfg.geneStrokeWidth / view.zoom;
  for (const g of scene.genes) {
    const pts = genePoints(g, cfg.trackHeight, cfg.geneShape, cfg.tipLength);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = g.colour;
    ctx.fill();
    if (cfg.geneStrokeWidth > 0) ctx.stroke();
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

  if (cfg.showClusterNames) {
    const fontSize = cfg.clusterFontSize / view.zoom;
    ctx.fillStyle = "#202124";
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const lab of scene.labels) ctx.fillText(lab.name, lab.x, lab.y);
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
}
