import opentype from "opentype.js/dist/opentype.module.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

import {
  FONT_FAMILY,
  MAX_THUMBNAIL_BYTES,
  escapeXml,
  fitTextBlock,
  normalizeKey,
  prepareSubtitleText,
  requireText,
  sliceArrayBuffer,
  svgTextAnchor,
} from "./thumbnail-common.mjs";

let wasmReadyPromise = null;

function ensureWasmReady(loadWasm) {
  if (!wasmReadyPromise) {
    wasmReadyPromise = Promise.resolve(loadWasm()).then((moduleOrPath) => initWasm(moduleOrPath));
  }

  return wasmReadyPromise;
}

function parseTemplatePack(templatesText) {
  const pack = JSON.parse(templatesText);

  if (!Array.isArray(pack.templates) || !pack.font?.assetPath) {
    throw new Error("templates.json is missing required template-pack metadata.");
  }

  return pack;
}

function createSvgTextNode(node, layout) {
  const anchor = svgTextAnchor(node.align);
  const lines = layout.lines
    .map(
      (line, index) =>
        `<tspan x="${node.x}" y="${node.y + index * layout.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `<text fill="${node.color}" font-family="${escapeXml(
    FONT_FAMILY,
  )}" font-size="${layout.fontSize}" text-anchor="${anchor}" dominant-baseline="alphabetic">${lines}</text>`;
}

function createSvg(pack, template, courseLayout, subtitleLayout) {
  const shapeNodes = template.shapes
    .map(
      (shape) =>
        `<image href="asset:${escapeXml(shape.resourcePath)}" x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" opacity="${shape.opacity}" />`,
    )
    .join("");

  const titleNode = template.titleNode
    ? createSvgTextNode(template.titleNode, {
        fontSize: template.titleNode.fontSize,
        lineHeight: template.titleNode.lineHeight || template.titleNode.fontSize * 1.2,
        lines: [template.titleNode.text],
      })
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pack.canvas.width}" height="${pack.canvas.height}" viewBox="0 0 ${pack.canvas.width} ${pack.canvas.height}">
  <rect width="${pack.canvas.width}" height="${pack.canvas.height}" fill="#000000" />
  ${shapeNodes}
  ${titleNode}
  ${createSvgTextNode(template.courseNode, courseLayout)}
  ${createSvgTextNode(template.subtitleNode, subtitleLayout)}
</svg>`;
}

function findTemplate(pack, courseName, fallbackCourseName) {
  const desiredKey = normalizeKey(courseName);
  const templates = pack.templates;
  const fallbackKey = normalizeKey(fallbackCourseName || pack.fallbackCourseName || "");

  let template = templates.find((entry) => entry.courseKey === desiredKey);

  if (template) {
    return { template };
  }

  template = templates.find(
    (entry) => desiredKey.includes(entry.courseKey) || entry.courseKey.includes(desiredKey),
  );

  if (template) {
    return { template };
  }

  template = templates.find((entry) => entry.courseKey === fallbackKey) || templates[0] || null;

  if (!template) {
    throw new Error("No usable templates were found in templates.json.");
  }

  return { template, usedFallback: true };
}

function parseFont(fontBuffer) {
  return opentype.parse(sliceArrayBuffer(fontBuffer));
}

export async function createThumbnailService(options) {
  const {
    templatesText,
    fontBuffer,
    loadBinaryAsset,
    loadWasm,
    fallbackCourseName,
  } = options;

  const pack = parseTemplatePack(templatesText);
  const fontBytes = fontBuffer instanceof Uint8Array ? fontBuffer : new Uint8Array(fontBuffer);
  const font = parseFont(fontBytes);
  const resourceCache = new Map();

  await ensureWasmReady(loadWasm);

  async function getResource(resourcePath) {
    if (!resourceCache.has(resourcePath)) {
      resourceCache.set(resourcePath, Promise.resolve(loadBinaryAsset(resourcePath)));
    }

    return resourceCache.get(resourcePath);
  }

  return {
    async renderThumbnail(input) {
      const courseName = requireText(input.courseName, "courseName");
      const lessonTitle = requireText(input.lessonTitle, "lessonTitle");
      const { template, usedFallback } = findTemplate(pack, courseName, fallbackCourseName);

      const courseLayout = fitTextBlock(font, {
        rawText: courseName,
        originalFontSize: template.courseNode.fontSize,
        originalLineHeight: template.courseNode.lineHeight || template.courseNode.fontSize * 1.22,
        minFontSize: template.courseNode.minFontSize,
        maxWidth: template.courseNode.maxWidth,
        maxHeight: template.courseNode.maxHeight,
        maxLines: template.courseNode.maxLines,
        textTransform: template.courseNode.textTransform,
        preprocess: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      });

      const subtitleLayout = fitTextBlock(font, {
        rawText: lessonTitle,
        originalFontSize: template.subtitleNode.fontSize,
        originalLineHeight:
          template.subtitleNode.lineHeight || template.subtitleNode.fontSize * 1.22,
        minFontSize: template.subtitleNode.minFontSize,
        maxWidth: template.subtitleNode.maxWidth,
        maxHeight: template.subtitleNode.maxHeight,
        maxLines: template.subtitleNode.maxLines,
        textTransform: template.subtitleNode.textTransform,
        preprocess: prepareSubtitleText,
      });

      const svg = createSvg(pack, template, courseLayout, subtitleLayout);
      const resvg = new Resvg(svg, {
        background: "#000000",
        fitTo: { mode: "original" },
        font: {
          defaultFontFamily: pack.font.family || FONT_FAMILY,
          defaultFontSize: 12,
          fontBuffers: [fontBytes],
        },
      });

      for (const href of resvg.imagesToResolve()) {
        if (!href.startsWith("asset:")) {
          continue;
        }

        const resourcePath = href.slice("asset:".length);
        resvg.resolveImage(href, await getResource(resourcePath));
      }

      const image = resvg.render();
      const buffer = image.asPng();
      image.free();
      resvg.free();

      if (buffer.length > MAX_THUMBNAIL_BYTES) {
        const error = new Error(
          "The rendered thumbnail is larger than YouTube's 2 MB limit. Tighten the template or add compression.",
        );
        error.status = 400;
        throw error;
      }

      return {
        buffer,
        template: {
          artboardName: template.artboardName,
          courseName: template.courseName,
          usedFallback: Boolean(usedFallback),
        },
      };
    },
  };
}
