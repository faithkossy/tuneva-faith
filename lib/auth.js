
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const SESSION_SECRET = process.env.AUTH_SESSION_SECRET;
const PERSISTENT_SECRET = process.env.TUNEVA_SESSION_SECRET;

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_]{3,20}$/.test(value);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);

  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, key] = String(storedHash || "").split(":");

  if (!salt || !key || !/^[a-f0-9]{128}$/i.test(key)) {
    return false;
  }

  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, "hex");

  return (
    derived.length === expected.length &&
    crypto.timingSafeEqual(derived, expected)
  );
}

// EXISTING COOKIE SESSION

function createSessionToken(user) {
  if (!SESSION_SECRET) {
    throw new Error("AUTH_SESSION_SECRET is not configured.");
  }

  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    username: user.username,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!SESSION_SECRET || !token) return null;

  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "base64url");
  } catch (_) {
    return null;
  }

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!data.sub || !data.exp || data.exp < Date.now()) {
      return null;
    }

    return data;
  } catch (_) {
    return null;
  }
}

// PERSISTENT BROWSER SESSION

function createPersistentSessionToken(user) {
  if (!PERSISTENT_SECRET || PERSISTENT_SECRET.length < 32) {
    throw new Error("TUNEVA_SESSION_SECRET must contain at least 32 characters.");
  }

  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id),
    v: Number(user.sessionVersion || 1)
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", PERSISTENT_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyPersistentSessionToken(token) {
  if (
    !PERSISTENT_SECRET ||
    PERSISTENT_SECRET.length < 32 ||
    !token
  ) {
    return null;
  }

  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", PERSISTENT_SECRET)
    .update(payload)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "base64url");
  } catch (_) {
    return null;
  }

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !data.sub ||
      !Number.isInteger(data.v) ||
      data.v < 1
    ) {
      return null;
    }

    return data;
  } catch (_) {
    return null;
  }
}

function getBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

// COOKIE HELPERS

function getCookie(req, name) {
  const header = String(req.headers.cookie || "");

  const item = header
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(name + "="));

  return item
    ? decodeURIComponent(item.slice(name.length + 1))
    : "";
}

function setSessionCookie(res, user) {
  const token = createSessionToken(user);

  res.setHeader(
    "Set-Cookie",
    `tuneva_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "tuneva_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  );
}

// CORS

function setCors(req, res) {
  const allowedOrigin = process.env.TUNEVA_FRONTEND_ORIGIN;
  const origin = req.headers.origin;

  if (allowedOrigin && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader("Cache-Control", "no-store");
}

module.exports = {
  normalizeUsername,
  normalizeEmail,
  validUsername,
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  createPersistentSessionToken,
  verifyPersistentSessionToken,
  getBearerToken,
  getCookie,
  setSessionCookie,
  clearSessionCookie,
  setCors
};
