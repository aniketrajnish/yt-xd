"use strict";

const application = require("application");
const commands = require("commands");
const { Artboard, Text } = require("scenegraph");
const { shell, storage } = require("uxp");

const localFileSystem = storage.localFileSystem;
const DEFAULT_SERVER_URL = "http://127.0.0.1:4318";
const TARGET_EXPORT_WIDTH = 1280;

let panelElement;

function walk(node, visitor) {
  visitor(node);

  if (!node || !node.children || typeof node.children.forEach !== "function") {
    return;
  }

  node.children.forEach((child) => walk(child, visitor));
}

function getAllNodes(rootNode, predicate) {
  const nodes = [];

  walk(rootNode, (node) => {
    if (predicate(node)) {
      nodes.push(node);
    }
  });

  return nodes;
}

function sanitizeServerUrl(serverUrl) {
  return (serverUrl || DEFAULT_SERVER_URL).trim().replace(/\/+$/, "");
}

function sanitizeFileStem(value) {
  const fallback = "thumbnail";
  const sanitized = (value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return sanitized || fallback;
}

function normalizeKey(value) {
  return (value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function computeExportScale(artboard) {
  const bounds = artboard.globalBounds || artboard.localBounds;
  const width = bounds && bounds.width ? bounds.width : TARGET_EXPORT_WIDTH;
  const scale = TARGET_EXPORT_WIDTH / width;
  return Math.max(0.1, Math.min(scale, 100));
}

function setTextContent(textNode, nextValue) {
  if (typeof textNode.updateText === "function") {
    textNode.updateText(nextValue);
    return;
  }

  textNode.text = nextValue;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return btoa(binary);
}

function parseResponseBody(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (_error) {
    return { rawBody };
  }
}

async function requestJson(serverUrl, pathname, options) {
  const response = await fetch(`${sanitizeServerUrl(serverUrl)}${pathname}`, options);
  const rawBody = await response.text();
  const parsedBody = parseResponseBody(rawBody);

  if (!response.ok) {
    throw new Error(
      parsedBody.error || parsedBody.rawBody || `Request failed with status ${response.status}.`,
    );
  }

  return parsedBody;
}

function describeTemplateArtboard(artboard) {
  const textNodes = getAllNodes(artboard, (node) => node instanceof Text).sort(
    (left, right) => right.fontSize - left.fontSize,
  );

  if (textNodes.length < 2) {
    return null;
  }

  return {
    artboard,
    courseNode: textNodes[0],
    subtitleNode: textNodes[1],
    courseName: textNodes[0].text.trim(),
    courseKey: normalizeKey(textNodes[0].text),
  };
}

function getTemplateArtboards(rootNode) {
  return getAllNodes(rootNode, (node) => node instanceof Artboard)
    .map((artboard) => describeTemplateArtboard(artboard))
    .filter(Boolean);
}

function findMatchingTemplate(templates, courseName) {
  const desiredKey = normalizeKey(courseName);
  let match = templates.find((template) => template.courseKey === desiredKey);

  if (match) {
    return match;
  }

  match = templates.find(
    (template) =>
      desiredKey.includes(template.courseKey) || template.courseKey.includes(desiredKey),
  );

  return match || null;
}

function chooseFallbackTemplate(templates) {
  return templates[0] || null;
}

function applyScaledLineSpacing(textNode, originalLineSpacing, originalFontSize, nextFontSize) {
  if (!originalLineSpacing) {
    textNode.lineSpacing = 0;
    return;
  }

  const scale = nextFontSize / originalFontSize;
  textNode.lineSpacing = Math.max(0, Math.round(originalLineSpacing * scale));
}

function fitCourseText(courseNode, courseName) {
  const targetText = courseName.trim();
  const originalWidth = courseNode.localBounds.width * 1.08;
  const originalFontSize = courseNode.fontSize;
  const originalLineSpacing = courseNode.lineSpacing;
  const minFontSize = Math.max(72, Math.round(originalFontSize * 0.58));

  for (let fontSize = originalFontSize; fontSize >= minFontSize; fontSize -= 2) {
    courseNode.fontSize = fontSize;
    applyScaledLineSpacing(courseNode, originalLineSpacing, originalFontSize, fontSize);
    setTextContent(courseNode, targetText);

    if (courseNode.localBounds.width <= originalWidth) {
      return;
    }
  }

  courseNode.fontSize = minFontSize;
  applyScaledLineSpacing(courseNode, originalLineSpacing, originalFontSize, minFontSize);
  setTextContent(courseNode, targetText);
}

function formatLessonText(lessonTitle) {
  return lessonTitle
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s*[:|]\s*/g)
    .filter(Boolean)
    .join("\n");
}

function placeAreaText(node, targetBounds) {
  const nodeTopLeft = {
    x: node.localBounds.x,
    y: node.localBounds.y,
  };

  node.placeInParentCoordinates(nodeTopLeft, {
    x: targetBounds.x,
    y: targetBounds.y,
  });
}

function fitSubtitleText(subtitleNode, lessonTitle) {
  const targetText = formatLessonText(lessonTitle);
  const originalBounds = subtitleNode.boundsInParent;
  const originalFontSize = subtitleNode.fontSize;
  const originalLineSpacing = subtitleNode.lineSpacing;
  const maxWidth = Math.max(originalBounds.width * 1.08, 940);
  const maxHeight = Math.max(originalBounds.height * 1.8, originalFontSize * 4.6);
  const targetBounds = {
    x: originalBounds.x - (maxWidth - originalBounds.width) / 2,
    y: originalBounds.y,
  };
  const minFontSize = Math.max(40, Math.round(originalFontSize * 0.5));

  subtitleNode.areaBox = {
    width: maxWidth,
    height: maxHeight,
  };
  subtitleNode.textAlign = Text.ALIGN_CENTER;

  for (let fontSize = originalFontSize; fontSize >= minFontSize; fontSize -= 2) {
    subtitleNode.fontSize = fontSize;
    applyScaledLineSpacing(subtitleNode, originalLineSpacing, originalFontSize, fontSize);
    setTextContent(subtitleNode, targetText);
    placeAreaText(subtitleNode, targetBounds);

    if (!subtitleNode.clippedByArea) {
      return;
    }
  }

  subtitleNode.fontSize = minFontSize;
  applyScaledLineSpacing(subtitleNode, originalLineSpacing, originalFontSize, minFontSize);
  setTextContent(subtitleNode, targetText);
  placeAreaText(subtitleNode, targetBounds);
}

function duplicateTemplate(selection, template) {
  selection.items = [template.artboard];
  commands.duplicate();

  const duplicatedArtboard = selection.items.find(
    (node) => node instanceof Artboard && node.guid !== template.artboard.guid,
  ) || selection.items.find((node) => node instanceof Artboard);

  if (!duplicatedArtboard) {
    throw new Error("Adobe XD did not return the duplicated artboard.");
  }

  const duplicateTemplateInfo = describeTemplateArtboard(duplicatedArtboard);

  if (!duplicateTemplateInfo) {
    throw new Error("The duplicated artboard does not match the expected template structure.");
  }

  return duplicateTemplateInfo;
}

function applyVideoToDocument(video) {
  let result = null;

  application.editDocument((selection, rootNode) => {
    if (selection.editContext !== rootNode) {
      throw new Error(
        "Exit isolated layer editing first. Select the canvas or an artboard so the plugin can access every template.",
      );
    }

    const templates = getTemplateArtboards(rootNode);

    if (!templates.length) {
      throw new Error("No artboard templates were found in the open Adobe XD document.");
    }

    let template = findMatchingTemplate(templates, video.courseName);
    let createdArtboard = false;

    if (!template) {
      const fallbackTemplate = chooseFallbackTemplate(templates);

      if (!fallbackTemplate) {
        throw new Error("No fallback artboard was available for duplication.");
      }

      template = duplicateTemplate(selection, fallbackTemplate);
      fitCourseText(template.courseNode, video.courseName);
      template.artboard.name = `${video.courseName} - Auto`;
      createdArtboard = true;
    }

    fitSubtitleText(template.subtitleNode, video.lessonTitle);
    selection.items = [template.artboard];

    result = {
      artboard: template.artboard,
      matchedCourseName: template.courseName,
      createdArtboard,
    };
  });

  if (!result) {
    throw new Error("Adobe XD did not return a render target artboard.");
  }

  return result;
}

async function exportArtboardToBase64(artboard, fileStem) {
  const tempFolder = await localFileSystem.getTemporaryFolder();
  const outputFile = await tempFolder.createEntry(`${sanitizeFileStem(fileStem)}.png`, {
    overwrite: true,
  });

  await application.createRenditions([
    {
      node: artboard,
      outputFile,
      type: application.RenditionType.PNG,
      scale: computeExportScale(artboard),
    },
  ]);

  const buffer = await outputFile.read({ format: storage.formats.binary });
  return arrayBufferToBase64(buffer);
}

function buildMarkup() {
  return `
    <style>
      .yt-xd-panel {
        color: #f7fafc;
        font-family: "Segoe UI", system-ui, sans-serif;
        padding: 16px;
        background:
          radial-gradient(circle at top left, rgba(157, 255, 116, 0.16), transparent 42%),
          linear-gradient(180deg, #11161f 0%, #192432 100%);
        height: 100%;
        box-sizing: border-box;
      }
      .yt-xd-card {
        padding: 14px;
        border-radius: 14px;
        background: rgba(9, 14, 20, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .yt-xd-panel h1 {
        margin: 0 0 6px;
        font-size: 22px;
        font-weight: 650;
      }
      .yt-xd-panel p {
        margin: 0 0 16px;
        line-height: 1.45;
        color: rgba(241, 245, 249, 0.78);
      }
      .yt-xd-field {
        margin-bottom: 12px;
      }
      .yt-xd-label {
        display: block;
        margin-bottom: 6px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(191, 219, 254, 0.84);
      }
      .yt-xd-input,
      .yt-xd-readout {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06);
        color: #f8fafc;
        padding: 10px 12px;
      }
      .yt-xd-readout {
        min-height: 42px;
        white-space: pre-wrap;
      }
      .yt-xd-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 14px;
      }
      .yt-xd-button {
        border: 0;
        border-radius: 11px;
        padding: 10px 12px;
        font-weight: 650;
        color: #f8fafc;
        background: linear-gradient(180deg, #6adf38 0%, #3d9a22 100%);
      }
      .yt-xd-button.secondary {
        background: rgba(255, 255, 255, 0.08);
      }
      .yt-xd-button:disabled {
        opacity: 0.55;
      }
      .yt-xd-status {
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 11px;
        background: rgba(255, 255, 255, 0.06);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .yt-xd-status[data-tone="error"] {
        background: rgba(190, 24, 93, 0.22);
      }
      .yt-xd-status[data-tone="success"] {
        background: rgba(22, 163, 74, 0.22);
      }
    </style>
    <div class="yt-xd-panel">
      <div class="yt-xd-card">
        <h1>AP Thumbnailer</h1>
        <p>Paste a YouTube video URL, reuse the matching course artboard, fit the lesson text, export the PNG, save it locally, and update the thumbnail on YouTube.</p>

        <div class="yt-xd-field">
          <label class="yt-xd-label" for="serverUrl">Uploader URL</label>
          <input class="yt-xd-input" id="serverUrl" value="${DEFAULT_SERVER_URL}" />
        </div>

        <div class="yt-xd-field">
          <label class="yt-xd-label" for="videoInput">Video URL or ID</label>
          <input class="yt-xd-input" id="videoInput" placeholder="https://www.youtube.com/watch?v=..." />
        </div>

        <div class="yt-xd-field">
          <label class="yt-xd-label" for="coursePreview">Course template</label>
          <div class="yt-xd-readout" id="coursePreview">Not resolved yet.</div>
        </div>

        <div class="yt-xd-field">
          <label class="yt-xd-label" for="lessonPreview">Lesson title</label>
          <div class="yt-xd-readout" id="lessonPreview">Not resolved yet.</div>
        </div>

        <div class="yt-xd-actions">
          <button class="yt-xd-button secondary" id="statusButton" type="button">Check Uploader</button>
          <button class="yt-xd-button secondary" id="connectButton" type="button">Connect YouTube</button>
          <button class="yt-xd-button secondary" id="resolveButton" type="button">Resolve Video</button>
          <button class="yt-xd-button" id="updateButton" type="button">Update Thumbnail</button>
        </div>

        <div class="yt-xd-status" id="statusMessage" data-tone="neutral">
          Start the local uploader, connect YouTube once, open ap.xd in Adobe XD, then paste a video URL.
        </div>
      </div>
    </div>
  `;
}

function createPanel() {
  const root = document.createElement("div");
  root.innerHTML = buildMarkup();

  const serverUrlInput = root.querySelector("#serverUrl");
  const videoInput = root.querySelector("#videoInput");
  const coursePreview = root.querySelector("#coursePreview");
  const lessonPreview = root.querySelector("#lessonPreview");
  const statusButton = root.querySelector("#statusButton");
  const connectButton = root.querySelector("#connectButton");
  const resolveButton = root.querySelector("#resolveButton");
  const updateButton = root.querySelector("#updateButton");
  const statusMessage = root.querySelector("#statusMessage");
  const busyButtons = [statusButton, connectButton, resolveButton, updateButton];

  function setBusy(isBusy) {
    busyButtons.forEach((button) => {
      button.disabled = isBusy;
    });
  }

  function setStatus(message, tone) {
    statusMessage.textContent = message;
    statusMessage.dataset.tone = tone || "neutral";
  }

  function setVideoPreview(video) {
    coursePreview.textContent = video ? video.courseName : "Not resolved yet.";
    lessonPreview.textContent = video ? video.lessonTitle : "Not resolved yet.";
  }

  function getFormData() {
    return {
      serverUrl: sanitizeServerUrl(serverUrlInput.value),
      videoInput: videoInput.value.trim(),
    };
  }

  async function refreshUploaderStatus() {
    setBusy(true);

    try {
      const formData = getFormData();
      const status = await requestJson(formData.serverUrl, "/api/status");

      if (!status.configured) {
        setStatus("Uploader is running, but .env is missing YouTube OAuth credentials.", "error");
        return;
      }

      if (!status.authenticated) {
        setStatus("Uploader is ready. Connect YouTube in your browser before resolving or uploading.", "neutral");
        return;
      }

      setStatus("Uploader is connected and ready. Make sure Adobe XD is not drilled into a group so every artboard is editable.", "success");
    } catch (error) {
      setStatus(
        `Uploader check failed: ${error.message}. Start npm start in this repo first.`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolveVideoInput() {
    const formData = getFormData();

    if (!formData.videoInput) {
      throw new Error("Paste a YouTube video URL or ID first.");
    }

    const video = await requestJson(formData.serverUrl, "/api/video/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        videoInput: formData.videoInput,
      }),
    });

    setVideoPreview(video);

    if (video.warnings && video.warnings.length) {
      setStatus(video.warnings.join("\n"), "neutral");
    }

    return video;
  }

  statusButton.addEventListener("click", () => {
    void refreshUploaderStatus();
  });

  connectButton.addEventListener("click", async () => {
    setBusy(true);

    try {
      const formData = getFormData();
      await shell.openExternal(`${formData.serverUrl}/auth/start`);
      setStatus("Browser opened for Google OAuth. Finish the flow there, then return to Adobe XD.", "neutral");
    } catch (error) {
      setStatus(`Could not open the OAuth flow: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  resolveButton.addEventListener("click", async () => {
    setBusy(true);

    try {
      const video = await resolveVideoInput();
      const warningText =
        video.warnings && video.warnings.length ? `\n${video.warnings.join("\n")}` : "";
      setStatus(
        `Resolved ${video.videoId}.\nCourse: ${video.courseName}\nLesson: ${video.lessonTitle}${warningText}`,
        "success",
      );
    } catch (error) {
      setStatus(`Could not resolve the video: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  updateButton.addEventListener("click", async () => {
    setBusy(true);

    try {
      const formData = getFormData();
      const video = await resolveVideoInput();
      const renderResult = applyVideoToDocument(video);
      const imageBase64 = await exportArtboardToBase64(
        renderResult.artboard,
        video.outputFileName || video.title,
      );
      const uploadResult = await requestJson(formData.serverUrl, "/api/upload-thumbnail", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          videoId: video.videoId,
          mimeType: "image/png",
          imageBase64,
          outputFileName: video.outputFileName || video.title,
        }),
      });

      const localSaveLine = uploadResult.savedPath
        ? `\nSaved: ${uploadResult.savedPath}`
        : "";
      const templateLine = renderResult.createdArtboard
        ? "\nCreated a new course artboard by duplicating an existing template."
        : `\nReused the existing "${renderResult.matchedCourseName}" course artboard.`;

      setStatus(
        `Thumbnail updated for ${video.videoId}.${templateLine}${localSaveLine}`,
        "success",
      );
    } catch (error) {
      setStatus(`Thumbnail update failed: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  setVideoPreview(null);
  void refreshUploaderStatus();
  return root;
}

function show(event) {
  if (!panelElement) {
    panelElement = createPanel();
  }

  if (!event.node.firstChild) {
    event.node.appendChild(panelElement);
  }
}

function hide() {}

module.exports = {
  panels: {
    thumbnailPanel: {
      show,
      hide,
    },
  },
};
