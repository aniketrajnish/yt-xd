"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");

require("dotenv").config();

const app = express();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4318", 10);
const EXPECTED_CHANNEL_TITLE =
  process.env.EXPECTED_CHANNEL_TITLE || "Advanced Physics";
const OUTPUT_DIRECTORY =
  process.env.OUTPUT_DIRECTORY || "C:\\Personal Projects\\ap";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_DIR = path.join(__dirname, ".data");
const TOKEN_FILE = path.join(TOKEN_DIR, "youtube-tokens.json");
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
    },
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function getRedirectUri() {
  return process.env.YOUTUBE_REDIRECT_URI || `http://${HOST}:${PORT}/auth/callback`;
}

function hasOAuthConfig() {
  return Boolean(
    process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET,
  );
}

function getOAuthConfig() {
  if (!hasOAuthConfig()) {
    const error = new Error(
      "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env before starting OAuth.",
    );
    error.status = 500;
    throw error;
  }

  return {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: getRedirectUri(),
  };
}

async function ensureTokenDir() {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
}

async function readStoredTokens() {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveStoredTokens(tokens) {
  await ensureTokenDir();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function createOAuthClient() {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const authClient = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  authClient.on("tokens", (tokens) => {
    if (!tokens || Object.keys(tokens).length === 0) {
      return;
    }

    void readStoredTokens()
      .then((existingTokens) =>
        saveStoredTokens({ ...(existingTokens || {}), ...tokens }),
      )
      .catch((error) => {
        console.error("Failed to persist refreshed tokens:", error);
      });
  });

  return authClient;
}

async function getAuthorizedClient() {
  const tokens = await readStoredTokens();

  if (!tokens) {
    const error = new Error(
      "No saved YouTube tokens found. Open /auth/start in your browser first.",
    );
    error.status = 401;
    throw error;
  }

  const authClient = createOAuthClient();
  authClient.setCredentials(tokens);
  return authClient;
}

async function getYouTubeClient() {
  return google.youtube({
    version: "v3",
    auth: await getAuthorizedClient(),
  });
}

function stripDataUrlPrefix(imageBase64) {
  return imageBase64.replace(/^data:[^;]+;base64,/, "");
}

function sanitizeFileName(value) {
  const baseName = (value || "thumbnail")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return baseName || "thumbnail";
}

function requireText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${fieldName} is required.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

function extractVideoId(videoInput) {
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

function splitVideoTitle(title) {
  const normalizedTitle = requireText(title, "title");
  const dashMatch = normalizedTitle.match(/^(.+?)\s[-–—]\s(.+)$/);

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

async function saveOutputCopy(buffer, outputFileName) {
  const outputDirectory = OUTPUT_DIRECTORY && OUTPUT_DIRECTORY.trim();

  if (!outputDirectory) {
    return null;
  }

  await fs.mkdir(outputDirectory, { recursive: true });

  const stem = path.parse(outputFileName || "thumbnail").name;
  const outputPath = path.join(outputDirectory, `${sanitizeFileName(stem)}.png`);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

function renderHomePage({ configured, authenticated }) {
  const authHint = configured
    ? authenticated
      ? "OAuth is connected. Return to Adobe XD and use the panel."
      : "OAuth is not connected yet. Continue with the connect link below."
    : "OAuth credentials are missing. Fill in .env first.";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AP Thumbnail Uploader</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, sans-serif;
        background: linear-gradient(160deg, #101824 0%, #1d2938 100%);
        color: #f3f6fa;
      }
      main {
        max-width: 760px;
        margin: 40px auto;
        padding: 28px;
        background: rgba(9, 14, 21, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 18px;
      }
      h1 {
        margin-top: 0;
      }
      .pill {
        display: inline-block;
        margin-right: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
      }
      a {
        color: #7ed6ff;
      }
      code {
        background: rgba(255, 255, 255, 0.08);
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>AP Thumbnail Uploader</h1>
      <p class="pill">Configured: ${configured ? "yes" : "no"}</p>
      <p class="pill">Authenticated: ${authenticated ? "yes" : "no"}</p>
      <p>${authHint}</p>
      <p>Redirect URI: <code>${getRedirectUri()}</code></p>
      <p>Expected channel: <code>${EXPECTED_CHANNEL_TITLE}</code></p>
      <p>Output directory: <code>${OUTPUT_DIRECTORY}</code></p>
      <p><a href="/auth/start">Connect YouTube</a></p>
      <p>The Adobe XD panel talks to this local service on <code>http://${HOST}:${PORT}</code>.</p>
    </main>
  </body>
</html>`;
}

function sendError(res, error) {
  const statusCode = error.status || 500;
  res.status(statusCode).json({
    error: error.message || "Unknown error",
  });
}

app.get("/", async (_req, res) => {
  const configured = hasOAuthConfig();
  const authenticated = Boolean(await readStoredTokens());
  res.type("html").send(renderHomePage({ configured, authenticated }));
});

app.get("/api/status", async (_req, res) => {
  res.json({
    configured: hasOAuthConfig(),
    authenticated: Boolean(await readStoredTokens()),
    redirectUri: getRedirectUri(),
    serverUrl: `http://${HOST}:${PORT}`,
    expectedChannelTitle: EXPECTED_CHANNEL_TITLE,
    outputDirectory: OUTPUT_DIRECTORY,
  });
});

app.get("/auth/start", (req, res) => {
  try {
    const authClient = createOAuthClient();
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;

    const authUrl = authClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: YOUTUBE_SCOPES,
      state,
    });

    res.redirect(authUrl);
  } catch (error) {
    res.status(error.status || 500).type("html").send(`<pre>${error.message}</pre>`);
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    const expectedState = req.session.oauthState;
    const returnedState = req.query.state;
    const code = req.query.code;

    if (!expectedState || returnedState !== expectedState) {
      const error = new Error("OAuth state did not match the original request.");
      error.status = 400;
      throw error;
    }

    if (typeof code !== "string" || !code) {
      const error = new Error("OAuth callback did not include an authorization code.");
      error.status = 400;
      throw error;
    }

    const authClient = createOAuthClient();
    const { tokens } = await authClient.getToken(code);

    if (!tokens) {
      const error = new Error("Google returned an empty token set.");
      error.status = 500;
      throw error;
    }

    await saveStoredTokens(tokens);
    req.session.oauthState = null;

    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AP Thumbnail Uploader</title>
    <style>
      body {
        font-family: "Segoe UI", system-ui, sans-serif;
        margin: 40px;
        background: #0d1821;
        color: #edf2f7;
      }
      code {
        background: rgba(255, 255, 255, 0.08);
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <h1>YouTube connected</h1>
    <p>The local uploader now has a refresh token saved at <code>server/.data/youtube-tokens.json</code>.</p>
    <p>Return to Adobe XD and continue from the plugin panel.</p>
  </body>
</html>`);
  } catch (error) {
    res.status(error.status || 500).type("html").send(`<pre>${error.message}</pre>`);
  }
});

app.post("/api/video/resolve", async (req, res) => {
  try {
    const videoInput = requireText(req.body.videoInput, "videoInput");
    const videoId = extractVideoId(videoInput);
    const youtube = await getYouTubeClient();
    const response = await youtube.videos.list({
      part: ["snippet"],
      id: [videoId],
    });

    const item = response.data.items && response.data.items[0];

    if (!item || !item.snippet) {
      const error = new Error(`No YouTube video was found for ID "${videoId}".`);
      error.status = 404;
      throw error;
    }

    const { courseName, lessonTitle } = splitVideoTitle(item.snippet.title || "");
    const warnings = [];

    if (
      EXPECTED_CHANNEL_TITLE &&
      item.snippet.channelTitle &&
      item.snippet.channelTitle !== EXPECTED_CHANNEL_TITLE
    ) {
      warnings.push(
        `Expected channel "${EXPECTED_CHANNEL_TITLE}", but this video is from "${item.snippet.channelTitle}".`,
      );
    }

    res.json({
      videoId,
      videoInput,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: item.snippet.title || "",
      courseName,
      lessonTitle,
      description: item.snippet.description || "",
      channelTitle: item.snippet.channelTitle || "",
      warnings,
      outputFileName: sanitizeFileName(item.snippet.title || videoId),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/upload-thumbnail", async (req, res) => {
  try {
    const videoId = requireText(req.body.videoId, "videoId");
    const imageBase64 = requireText(req.body.imageBase64, "imageBase64");
    const outputFileName =
      typeof req.body.outputFileName === "string" && req.body.outputFileName.trim()
        ? req.body.outputFileName.trim()
        : videoId;
    const mimeType =
      typeof req.body.mimeType === "string" && req.body.mimeType.trim()
        ? req.body.mimeType.trim()
        : "image/png";

    const thumbnailBuffer = Buffer.from(stripDataUrlPrefix(imageBase64), "base64");

    if (thumbnailBuffer.length > MAX_THUMBNAIL_BYTES) {
      const error = new Error(
        "The rendered thumbnail is larger than YouTube's 2 MB limit. Resize or compress it before upload.",
      );
      error.status = 400;
      throw error;
    }

    const savedPath = await saveOutputCopy(thumbnailBuffer, outputFileName);
    const youtube = await getYouTubeClient();
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType,
        body: Readable.from(thumbnailBuffer),
      },
    });

    res.json({
      ok: true,
      videoId,
      bytesUploaded: thumbnailBuffer.length,
      savedPath,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/logout", async (_req, res) => {
  try {
    await fs.rm(TOKEN_FILE, { force: true });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`AP thumbnail uploader listening on http://${HOST}:${PORT}`);
  console.log(`OAuth redirect URI: ${getRedirectUri()}`);
});
