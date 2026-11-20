
const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const {
  verifySessionToken,
  verifyPersistentSessionToken,
  getBearerToken,
  getCookie,
  setCors
} = require("../lib/auth");

const USERS_FILE = "data/users.json";
const EARNINGS_FILE = "data/earnings.json";
const SETTINGS_FILE = "data/admin-settings.json";

const INITIAL_BALANCE = 0;
const MAX_BATCH_SIZE = 100;
const MAX_SAVE_ATTEMPTS = 4;

const DEFAULT_SETTINGS = {
  tapPoints: 350,
  tapReward: 100,
  dailyTapLimit: 3000,
  videoReward: 1750
};

const VIDEO_TITLES = {
  "seyi-vibes": "Seyi Vibes",
  "bigger-escapes": "For Bigger Escapes",
  "bigger-fun": "For Bigger Fun",
  "bigger-joyrides": "For Bigger Joyrides"
};

function send(res, status, data) {
  return res.status(status).json(data);
}

function getSettings(data) {
  const saved = data && typeof data === "object" ? data : {};

  function valid(value, fallback, max) {
    return Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= max
      ? value
      : fallback;
  }

  return {
    tapPoints: valid(saved.tapPoints, DEFAULT_SETTINGS.tapPoints, 1000000),
    tapReward: valid(saved.tapReward, DEFAULT_SETTINGS.tapReward, 1000000),
    dailyTapLimit: valid(saved.dailyTapLimit, DEFAULT_SETTINGS.dailyTapLimit, 100000000),
    videoReward: valid(saved.videoReward, DEFAULT_SETTINGS.videoReward, 1000000)
  };
}

async function loadSettings() {
  const result = await readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
  return getSettings(result.data);
}

function todayInNigeria() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function createId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 12)
  );
}

function newAccount() {
  return {
    balance: INITIAL_BALANCE,
    todayDate: todayInNigeria(),
    todayEarnings: 0,
    tapPoints: 0,
    tapCount: 0,
    tapDailyPoints: 0,
    tapDailyEarnings: 0,
    videoEarnings: 0,
    claimedVideos: [],
    processedEvents: [],
    history: [],
    lastTapAt: 0
  };
}

function normalizeAccount(account) {
  const fresh = newAccount();

  const saved = account && typeof account === "object"
    ? account
    : {};

  return {
    ...fresh,
    ...saved,

    claimedVideos: Array.isArray(saved.claimedVideos)
      ? saved.claimedVideos
      : [],

    processedEvents: Array.isArray(saved.processedEvents)
      ? saved.processedEvents
      : [],

    history: Array.isArray(saved.history)
      ? saved.history
      : []
  };
}

function resetDailyIfNeeded(account) {
  const today = todayInNigeria();

  if (account.todayDate !== today) {
    account.todayDate = today;
    account.todayEarnings = 0;
    account.tapDailyPoints = 0;
    account.tapDailyEarnings = 0;
    return true;
  }

  return false;
}

function publicAccount(account, settings) {
  return {
    balance: account.balance,
    todayEarnings: account.todayEarnings,
    tapPoints: account.tapPoints,
    tapCount: account.tapCount,
    tapDailyPoints: account.tapDailyPoints,
    tapDailyEarnings: account.tapDailyEarnings,
    tapLimitReached:
      account.tapDailyEarnings >= settings.dailyTapLimit,
    videoEarnings: account.videoEarnings,
    claimedVideos: account.claimedVideos,
    history: account.history,

    settings: {
      tapPoints: settings.tapPoints,
      tapReward: settings.tapReward,
      dailyTapLimit: settings.dailyTapLimit,
      videoReward: settings.videoReward
    }
  };
}

function validEventId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

function isGitHubConflict(error) {
  return /(?:409|422)/.test(String(error.message || ""));
}

function normalizeEvents(body) {
  if (Array.isArray(body.events)) {
    return body.events;
  }

  if (body.action) {
    return [{
      eventId: body.eventId,
      action: body.action,
      videoId: body.videoId
    }];
  }

  return [];
}

function processBatch(account, events, settings) {
  const processed = new Set(account.processedEvents);

  const result = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    limitReached: false
  };

  const seenInBatch = new Set();

  for (const event of events) {
    if (
      !event ||
      typeof event !== "object" ||
      !validEventId(event.eventId) ||
      !["tap", "video"].includes(event.action)
    ) {
      result.rejected++;
      continue;
    }

    const eventId = event.eventId;

    if (
      processed.has(eventId) ||
      seenInBatch.has(eventId)
    ) {
      result.duplicates++;
      continue;
    }

    seenInBatch.add(eventId);

    if (event.action === "tap") {
      if (
        account.tapDailyEarnings + settings.tapReward >
        settings.dailyTapLimit
      ) {
        result.limitReached = true;
        result.rejected++;
        continue;
      }

      account.tapPoints += settings.tapPoints;
      account.tapCount += 1;

      account.tapDailyPoints += settings.tapPoints;
      account.tapDailyEarnings += settings.tapReward;

      account.balance += settings.tapReward;
      account.todayEarnings += settings.tapReward;

      account.history.unshift({
        id: eventId,
        title: "Tap Rewards",
        subtitle: "Tap Tap",
        amount: settings.tapReward,
        date: new Date().toISOString(),
        currency: "NGN"
      });

    } else if (event.action === "video") {
      const videoId = String(event.videoId || "");
      const title = VIDEO_TITLES[videoId];

      if (!title || account.claimedVideos.includes(videoId)) {
        result.rejected++;
        continue;
      }

      account.claimedVideos.push(videoId);

      account.videoEarnings += settings.videoReward;
      account.balance += settings.videoReward;
      account.todayEarnings += settings.videoReward;

      account.history.unshift({
        id: eventId,
        title: "Video Rewards",
        subtitle: title,
        amount: settings.videoReward,
        date: new Date().toISOString(),
        currency: "NGN"
      });
    }

    account.processedEvents.push(eventId);
    processed.add(eventId);

    result.accepted++;
  }

  account.processedEvents =
    account.processedEvents.slice(-5000);

  account.history =
    account.history.slice(0, 500);

  return result;
}

