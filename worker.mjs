import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

import {
  extractVideoId,
  splitVideoTitle,
  toBase64,
} from "./thumbnail-common.mjs";
import { createThumbnailService } from "./thumbnail-service.mjs";

const AUTH_COOKIE_NAME = "ap_thumbnail_auth";
const AUTH_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

let servicePromise = null;
let cryptoKeysPromise = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function fail(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function authRequired(message = "YouTube authorization is required.") {
  const error = fail(message, 401);
  error.needsAuth = true;
  return error;
}

function base64UrlEncode(bytes) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4 || 4)) % 4;
  const binary = atob(`${padded}${"=".repeat(padLength)}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = {};

  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (!rawName) {
      continue;
    }

    cookies[rawName] = rawValue.join("=");
  }

  return cookies;
}

function serializeCookie(name, value, maxAge) {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function clearAuthCookie() {
  return serializeCookie(AUTH_COOKIE_NAME, "", 0);
}

function getAllowedOrigin(request, env) {
  const explicit = String(env.ALLOWED_ORIGIN || "").trim();

  if (explicit) {
    return explicit;
  }

  const origin = request.headers.get("Origin");

  if (!origin) {
    return "*";
  }

  try {
    const hostname = new URL(origin).hostname;

    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return origin;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function applyCors(headers, request, env) {
  const allowedOrigin = getAllowedOrigin(request, env);

  if (!allowedOrigin) {
    return;
  }

  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");

  if (allowedOrigin !== "*") {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
}

function json(data, init = {}, request, env) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  applyCors(headers, request, env);

  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

async function getCryptoKeys(env) {
  if (!cryptoKeysPromise) {
    cryptoKeysPromise = (async () => {
      const secret = String(env.SESSION_SECRET || "").trim();

      if (!secret) {
        throw fail("Set SESSION_SECRET on the worker before using YouTube auth.", 500);
      }

      const secretBytes = textEncoder.encode(secret);
      const digest = await crypto.subtle.digest("SHA-256", secretBytes);

      return {
        hmacKey: await crypto.subtle.importKey(
          "raw",
          secretBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
        aesKey: await crypto.subtle.importKey(
          "raw",
          digest,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      };
    })();
  }

  return cryptoKeysPromise;
}

async function signState(env, payload) {
  const { hmacKey } = await getCryptoKeys(env);
  const body = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, textEncoder.encode(body)),
  );
  return `${body}.${base64UrlEncode(signature)}`;
}

async function readState(env, value) {
  const [body, signature] = String(value || "").split(".");

  if (!body || !signature) {
    throw fail("Invalid OAuth state.", 400);
  }

  const { hmacKey } = await getCryptoKeys(env);
  const valid = await crypto.subtle.verify(
    "HMAC",
    hmacKey,
    base64UrlDecode(signature),
    textEncoder.encode(body),
  );

  if (!valid) {
    throw fail("OAuth state verification failed.", 400);
  }

  const payload = JSON.parse(textDecoder.decode(base64UrlDecode(body)));

  if (!payload.issuedAt || Date.now() - payload.issuedAt > AUTH_STATE_TTL_MS) {
    throw fail("OAuth state expired. Start again.", 400);
  }

  return payload;
}

async function sealAuth(env, payload) {
  const { aesKey } = await getCryptoKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      aesKey,
      plaintext,
    ),
  );

  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function openAuth(env, value) {
  const [ivPart, ciphertextPart] = String(value || "").split(".");

  if (!ivPart || !ciphertextPart) {
    throw fail("Invalid auth cookie.", 401);
  }

  const { aesKey } = await getCryptoKeys(env);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(ivPart),
    },
    aesKey,
    base64UrlDecode(ciphertextPart),
  );

  return JSON.parse(textDecoder.decode(new Uint8Array(plaintext)));
}

async function getStoredRefreshToken(request, env) {
  const authCookie = parseCookies(request)[AUTH_COOKIE_NAME];

  if (!authCookie) {
    return null;
  }

  try {
    const payload = await openAuth(env, authCookie);
    return payload.refreshToken || null;
  } catch (_error) {
    return null;
  }
}

async function readAsset(env, assetPath) {
  const pathname = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${pathname}`));

  if (!response.ok) {
    throw fail(`Missing asset: ${assetPath}`, 500);
  }

  return response;
}

async function getThumbnailService(env) {
  if (!servicePromise) {
    servicePromise = (async () => {
      const templatesText = await (await readAsset(env, "templates.json")).text();
      const pack = JSON.parse(templatesText);
      const fontBuffer = new Uint8Array(
        await (await readAsset(env, pack.font.assetPath)).arrayBuffer(),
      );

      return createThumbnailService({
        templatesText,
        fontBuffer,
        loadBinaryAsset: async (assetPath) =>
          new Uint8Array(await (await readAsset(env, assetPath)).arrayBuffer()),
        loadWasm: () => resvgWasm,
        fallbackCourseName: env.FALLBACK_COURSE_NAME,
      });
    })();
  }

  return servicePromise;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_error) {
    throw fail("Request body must be valid JSON.", 400);
  }
}

function getRedirectUri(request) {
  return new URL("/auth/callback", request.url).toString();
}

function normalizeReturnTo(value, env) {
  if (!value) {
    throw fail("returnTo is required to complete the auth flow.", 400);
  }

  const returnTo = new URL(value);

  if (!["http:", "https:"].includes(returnTo.protocol)) {
    throw fail("returnTo must be an http or https URL.", 400);
  }

  const allowedOrigin = String(env.ALLOWED_ORIGIN || "").trim();

  if (allowedOrigin) {
    if (returnTo.origin !== allowedOrigin) {
      throw fail("returnTo must match ALLOWED_ORIGIN.", 400);
    }
  } else if (!["127.0.0.1", "localhost"].includes(returnTo.hostname)) {
    throw fail("Set ALLOWED_ORIGIN before using auth on a deployed frontend.", 500);
  }

  return returnTo.toString();
}

