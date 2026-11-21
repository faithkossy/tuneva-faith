
const crypto = require("crypto");

const { readJSON } = require("../../lib/github-storage");

const {
  createPersistentSessionToken
} = require("../../lib/auth");

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    const { paymentId, statusToken } = req.body || {};

    if (
      typeof paymentId !== "string" ||
      typeof statusToken !== "string" ||
      !paymentId ||
      !/^[a-f0-9]{64}$/i.test(statusToken)
    ) {
      return send(res, 400, { ok: false });
    }

    const paymentFile = await readJSON("data/payments.json", {
      payments: []
    });

    const payments = Array.isArray(paymentFile.data?.payments)
      ? paymentFile.data.payments
      : [];

    const payment = payments.find(
      item => String(item.id || "") === paymentId
    );

    if (
      !payment ||
      !payment.statusTokenHash ||
      payment.activation !== true ||
      String(payment.provider || "").toLowerCase() !== "movantra" ||
      String(payment.method || "").toLowerCase() !== "paga"
    ) {
      return send(res, 404, { ok: false });
    }

    const submittedHash = crypto
      .createHash("sha256")
      .update(statusToken)
      .digest();

    let savedHash;

    try {
      savedHash = Buffer.from(
        String(payment.statusTokenHash),
        "hex"
      );
    } catch (_) {
      return send(res, 403, { ok: false });
    }

    if (
      savedHash.length !== submittedHash.length ||
      savedHash.length !== 32 ||
      !crypto.timingSafeEqual(savedHash, submittedHash)
    ) {
      return send(res, 403, { ok: false });
    }

    const status = String(
      payment.status || "pending"
    ).toLowerCase();

    if (status !== "approved") {
      return send(res, 200, {
        ok: true,
        status,
        amount: Number(payment.amount || 0),
        reference: payment.reference || null
      });
    }

    if (payment.activationConflict === true) {
      return send(res, 403, {
        ok: false,
        status: "rejected",
        message: "This payment requires manual review."
      });
    }

    const usersFile = await readJSON("data/users.json", {
      users: []
    });

    const users = Array.isArray(usersFile.data?.users)
      ? usersFile.data.users
      : [];

    const user = users.find(item =>
      String(item.paymentId || "") === paymentId &&
      String(item.status || "").toLowerCase() === "active"
    );

    if (!user) {
      return send(res, 202, {
        ok: true,
        status: "processing",
        amount: Number(payment.amount || 0),
        reference: payment.reference || null
      });
    }

    const authToken = createPersistentSessionToken(user);

    return send(res, 200, {
      ok: true,
      status: "approved",
      amount: Number(payment.amount || 0),
      reference: payment.reference || null,
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
    console.error("[TUNEVA PAYMENT STATUS]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to check payment status."
    });
  }
};