async function saveBatchWithRetry(userId, events, settings) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= MAX_SAVE_ATTEMPTS;
    attempt++
  ) {
    try {
      const earningsResult = await readJSON(
        EARNINGS_FILE,
        { users: {} }
      );

      const database =
        earningsResult.data &&
        typeof earningsResult.data === "object"
          ? earningsResult.data
          : { users: {} };

      if (
        !database.users ||
        typeof database.users !== "object"
      ) {
        database.users = {};
      }

      const account = normalizeAccount(
        database.users[userId]
      );

      resetDailyIfNeeded(account);

      const batchResult = processBatch(
        account,
        events,
        settings
      );

      database.users[userId] = account;

      await writeJSON(
        EARNINGS_FILE,
        database,
        earningsResult.sha
      );

      return {
        ...batchResult,
        earnings: publicAccount(account, settings)
      };

    } catch (error) {
      lastError = error;

      if (
        !isGitHubConflict(error) ||
        attempt === MAX_SAVE_ATTEMPTS
      ) {
        throw error;
      }

      console.warn(
        "[TUNEVA EARNINGS] GitHub conflict. Retrying:",
        attempt
      );
    }
  }

  throw lastError;
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  const allowedOrigin = process.env.TUNEVA_FRONTEND_ORIGIN;

  if (
    allowedOrigin &&
    req.headers.origin &&
    req.headers.origin !== allowedOrigin
  ) {
    return send(res, 403, {
      ok: false,
      message: "Origin not allowed."
    });
  }

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
    // AUTHENTICATION

    const bearerToken = getBearerToken(req);

    let session = null;
    let persistentSession = false;

    if (bearerToken) {
      session = verifyPersistentSessionToken(bearerToken);
      persistentSession = Boolean(session);
    }

    if (!session) {
      const cookieToken = getCookie(req, "tuneva_session");
      session = verifySessionToken(cookieToken);
    }

    if (!session || !session.sub) {
      return send(res, 401, {
        ok: false,
        message: "Please log in again."
      });
    }

    const usersResult = await readJSON(USERS_FILE, {
      users: []
    });

    const users = Array.isArray(usersResult.data)
      ? usersResult.data
      : Array.isArray(usersResult.data?.users)
        ? usersResult.data.users
        : [];

    const user = users.find(function (item) {
      return (
        item.id === session.sub &&
        item.status === "active"
      );
    });

    if (!user) {
      return send(res, 401, {
        ok: false,
        message: "Your account could not be verified."
      });
    }

    if (
      persistentSession &&
      Number(user.sessionVersion || 1) !== session.v
    ) {
      return send(res, 401, {
        ok: false,
        message: "Your browser session is no longer valid."
      });
    }

    const settings = await loadSettings();

    // GET: READ EARNINGS

    if (req.method === "GET") {
      const earningsResult = await readJSON(
        EARNINGS_FILE,
        { users: {} }
      );

      const database =
        earningsResult.data &&
        typeof earningsResult.data === "object"
          ? earningsResult.data
          : { users: {} };

      const exists =
        database.users &&
        Object.prototype.hasOwnProperty.call(
          database.users,
          user.id
        );

      const account = normalizeAccount(
        exists ? database.users[user.id] : null
      );

      const wasReset = resetDailyIfNeeded(account);

      if (exists && wasReset) {
        if (!database.users || typeof database.users !== "object") {
          database.users = {};
        }

        database.users[user.id] = account;

        await writeJSON(
          EARNINGS_FILE,
          database,
          earningsResult.sha
        );
      }

      return send(res, 200, {
        ok: true,
        earnings: publicAccount(account, settings)
      });
    }

    // POST: BATCH EARNINGS

    const body = req.body || {};
    const events = normalizeEvents(body);

    if (
      !events.length ||
      events.length > MAX_BATCH_SIZE
    ) {
      return send(res, 400, {
        ok: false,
        message: "Submit between 1 and 100 reward events."
      });
    }

    for (const event of events) {
      if (
        !event ||
        typeof event !== "object" ||
        !validEventId(event.eventId) ||
        !["tap", "video"].includes(event.action)
      ) {
        return send(res, 400, {
          ok: false,
          message: "Invalid reward event in batch."
        });
      }
    }

    const result = await saveBatchWithRetry(
      user.id,
      events,
      settings
    );

    return send(res, 200, {
      ok: true,
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
      limitReached: result.limitReached,
      message: result.limitReached
        ? "Your daily Tap Tap earnings limit has been reached."
        : undefined,
      earnings: result.earnings
    });

  } catch (error) {
    console.error("[TUNEVA EARNINGS]", error);

    return send(res, 500, {
      ok: false,
      message: "Unable to save earnings. Please try again."
    });
  }
};