async function buildAuthUrl(request, env, returnTo) {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    throw fail("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET on the worker.", 500);
  }

  const state = await signState(env, {
    issuedAt: Date.now(),
    returnTo: normalizeReturnTo(returnTo, env),
  });
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.YOUTUBE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getRedirectUri(request));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("scope", AUTH_SCOPE);
  authUrl.searchParams.set("state", state);
  return authUrl.toString();
}

async function resolveVideo(videoInput) {
  const videoId = extractVideoId(videoInput);
  const oembedUrl = new URL("https://www.youtube.com/oembed");
  oembedUrl.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  oembedUrl.searchParams.set("format", "json");

  const response = await fetch(oembedUrl);

  if (!response.ok) {
    throw fail(`Could not resolve video metadata for ${videoId}.`, 404);
  }

  const payload = await response.json();
  const title = payload.title || "";
  const { courseName, lessonTitle } = splitVideoTitle(title);

  return {
    videoId,
    title,
    courseName,
    lessonTitle,
  };
}

async function getAccessToken(env, refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const message = await response.text();

    if (response.status === 400 || message.includes("invalid_grant")) {
      throw authRequired("Your YouTube session expired. Authorize again.");
    }

    throw fail(`Google token refresh failed: ${message}`, 502);
  }

  const payload = await response.json();

  if (!payload.access_token) {
    throw authRequired("No access token was returned by Google.");
  }

  return payload.access_token;
}

async function uploadThumbnail(accessToken, videoId, buffer) {
  const uploadUrl = new URL("https://www.googleapis.com/upload/youtube/v3/thumbnails/set");
  uploadUrl.searchParams.set("videoId", videoId);
  uploadUrl.searchParams.set("uploadType", "media");

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "image/png",
    },
    body: buffer,
  });

  if (!response.ok) {
    const message = await response.text();
    throw fail(`YouTube thumbnail upload failed: ${message}`, response.status);
  }
}

async function renderAndUpload(videoInput, env, refreshToken) {
  const service = await getThumbnailService(env);
  const video = await resolveVideo(videoInput);
  const renderResult = await service.renderThumbnail({
    courseName: video.courseName,
    lessonTitle: video.lessonTitle,
  });
  const accessToken = await getAccessToken(env, refreshToken);
  await uploadThumbnail(accessToken, video.videoId, renderResult.buffer);

  return {
    video,
    template: renderResult.template,
    previewDataUrl: `data:image/png;base64,${toBase64(renderResult.buffer)}`,
  };
}

async function authRequiredResponse(returnTo, request, env, clearCookie = false) {
  const headers = new Headers();

  if (clearCookie) {
    headers.set("Set-Cookie", clearAuthCookie());
  }

  return json(
    {
      needsAuth: true,
      authUrl: await buildAuthUrl(request, env, returnTo),
    },
    {
      status: 401,
      headers,
    },
    request,
    env,
  );
}

async function handleAuthCallback(request, env) {
  const requestUrl = new URL(request.url);
  let fallbackUrl = String(env.FRONTEND_FALLBACK_URL || "").trim();

  try {
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");

    if (!code || !state) {
      throw fail("Google callback did not include a code or state.", 400);
    }

    const payload = await readState(env, state);
    fallbackUrl = payload.returnTo;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({
        code,
        client_id: env.YOUTUBE_CLIENT_ID,
        client_secret: env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: getRedirectUri(request),
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      throw fail(`Token exchange failed: ${await tokenResponse.text()}`, 502);
    }

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      throw fail("Google did not return a refresh token.", 502);
    }

    const redirectTo = new URL(payload.returnTo);
    redirectTo.searchParams.set("auth", "done");
    const headers = new Headers({
      Location: redirectTo.toString(),
      "Set-Cookie": serializeCookie(
        AUTH_COOKIE_NAME,
        await sealAuth(env, {
          refreshToken: tokens.refresh_token,
        }),
        AUTH_MAX_AGE_SECONDS,
      ),
    });
    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (error) {
    if (!fallbackUrl) {
      return new Response(error.message || "Authorization failed.", {
        status: error.status || 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const fallback = new URL(fallbackUrl);
    fallback.searchParams.set("auth", "error");
    fallback.searchParams.set("message", error.message || "Authorization failed.");
    return Response.redirect(fallback, 302);
  }
}

async function handleApi(request, env) {
  const requestUrl = new URL(request.url);

  if (request.method === "POST" && requestUrl.pathname === "/api/run") {
    const body = await readJson(request);
    const returnTo = normalizeReturnTo(body.returnTo, env);
    const refreshToken = await getStoredRefreshToken(request, env);

    if (!refreshToken) {
      return authRequiredResponse(returnTo, request, env);
    }

    try {
      return json(
        await renderAndUpload(body.videoInput, env, refreshToken),
        {},
        request,
        env,
      );
    } catch (error) {
      if (error.needsAuth) {
        return authRequiredResponse(returnTo, request, env, true);
      }

      throw error;
    }
  }

  throw fail("Not found.", 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const headers = new Headers();
      applyCors(headers, request, env);
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    const requestUrl = new URL(request.url);

    try {
      if (request.method === "GET" && requestUrl.pathname === "/auth/callback") {
        return await handleAuthCallback(request, env);
      }

      return await handleApi(request, env);
    } catch (error) {
      return json(
        {
          error: error.message || "Unknown error",
        },
        {
          status: error.status || 500,
        },
        request,
        env,
      );
    }
  },
};
