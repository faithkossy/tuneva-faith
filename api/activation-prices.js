
const { readJSON } = require("../lib/github-storage");

const SETTINGS_FILE = "data/admin-settings.json";
const DEFAULT_PRICES = [5300, 9300];

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.TUNEVA_FRONTEND_ORIGIN;
  const origin = req.headers.origin;

  if (allowedOrigin && origin && origin !== allowedOrigin) {
    return res.status(403).json({
      ok: false,
      message: "Origin not allowed."
    });
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed."
    });
  }

  try {
    const result = await readJSON(SETTINGS_FILE, {});
    const prices = result.data?.activationPrices;

    const valid =
      Array.isArray(prices) &&
      prices.length === 2 &&
      prices.every(value =>
        Number.isSafeInteger(value) &&
        value >= 100 &&
        value <= 1000000
      ) &&
      prices[0] !== prices[1];

    return res.status(200).json({
      ok: true,
      activationPrices: valid ? prices : DEFAULT_PRICES
    });

  } catch (error) {
    console.error("[TUNEVA ACTIVATION PRICES]", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to load activation prices."
    });
  }
};
