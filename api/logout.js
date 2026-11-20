
const {
  clearSessionCookie,
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

  clearSessionCookie(res);

  return send(res, 200, {
    ok: true,
    message: "Logged out successfully."
  });
};
