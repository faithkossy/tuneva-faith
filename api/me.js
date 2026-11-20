const {
  readJSON
} = require("../lib/github-storage");

const {
  getCookie,
  verifySessionToken,
  setCors
} = require("../lib/auth");

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
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
    const token = getCookie(req, "tuneva_session");
    const session = verifySessionToken(token);

    if (!session) {
      return send(res, 401, {
        ok: false,
        message: "Not signed in."
      });
    }

    const file = await readJSON("data/users.json", {
      users: []
    });

    const users = Array.isArray(file.data?.users)
      ? file.data.users
      : [];

    const user = users.find(item =>
      item.id === session.sub &&
      item.status === "active"
    );

    if (!user) {
      return send(res, 401, {
        ok: false,
        message: "Account not found."
      });
    }

    return send(res, 200, {
      ok: true,
      user: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        email: user.email
      }
    });

  } catch (error) {
    console.error("[TUNEVA SESSION]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to verify your session."
    });
  }
};
