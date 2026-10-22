import type { LayoutConfig, Scene } from "./layout";
import { genePoints, ribbonPath } from "./geometry";
import { placeGeneLabels } from "./labels";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Serialise a scene to a standalone, correctly-sized SVG document. */
export function sceneToSVG(scene: Scene, cfg: LayoutConfig, geneLabelEligible: Set<string> | null = null): string {
  const m = 24;
  const { minX, minY, maxX, maxY } = scene.bounds;
  const w = (maxX - minX) + 2 * m;
  const h = (maxY - minY) + 2 * m;
  const tx = m - minX;
  const ty = m - minY;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
    `viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">`
  );
  parts.push(`<rect width="100%" height="100%" fill="${cfg.background}"/>`);
  parts.push(`<g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)})">`);

  for (const l of scene.links) {
    parts.push(`<path d="${ribbonPath(l, cfg.straight)}" fill="${l.colour}" fill-opacity="${l.alpha.toFixed(3)}"/>`);
  }
  for (const lo of scene.loci) {
    parts.push(`<line x1="${lo.x0.toFixed(1)}" y1="${lo.y.toFixed(1)}" x2="${lo.x1.toFixed(1)}" y2="${lo.y.toFixed(1)}" stroke="${cfg.backboneColour}" stroke-width="${cfg.backboneWidth}" stroke-opacity="${cfg.backboneOpacity.toFixed(3)}"/>`);
  }
  for (const g of scene.genes) {
    const pts = genePoints(g, cfg.trackHeight, cfg.geneShape, cfg.tipLength).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${g.colour}" stroke="${cfg.geneStroke}" stroke-width="${cfg.geneStrokeWidth}"/>`);
  }
  if (cfg.showLinkLabels) {
    for (const l of scene.links) {
      if (!l.label) continue;
      parts.push(
        `<text x="${l.mx.toFixed(1)}" y="${l.my.toFixed(1)}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="system-ui, sans-serif" font-size="10" font-weight="600" fill="#202124" ` +
        `stroke="#ffffff" stroke-width="3" stroke-opacity="0.9" paint-order="stroke">${esc(l.label)}</text>`
      );
    }
  }
  if (cfg.showClusterNames) {
    for (const lab of scene.labels) {
      // Mirror the canvas placement: `align` picks the text anchor, `middle` centres
      // the name on its track (the "beside" placement) instead of sitting on a baseline.
      const anchor = lab.align === "left" ? "start" : "end";
      const baseline = lab.middle ? ` dominant-baseline="central"` : "";
      parts.push(`<text x="${lab.x.toFixed(1)}" y="${lab.y.toFixed(1)}" text-anchor="${anchor}"${baseline} font-family="system-ui, sans-serif" font-size="${cfg.clusterFontSize}" font-weight="600" fill="#202124">${esc(lab.name)}</text>`);
    }
  }

  // CDS labels, placed in world space (export is zoom-independent, so the layout is
  // computed at 1:1 with no pan). Halo via paint-order keeps them legible.
  if (cfg.showGeneLabels !== "never") {
    const placements = placeGeneLabels(
      scene.genes,
      { zoom: 1, panX: 0, panY: 0, cssW: w },
      {
        mode: cfg.showGeneLabels,
        fontSize: cfg.geneLabelFontSize,
        trackHeight: cfg.trackHeight,
        position: cfg.geneLabelPosition,
        rotationDeg: cfg.geneLabelRotation,
        eligible: geneLabelEligible,
      },
    );
    const rot = cfg.geneLabelRotation;
    for (const p of placements) {
      // SVG rotate is clockwise; negate to match the canvas (positive reads up-right).
      // placement.y is the label's vertical centre, so anchor on the central baseline.
      const transform = rot !== 0 ? ` transform="rotate(${(-rot).toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})"` : "";
      parts.push(
        `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central"${transform} ` +
        `font-family="system-ui, sans-serif" font-size="${cfg.geneLabelFontSize}" font-weight="500" fill="#202124" ` +
        `stroke="${cfg.background}" stroke-width="3" paint-order="stroke">${esc(p.text)}</text>`
      );
    }
  }

  if (scene.scaleBar) {
    const sb = scene.scaleBar;
    const sw = sb.strokeWidth.toFixed(2);
    parts.push(
      `<line x1="${sb.x0.toFixed(1)}" y1="${sb.y.toFixed(1)}" x2="${sb.x1.toFixed(1)}" y2="${sb.y.toFixed(1)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<line x1="${sb.x0.toFixed(1)}" y1="${(sb.y - sb.tick).toFixed(1)}" x2="${sb.x0.toFixed(1)}" y2="${(sb.y + sb.tick).toFixed(1)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<line x1="${sb.x1.toFixed(1)}" y1="${(sb.y - sb.tick).toFixed(1)}" x2="${sb.x1.toFixed(1)}" y2="${(sb.y + sb.tick).toFixed(1)}" stroke="#202124" stroke-width="${sw}"/>`,
      `<text x="${sb.labelX.toFixed(1)}" y="${sb.labelY.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${sb.fontSize}" font-weight="600" fill="#202124">${esc(sb.label)}</text>`,
    );
  }

  if (scene.legend) {
    for (const e of scene.legend.entries) {
      parts.push(
        `<rect x="${e.x.toFixed(1)}" y="${e.y.toFixed(1)}" width="${e.size.toFixed(1)}" height="${e.size.toFixed(1)}" fill="${e.colour}" stroke="#33383f" stroke-width="0.7"/>`,
        `<text x="${e.textX.toFixed(1)}" y="${e.textY.toFixed(1)}" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="${scene.legend.fontSize}" fill="#202124">${esc(e.label)}</text>`,
      );
    }
  }

  parts.push(`</g></svg>`);
  return parts.join("\n");
}
