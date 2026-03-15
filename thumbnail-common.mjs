export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;
export const TITLE_TEXT = "Advanced Physics";
export const FONT_FAMILY = "Englebert";
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "");
}

export function colorToCss(colorValue) {
  const color = colorValue || { r: 255, g: 255, b: 255 };
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function transformText(text, transform) {
  if (transform === "uppercase") {
    return String(text || "").toUpperCase();
  }

  if (transform === "lowercase") {
    return String(text || "").toLowerCase();
  }

  return String(text || "");
}

export function getTextLines(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getLineHeight(node) {
  const paragraphs = node.text?.paragraphs || [];
  const lineYs = [];

  for (const paragraph of paragraphs) {
    for (const line of paragraph.lines || []) {
      if (line[0] && typeof line[0].y === "number") {
        lineYs.push(line[0].y);
      }
    }
  }

  if (lineYs.length >= 2) {
    const deltas = [];

    for (let index = 1; index < lineYs.length; index += 1) {
      deltas.push(lineYs[index] - lineYs[index - 1]);
    }

    const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return average > 0 ? average : null;
  }

  const explicitLineSpacing = node.style?.textAttributes?.lineSpacing;

  if (typeof explicitLineSpacing === "number" && explicitLineSpacing > 0) {
    return explicitLineSpacing;
  }

  return null;
}

export function dedupeShapes(shapes) {
  const seen = new Set();
  const uniqueShapes = [];

  for (const shape of shapes) {
    const key = [
      shape.resourceKey,
      shape.x,
      shape.y,
      shape.width,
      shape.height,
      shape.opacity,
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueShapes.push(shape);
  }

  return uniqueShapes;
}

export function prepareSubtitleText(rawText) {
  return String(rawText || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[:|]\s*/g, "\n")
    .trim();
}

export function sliceArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function measureTextWidth(font, fontSize, text) {
  return font.getAdvanceWidth(String(text || ""), fontSize, {
    kerning: true,
  });
}

export function splitLongToken(font, fontSize, token, maxWidth) {
  const chunks = [];
  let current = "";

  for (const character of token) {
    const candidate = `${current}${character}`;

    if (!current || measureTextWidth(font, fontSize, candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = character;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function wrapParagraph(font, fontSize, paragraph, maxWidth) {
  if (!paragraph) {
    return [""];
  }

  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (!currentLine || measureTextWidth(font, fontSize, candidate) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (measureTextWidth(font, fontSize, word) <= maxWidth) {
      currentLine = word;
      continue;
    }

    const chunks = splitLongToken(font, fontSize, word, maxWidth);
    currentLine = chunks.shift() || "";
    lines.push(...chunks.slice(0, -1));
    currentLine = chunks[chunks.length - 1] || currentLine;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : [""];
}

export function wrapText(font, fontSize, text, maxWidth) {
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(font, fontSize, paragraph.trim(), maxWidth));
  }

  return lines.filter((line) => line.trim());
}

export function fitTextBlock(font, options) {
  const {
    rawText,
    originalFontSize,
    originalLineHeight,
    minFontSize,
    maxWidth,
    maxHeight,
    maxLines,
    textTransform,
    preprocess,
  } = options;

  const preparedText = preprocess(rawText);

  for (let fontSize = originalFontSize; fontSize >= minFontSize; fontSize -= 2) {
    const transformedText = transformText(preparedText, textTransform);
    const lines = wrapText(font, fontSize, transformedText, maxWidth);
    const lineHeight = (originalLineHeight || originalFontSize * 1.22) * (fontSize / originalFontSize);
    const totalHeight = (Math.max(lines.length, 1) - 1) * lineHeight + fontSize;

    if (lines.length <= maxLines && totalHeight <= maxHeight) {
      return {
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  const fallbackFontSize = minFontSize;
  const transformedText = transformText(preparedText, textTransform);

  return {
    fontSize: fallbackFontSize,
    lineHeight: (originalLineHeight || originalFontSize * 1.22) * (fallbackFontSize / originalFontSize),
    lines: wrapText(font, fallbackFontSize, transformedText, maxWidth).slice(0, maxLines),
  };
}

export function svgTextAnchor(align) {
  if (align === "center") {
    return "middle";
  }

  if (align === "right") {
    return "end";
  }

  return "start";
}

export function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function requireText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${fieldName} is required.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

export function extractVideoId(videoInput) {
  const normalizedInput = requireText(videoInput, "videoInput");

  if (/^[A-Za-z0-9_-]{11}$/.test(normalizedInput)) {
    return normalizedInput;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(normalizedInput);
  } catch (_error) {
    const error = new Error("Enter a YouTube video URL or a valid 11-character video ID.");
    error.status = 400;
    throw error;
  }

  const hostname = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  let candidateId = null;

  if (hostname === "youtu.be") {
    candidateId = parsedUrl.pathname.split("/").filter(Boolean)[0];
  } else if (
    hostname === "youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "music.youtube.com"
  ) {
    if (parsedUrl.pathname === "/watch") {
      candidateId = parsedUrl.searchParams.get("v");
    } else {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

      if (
        pathParts.length >= 2 &&
        ["shorts", "live", "embed"].includes(pathParts[0].toLowerCase())
      ) {
        candidateId = pathParts[1];
      }
    }
  }

  if (!candidateId || !/^[A-Za-z0-9_-]{11}$/.test(candidateId)) {
    const error = new Error("Could not extract a YouTube video ID from that input.");
    error.status = 400;
    throw error;
  }

  return candidateId;
}

export function splitVideoTitle(title) {
  const normalizedTitle = requireText(title, "title");
  const dashMatch = normalizedTitle.match(/^(.+?)\s(?:-|–|—)\s(.+)$/);

  if (!dashMatch) {
    const error = new Error(
      'Expected a title like "Course Name - Video Title". Update the YouTube title format or handle it manually.',
    );
    error.status = 400;
    throw error;
  }

  return {
    courseName: dashMatch[1].trim(),
    lessonTitle: dashMatch[2].trim(),
  };
}

export function detectFileExtension(buffer) {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "jpg";
  }

  return "bin";
}

export function toBase64(uint8Array) {
  let binary = "";

  for (let index = 0; index < uint8Array.length; index += 0x8000) {
    const chunk = uint8Array.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
