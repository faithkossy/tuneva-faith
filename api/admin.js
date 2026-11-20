
const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const SETTINGS_FILE = "data/admin-settings.json";

const DEFAULT_SETTINGS = {
  activationPrices: [5300, 9300],
  tapPoints: 350,
  tapReward: 100,
  dailyTapLimit: 3000,
  videoReward: 1750,
  withdrawalsEnabled: true
};

const ALLOWED_ORIGINS = new Set([
  "https://api.tunevamobile.com.ng",
  process.env.TUNEVA_ADMIN_ORIGIN,
  process.env.TUNEVA_FRONTEND_ORIGIN
].filter(Boolean));

function send(res, status, data) {
  return res.status(status).json(data);
}

function validAmount(value, min, max) {
  return (
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const prices = body.activationPrices;

  if (
    !Array.isArray(prices) ||
    prices.length !== 2 ||
    !prices.every(value => validAmount(value, 100, 1000000)) ||
    prices[0] === prices[1]
  ) {
    return null;
  }

  if (!validAmount(body.tapPoints, 1, 1000000)) return null;
  if (!validAmount(body.tapReward, 1, 1000000)) return null;
  if (!validAmount(body.dailyTapLimit, 1, 100000000)) return null;
  if (!validAmount(body.videoReward, 1, 1000000)) return null;

  const settings = {
    activationPrices: prices,
    tapPoints: body.tapPoints,
    tapReward: body.tapReward,
    dailyTapLimit: body.dailyTapLimit,
    videoReward: body.videoReward
  };

  if (Object.prototype.hasOwnProperty.call(body, "withdrawalsEnabled")) {
    if (typeof body.withdrawalsEnabled !== "boolean") {
      return null;
    }

    settings.withdrawalsEnabled = body.withdrawalsEnabled;
  }

  return settings;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, {
      ok: false,
      message: "Origin not allowed."
    });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");

    return send(res, 405, {
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    if (req.method === "GET") {
      const stored = await readJSON(
        SETTINGS_FILE,
        DEFAULT_SETTINGS
      );

      const settings = {
        ...DEFAULT_SETTINGS,
        ...(stored.data || {})
      };

      return send(res, 200, {
        ok: true,
        settings
      });
    }

    const settings = validateSettings(req.body);

    if (!settings) {
      return send(res, 400, {
        ok: false,
        message: "Invalid settings. Check the values and try again."
      });
    }

    const stored = await readJSON(
      SETTINGS_FILE,
      DEFAULT_SETTINGS
    );

    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      ...(stored.data || {}),
      ...settings,
      updatedAt: new Date().toISOString()
    };

    await writeJSON(
      SETTINGS_FILE,
      updatedSettings,
      stored.sha
    );

    return send(res, 200, {
      ok: true,
      message: "Admin settings updated.",
      settings: updatedSettings
    });

  } catch (error) {
    console.error("[TUNEVA ADMIN]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to process the admin request."
    });
  }
};
