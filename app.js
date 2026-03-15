const storageKeys = {
  apiBase: "ap-thumbnailer-api-base",
  pendingVideo: "ap-thumbnailer-pending-video",
};

const elements = {
  form: document.getElementById("thumbnailForm"),
  videoInput: document.getElementById("videoInput"),
  generateButton: document.getElementById("generateButton"),
  statusText: document.getElementById("statusText"),
  result: document.getElementById("result"),
  previewImage: document.getElementById("previewImage"),
  resultTitle: document.getElementById("resultTitle"),
  resultDetail: document.getElementById("resultDetail"),
};

function getConfiguredApiBase() {
  const metaValue =
    document.querySelector('meta[name="thumbnailer-api-base"]')?.content?.trim() || "";
  const queryValue = new URLSearchParams(window.location.search).get("api") || "";
  const storedValue = localStorage.getItem(storageKeys.apiBase) || "";
  const candidate = queryValue || storedValue || metaValue;

  return candidate.replace(/\/+$/, "");
}

function ensureApiBase() {
  const configured = getConfiguredApiBase();

  if (configured) {
    localStorage.setItem(storageKeys.apiBase, configured);
    return configured;
  }

  const prompted = window.prompt(
    "Paste the worker URL once. Example: https://advanced-physics-thumbnailer.your-subdomain.workers.dev",
  );

  if (!prompted || !prompted.trim()) {
    throw new Error("A worker URL is required before generating thumbnails.");
  }

  const normalized = prompted.trim().replace(/\/+$/, "");
  localStorage.setItem(storageKeys.apiBase, normalized);
  return normalized;
}

function setBusy(isBusy) {
  elements.generateButton.disabled = isBusy;
  elements.generateButton.textContent = isBusy ? "working..." : "generate";
}

function setStatus(message, tone) {
  elements.statusText.textContent = message;
  elements.statusText.className = tone === "error" ? "status error" : "status";
}

function setResult(payload) {
  elements.result.hidden = false;
  elements.previewImage.src = payload.previewDataUrl;
  elements.resultTitle.textContent = payload.video.title;
  elements.resultDetail.textContent = `${payload.video.courseName} | ${payload.template.courseName}${payload.template.usedFallback ? " fallback" : ""}`;
}

function getReturnTo() {
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete("auth");
  returnUrl.searchParams.delete("message");

  if (!returnUrl.searchParams.get("api")) {
    const apiBase = localStorage.getItem(storageKeys.apiBase);

    if (apiBase) {
      returnUrl.searchParams.set("api", apiBase);
    }
  }

  return returnUrl.toString();
}

async function postJson(path, body) {
  const response = await fetch(`${ensureApiBase()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function generateThumbnail(videoInput) {
  const trimmedVideo = videoInput.trim();

  if (!trimmedVideo) {
    throw new Error("Paste a YouTube video URL first.");
  }

  localStorage.setItem(storageKeys.pendingVideo, trimmedVideo);
  setStatus("working...");

  const { response, payload } = await postJson("/api/run", {
    videoInput: trimmedVideo,
    returnTo: getReturnTo(),
  });

  if (response.status === 401 && payload.needsAuth && payload.authUrl) {
    setStatus("redirecting to youtube auth...");
    window.location.href = payload.authUrl;
    return;
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }

  localStorage.removeItem(storageKeys.pendingVideo);
  setResult(payload);
  setStatus(`done. thumbnail updated for ${payload.video.videoId}`);
}

async function run(videoInput) {
  setBusy(true);

  try {
    await generateThumbnail(videoInput);
  } catch (error) {
    setStatus(error.message || "Unknown error", "error");
  } finally {
    setBusy(false);
  }
}

function cleanUrl() {
  const clean = new URL(window.location.href);
  clean.searchParams.delete("auth");
  clean.searchParams.delete("message");
  window.history.replaceState({}, "", clean);
}

async function resumeAfterAuth() {
  const params = new URLSearchParams(window.location.search);
  const authState = params.get("auth");

  if (!authState) {
    return;
  }

  if (authState === "error") {
    setStatus(params.get("message") || "youtube authorization failed.", "error");
    cleanUrl();
    return;
  }

  if (authState === "done") {
    const pendingVideo = localStorage.getItem(storageKeys.pendingVideo);

    if (pendingVideo) {
      elements.videoInput.value = pendingVideo;
      cleanUrl();
      setStatus("youtube connected. finishing the job...");
      await run(pendingVideo);
      return;
    }

    setStatus("youtube connected. paste a link.");
    cleanUrl();
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await run(elements.videoInput.value);
});

resumeAfterAuth().catch((error) => {
  setStatus(error.message || "Unknown error", "error");
});
