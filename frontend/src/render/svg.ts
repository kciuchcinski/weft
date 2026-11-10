import type { LayoutConfig, Scene } from "./layout";
import type { View } from "./draw";
import { genePoints, ribbonPath } from "./geometry";
import { geneLabelOpts, labelScreenRect, placeGeneLabels } from "./labels";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const f1 = (n: number) => n.toFixed(1);

/**
 * Serialise a scene to a standalone SVG document. This is a vector copy of `draw()`
 * for the same `view`: world content sits in a translate+scale group, and
 * screen-space content (cluster names, CDS labels, strokes kept a constant width
 * on screen) is laid out against `view.zoom` exactly as on the canvas. If the two
 * diverge, text sizes in the SVG stop matching the PNG and the canvas.
 *
 * The viewBox is in screen px (`cssW` × `cssH`); the document's nominal size is
 * the world size, so the SVG imports at the same size whatever the export zoom.
 */
export function sceneToSVG(scene: Scene, cfg: LayoutConfig, view: View, geneLabelEligible: Set<string> | null = null): string {
  const z = view.zoom;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f1(view.cssW / z)}" height="${f1(view.cssH / z)}" ` +
    `viewBox="0 0 ${view.cssW} ${view.cssH}">`
  );
  parts.push(`<rect width="100%" height="100%" fill="${cfg.background}"/>`);
  parts.push(`<g transform="translate(${view.panX.toFixed(2)},${view.panY.toFixed(2)}) scale(${z})">`);

  for (const l of scene.links) {
    parts.push(`<path d="${ribbonPath(l, cfg.straight)}" fill="${l.colour}" fill-opacity="${l.alpha.toFixed(3)}"/>`);
  }
  for (const lo of scene.loci) {
    parts.push(`<line x1="${f1(lo.x0)}" y1="${f1(lo.y)}" x2="${f1(lo.x1)}" y2="${f1(lo.y)}" stroke="${cfg.backboneColour}" stroke-width="${cfg.backboneWidth / z}" stroke-opacity="${cfg.backboneOpacity.toFixed(3)}"/>`);
  }
  const geneStroke = cfg.geneStrokeWidth > 0 ? ` stroke="${cfg.geneStroke}" stroke-width="${cfg.geneStrokeWidth / z}"` : "";
  for (const g of scene.genes) {
    const pts = genePoints(g, cfg.trackHeight, cfg.geneShape, cfg.tipLength).map((p) => `${f1(p[0])},${f1(p[1])}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${g.colour}"${geneStroke}/>`);
  }
  if (cfg.showLinkLabels) {
    for (const l of scene.links) {
      if (!l.label) continue;
      parts.push(
        `<text x="${f1(l.mx)}" y="${f1(l.my)}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="system-ui, sans-serif" font-size="${10 / z}" font-weight="600" fill="#202124" ` +
        `stroke="#ffffff" stroke-width="${3 / z}" stroke-opacity="0.9" stroke-linejoin="round" paint-order="stroke">${esc(l.label)}</text>`
      );
    }
  }

  // Scale bar and legend are world-space on the canvas too: they scale with the figure.
  if (scene.scaleBar) {
    const sb = scene.scaleBar;
    const sw = sb.strokeWidth.toFixed(2);
    parts.push(
      `<line x1="${f1(sb.x0)}" y1="${f1(sb.y)}" x2="${f1(sb.x1)}" y2="${f1(sb.y)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<line x1="${f1(sb.x0)}" y1="${f1(sb.y - sb.tick)}" x2="${f1(sb.x0)}" y2="${f1(sb.y + sb.tick)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<line x1="${f1(sb.x1)}" y1="${f1(sb.y - sb.tick)}" x2="${f1(sb.x1)}" y2="${f1(sb.y + sb.tick)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<text x="${f1(sb.labelX)}" y="${f1(sb.labelY)}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${sb.fontSize}" font-weight="600" fill="#202124">${esc(sb.label)}</text>`,
    );
  }
  if (scene.legend) {
    for (const e of scene.legend.entries) {
      parts.push(
        `<rect x="${f1(e.x)}" y="${f1(e.y)}" width="${f1(e.size)}" height="${f1(e.size)}" fill="${e.colour}" stroke="#33383f" stroke-width="${0.7 / z}"/>`,
        `<text x="${f1(e.textX)}" y="${f1(e.textY)}" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${scene.legend.fontSize}" fill="#202124">${esc(e.label)}</text>`,
      );
    }
  }
  parts.push(`</g>`);

  // Screen space from here on, as in draw().
  if (cfg.showClusterNames) {
    // Pinned names get a background halo, as on the canvas, since they can overlay the figure.
    const halo = cfg.clusterLabelPinned ? ` stroke="${cfg.background}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"` : "";
    for (const lab of scene.labels) {
      const r = labelScreenRect(lab, cfg, view);
      const anchor = r.align === "left" ? "start" : "end";
      const baseline = r.middle ? ` dominant-baseline="central"` : "";
      parts.push(`<text x="${f1(r.x)}" y="${f1(r.y)}" text-anchor="${anchor}"${baseline} font-family="system-ui, sans-serif" font-size="${cfg.clusterFontSize}" font-weight="600" fill="#202124"${halo}>${esc(lab.name)}</text>`);
    }
  }

  if (cfg.showGeneLabels !== "never") {
    const rot = cfg.geneLabelRotation;
    for (const p of placeGeneLabels(scene.genes, view, geneLabelOpts(cfg, geneLabelEligible))) {
      // SVG rotate is clockwise; negate to match the canvas (positive reads up-right).
      // placement.y is the label's vertical centre, so anchor on the central baseline.
      const transform = rot !== 0 ? ` transform="rotate(${(-rot).toFixed(1)} ${f1(p.x)} ${f1(p.y)})"` : "";
      parts.push(
        `<text x="${f1(p.x)}" y="${f1(p.y)}" text-anchor="middle" dominant-baseline="central"${transform} ` +
        `font-family="system-ui, sans-serif" font-size="${cfg.geneLabelFontSize}" font-weight="500" fill="${p.ink}"` +
        (p.halo ? ` stroke="${cfg.background}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"` : "") +
        `>${esc(p.text)}</text>`
      );
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}
