
const {
  readJSON
} = require("../lib/github-storage");

const {
  normalizeUsername,
  normalizeEmail,
  verifyPassword,
  setSessionCookie,
  createPersistentSessionToken,
  setCors
} = require("../lib/auth");

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  if (
    !process.env.TUNEVA_FRONTEND_ORIGIN ||
    req.headers.origin !== process.env.TUNEVA_FRONTEND_ORIGIN
  ) {
    return send(res, 403, {
      ok: false,
      message: "Origin not allowed."
    });
  }

  try {
    const identity = String(req.body?.identity || "").trim();
    const password = String(req.body?.password || "");

    if (!identity || !password) {
      return send(res, 400, {
        ok: false,
        message: "Enter your username/email and password."
      });
    }

    const file = await readJSON("data/users.json", {
      users: []
    });

    const users = Array.isArray(file.data?.users)
      ? file.data.users
      : [];

    const normalizedIdentity = normalizeUsername(identity);
    const normalizedEmail = normalizeEmail(identity);

    const user = users.find(item =>
      normalizeUsername(item.username) === normalizedIdentity ||
      normalizeEmail(item.email) === normalizedEmail
    );

    if (
      !user ||
      user.status !== "active" ||
      !user.passwordHash
    ) {
      return send(res, 401, {
        ok: false,
        message: "Invalid login details."
      });
    }

    const passwordMatches = await verifyPassword(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return send(res, 401, {
        ok: false,
        message: "Invalid login details."
      });
    }

    const authToken = createPersistentSessionToken(user);

    setSessionCookie(res, user);

    return send(res, 200, {
      ok: true,
      authToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        phone: user.phone,
        status: user.status
      }
    });

  } catch (error) {
    console.error("[TUNEVA LOGIN]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to sign in right now."
    });
  }
};
