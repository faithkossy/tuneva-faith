
(function () {
"use strict";

const dashboard = document.getElementById('tuneva-dashboard');

if (!dashboard || dashboard.dataset.initialized === 'true') return;

dashboard.dataset.initialized = 'true';

const auth = document.getElementById('tuneva-auth');

const API_BASE = 'https://api.tunevamobile.com.ng';
const EARNINGS_API = API_BASE + '/api/earnings';

const SESSION_STORAGE_KEY = 'tuneva_persistent_session';

const EARNINGS_QUEUE_KEY = 'tuneva_pending_earnings_v1';
const EARNINGS_CACHE_KEY = 'tuneva_earnings_snapshot_v1';

const BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;

const FLUSH_INTERVAL = 60000;
const LOAD_CACHE_TTL = 300000;

const DEFAULT_TAP_SETTINGS = {
  tapReward: 100,
  tapPoints: 350,
  dailyTapLimit: 3000,
  videoReward: 1750
};

const themeButton = dashboard.querySelector('#tv-theme-toggle');
const balanceEye = dashboard.querySelector('#tv-balance-eye');
const balanceAmount = dashboard.querySelector('#tv-balance-amount');
const toast = dashboard.querySelector('#tv-dashboard-toast');

const referralLinkElement = dashboard.querySelector('#tv-referral-link');
const copyReferralButton = dashboard.querySelector('#tv-copy-referral');
const copyFeedback = dashboard.querySelector('#tv-copy-feedback');
const referralSeeAll = dashboard.querySelector('#tv-referral-see-all');

const state = {
  referralUsername: '',
  referralUrl: '',
  currentCurrency: 'NGN',
  balanceVisible: true,
  toastTimeout: null,

  earningsLoadPromise: null,
  flushPromise: null,
  flushTimer: null,

  lastLoadAt: 0,
  loadBackoffUntil: 0,
  flushBackoffUntil: 0,

  loadFailures: 0,
  flushFailures: 0,

  isLoggingOut: false,
  sessionEnded: false,

  tapTodayEarnings: 0,
  pendingEvents: [],
  serverEarnings: null,

  balances: {
    NGN: { amount: 0, symbol: '₦' },
    KWD: { amount: null, symbol: 'KWD ' }
  },

  earnings: {
    NGN: '₦0.00',
    KWD: 'KWD —'
  }
};

// =================================
// SESSION
// =================================

function getSavedSession() {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);

    return saved ? JSON.parse(saved) : null;

  } catch (error) {
    return null;
  }
}

function getPersistentToken() {
  const session = getSavedSession();

  return session && typeof session.token === 'string'
    ? session.token
    : '';
}

function getUserStorageKey(base) {
  const session = getSavedSession();

  const userId =
    session && session.user && session.user.id
      ? String(session.user.id)
      : '';

  return userId
    ? base + '_' + encodeURIComponent(userId)
    : base;
}

function getAuthHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const token = getPersistentToken();

  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }

  return headers;
}

function getQueueKey() {
  return getUserStorageKey(EARNINGS_QUEUE_KEY);
}

function getCacheKey() {
  return getUserStorageKey(EARNINGS_CACHE_KEY);
}

// =================================
// DATE
// =================================

function getNigeriaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// =================================
// FORMAT MONEY
// =================================

function formatMoney(amount) {
  return '₦' + (Number(amount) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatBalance(currency) {
  const item = state.balances[currency];

  if (!item || item.amount === null) {
    return 'KWD —';
  }

  return item.symbol + item.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// =================================
// DASHBOARD DISPLAY
// =================================

function updateBalance() {
  if (balanceAmount) {
    balanceAmount.textContent = state.balanceVisible
      ? formatBalance(state.currentCurrency)
      : '••••••••••';
  }

  const earningsElement =
    dashboard.querySelector('#tv-today-earnings');

  if (earningsElement) {
    earningsElement.textContent =
      state.earnings[state.currentCurrency];
  }
}

// =================================
// NOTIFICATIONS
// =================================

function showToast(message) {
  if (!toast) return;

  clearTimeout(state.toastTimeout);

  toast.textContent = message;
  toast.classList.add('show');

  state.toastTimeout = setTimeout(function () {
    toast.classList.remove('show');
  }, 2800);
}

// =================================
// EVENT IDS
// =================================

function createEventId() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID === 'function'
  ) {
    return window.crypto.randomUUID();
  }

  return 'tv_' + Date.now() + '_' +
    Math.random().toString(36).slice(2);
}

// =================================
// PENDING EARNINGS QUEUE
// =================================

function loadPendingEvents() {
  try {
    const saved = localStorage.getItem(getQueueKey());

    if (!saved) {
      state.pendingEvents = [];
      return;
    }

    const parsed = JSON.parse(saved);

    state.pendingEvents = Array.isArray(parsed)
      ? parsed.filter(function (event) {
          return (
            event &&
            typeof event.eventId === 'string' &&
            ['tap', 'video'].includes(event.action)
          );
        })
      : [];

  } catch (error) {
    console.warn('Tuneva earnings queue could not be loaded:', error);
    state.pendingEvents = [];
  }
}

function persistPendingEvents() {
  try {
    localStorage.setItem(
      getQueueKey(),
      JSON.stringify(state.pendingEvents)
    );
  } catch (error) {
    console.warn('Tuneva earnings queue could not be saved:', error);
  }
}

function getPendingTapCount() {
  return state.pendingEvents.filter(function (event) {
    return event.action === 'tap';
  }).length;
}

function getPendingVideoCount() {
  return state.pendingEvents.filter(function (event) {
    return event.action === 'video';
  }).length;
}

// =================================
// SETTINGS
// =================================

function getTapSettings(snapshot) {
  const settings = snapshot && snapshot.settings
    ? snapshot.settings
    : {};

  function valid(value, fallback) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
      ? number
      : fallback;
  }

  return {
    tapReward: valid(
      settings.tapReward,
      DEFAULT_TAP_SETTINGS.tapReward
    ),

    tapPoints: valid(
      settings.tapPoints,
      DEFAULT_TAP_SETTINGS.tapPoints
    ),

    dailyTapLimit: valid(
      settings.dailyTapLimit,
      DEFAULT_TAP_SETTINGS.dailyTapLimit
    ),

    videoReward: valid(
      settings.videoReward,
      DEFAULT_TAP_SETTINGS.videoReward
    )
  };
}

function formatDailyLimit(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG');
}

// =================================
// SNAPSHOT STORAGE
// =================================

function saveCachedSnapshot() {
  if (!state.serverEarnings) return;

  try {
    localStorage.setItem(
      getCacheKey(),
      JSON.stringify({
        date: getNigeriaDate(),
        savedAt: Date.now(),
        earnings: state.serverEarnings
      })
    );
  } catch (error) {
    console.warn('Tuneva earnings snapshot could not be saved:', error);
  }
}

function loadCachedSnapshot() {
  try {
    const saved = localStorage.getItem(getCacheKey());

    if (!saved) return false;

    const cache = JSON.parse(saved);

    if (
      !cache ||
      !cache.earnings ||
      typeof cache.earnings !== 'object'
    ) {
      return false;
    }

    state.serverEarnings = cache.earnings;
    state.lastLoadAt = Number(cache.savedAt) || 0;

    // Reset daily values when Nigeria's date changes.

    if (cache.date !== getNigeriaDate()) {
      state.serverEarnings.todayEarnings = 0;
      state.serverEarnings.tapDailyPoints = 0;
      state.serverEarnings.tapDailyEarnings = 0;
      state.serverEarnings.tapLimitReached = false;

      saveCachedSnapshot();
    }

    return true;

  } catch (error) {
    console.warn('Tuneva cached earnings could not be read:', error);
    return false;
  }
}

// =================================
// RESPONSE HELPERS
// =================================

function getSnapshot(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return response.earnings ||
    response.data ||
    response.account ||
    response;
}

// =================================
// OPTIMISTIC EARNINGS
// =================================

function getOptimisticSnapshot() {
  const base = state.serverEarnings
    ? Object.assign({}, state.serverEarnings)
    : {
        balance: 0,
        todayEarnings: 0,
        tapPoints: 0,
        tapCount: 0,
        tapDailyPoints: 0,
        tapDailyEarnings: 0,
        videoEarnings: 0,
        claimedVideos: [],
        history: [],
        settings: Object.assign({}, DEFAULT_TAP_SETTINGS)
      };

  const settings = getTapSettings(base);

  const pendingTaps = getPendingTapCount();
  const pendingVideos = getPendingVideoCount();

  const tapReward = settings.tapReward;
  const tapPoints = settings.tapPoints;
  const videoReward = settings.videoReward;

  base.balance = Number(base.balance || 0);
  base.todayEarnings = Number(base.todayEarnings || 0);
  base.tapPoints = Number(base.tapPoints || 0);
  base.tapCount = Number(base.tapCount || 0);
  base.tapDailyPoints = Number(base.tapDailyPoints || 0);
  base.tapDailyEarnings = Number(base.tapDailyEarnings || 0);
  base.videoEarnings = Number(base.videoEarnings || 0);

  base.balance +=
    pendingTaps * tapReward +
    pendingVideos * videoReward;

  base.todayEarnings +=
    pendingTaps * tapReward +
    pendingVideos * videoReward;

  base.tapPoints += pendingTaps * tapPoints;
  base.tapCount += pendingTaps;

  base.tapDailyPoints += pendingTaps * tapPoints;
  base.tapDailyEarnings += pendingTaps * tapReward;

  base.videoEarnings += pendingVideos * videoReward;

  base.settings = Object.assign(
    {},
    base.settings || {},
    settings
  );

  base.claimedVideos = Array.isArray(base.claimedVideos)
    ? base.claimedVideos.slice()
    : [];

  // Include pending video claims locally.

  state.pendingEvents.forEach(function (event) {
    if (
      event.action === 'video' &&
      event.videoId &&
      !base.claimedVideos.includes(event.videoId)
    ) {
      base.claimedVideos.push(event.videoId);
    }
  });

  // Include pending events in local history.

  const history = Array.isArray(base.history)
    ? base.history.slice()
    : [];

  const existingIds = new Set(
    history.map(function (entry) {
      return entry.id || entry.eventId;
    })
  );

  const pendingHistory = [];

  state.pendingEvents.forEach(function (event) {
    if (existingIds.has(event.eventId)) return;

    const isVideo = event.action === 'video';

    pendingHistory.push({
      id: event.eventId,
      title: isVideo ? 'Video Rewards' : 'Tap Rewards',
      subtitle: isVideo
        ? event.videoTitle || 'Video Watching'
        : 'Tap Tap',
      amount: isVideo ? videoReward : tapReward,
      date: event.createdAt || new Date().toISOString(),
      currency: 'NGN'
    });
  });

  base.history = pendingHistory.concat(history).slice(0, 500);

  base.tapLimitReached =
    base.tapDailyEarnings >= settings.dailyTapLimit;

  return base;
}

// =================================
// PUBLISH LOCAL SNAPSHOT
// =================================

function publishOptimisticSnapshot() {
  if (state.sessionEnded || state.isLoggingOut) return;

  const optimistic = getOptimisticSnapshot();

  const balance = Number(optimistic.balance);
  const today = Number(optimistic.todayEarnings);

  if (Number.isFinite(balance)) {
    state.balances.NGN.amount = balance;
  }

  if (Number.isFinite(today)) {
    state.tapTodayEarnings = today;
    state.earnings.NGN = formatMoney(today);
  }

  updateBalance();

  window.dispatchEvent(
    new CustomEvent('tuneva:earnings-updated', {
      detail: optimistic
    })
  );
}

// =================================
// APPLY BACKEND SNAPSHOT
// =================================

function applyEarningsSnapshot(response) {
  if (state.sessionEnded || state.isLoggingOut) return;

  const data = getSnapshot(response);

  if (!data || typeof data !== 'object') return;

  state.serverEarnings = Object.assign({}, data);

  saveCachedSnapshot();

  state.lastLoadAt = Date.now();
  state.loadFailures = 0;
  state.loadBackoffUntil = 0;

  publishOptimisticSnapshot();
}

// =================================
// LOAD BACKEND EARNINGS
// =================================

async function loadBackendEarnings(options) {
  options = options || {};

  if (state.sessionEnded || state.isLoggingOut) {
    return null;
  }

  if (state.earningsLoadPromise) {
    return state.earningsLoadPromise;
  }

  // Use the browser snapshot instead of repeatedly requesting GitHub.

  if (
    !options.force &&
    state.serverEarnings &&
    Date.now() - state.lastLoadAt < LOAD_CACHE_TTL
  ) {
    return {
      ok: true,
      cached: true,
      earnings: getOptimisticSnapshot()
    };
  }

  if (Date.now() < state.loadBackoffUntil) {
    return state.serverEarnings
      ? {
          ok: true,
          cached: true,
          earnings: getOptimisticSnapshot()
        }
      : null;
  }

  state.earningsLoadPromise = (async function () {
    try {
      const response = await fetch(EARNINGS_API, {
        method: 'GET',
        credentials: 'include',
        headers: getAuthHeaders({
          Accept: 'application/json'
        })
      });

      const result = await response.json();

      if (!response.ok || result.ok !== true) {
        throw new Error(
          result.message || 'Could not load earnings.'
        );
      }

      if (!state.sessionEnded && !state.isLoggingOut) {
        applyEarningsSnapshot(result);
      }

      return result;

    } catch (error) {
      state.loadFailures++;

      const delay = Math.min(
        900000,
        30000 * Math.pow(2, Math.min(state.loadFailures - 1, 5))
      );

      state.loadBackoffUntil = Date.now() + delay;

      console.warn('Tuneva earnings load failed:', error);

      // Keep using the saved browser snapshot if GitHub is unavailable.

      if (state.serverEarnings) {
        return {
          ok: true,
          cached: true,
          offline: true,
          earnings: getOptimisticSnapshot()
        };
      }

      return null;

    } finally {
      state.earningsLoadPromise = null;
    }
  })();

  return state.earningsLoadPromise;
}

// =================================
// SEND BATCH
// =================================

async function sendBatch(events, keepalive) {
  const response = await fetch(EARNINGS_API, {
    method: 'POST',
    credentials: 'include',
    keepalive: Boolean(keepalive),

    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }),

    body: JSON.stringify({
      events: events
    })
  });

  const result = await response.json();

  if (!response.ok || result.ok !== true) {
    throw new Error(
      result.message || 'Earnings could not be saved.'
    );
  }

  return result;
}

// =================================
// FLUSH PENDING EVENTS
// =================================

async function flushPendingEarnings(options) {
  options = options || {};

  if (
    state.sessionEnded ||
    state.isLoggingOut ||
    !state.pendingEvents.length
  ) {
    return null;
  }

  if (navigator.onLine === false) {
    return null;
  }

  if (Date.now() < state.flushBackoffUntil) {
    return null;
  }

  if (state.flushPromise) {
    return state.flushPromise;
  }

  state.flushPromise = (async function () {
    try {
      const batch = state.pendingEvents.slice(
        0,
        MAX_BATCH_SIZE
      );

      const result = await sendBatch(
        batch,
        options.keepalive
      );

      const completedIds = new Set(
        batch.map(function (event) {
          return event.eventId;
        })
      );

      state.pendingEvents = state.pendingEvents.filter(
        function (event) {
          return !completedIds.has(event.eventId);
        }
      );

      persistPendingEvents();

      state.flushFailures = 0;
      state.flushBackoffUntil = 0;

      if (!state.sessionEnded && !state.isLoggingOut) {
        applyEarningsSnapshot(result);
      }

      if (result.rejected > 0 && !options.silent) {
        const snapshot = getSnapshot(result);
        const settings = getTapSettings(snapshot);

        showToast(
          result.limitReached
            ? 'Your daily Tap Tap limit of ' +
              formatDailyLimit(settings.dailyTapLimit) +
              ' has been reached.'
            : 'Some rewards could not be processed.'
        );
      }

      // Process another batch if more events remain.

      if (state.pendingEvents.length > 0) {
        setTimeout(function () {
          flushPendingEarnings({
            silent: true
          });
        }, 1500);
      }

      return result;

    } catch (error) {
      state.flushFailures++;

      const delay = Math.min(
        900000,
        30000 * Math.pow(2, Math.min(state.flushFailures - 1, 5))
      );

      state.flushBackoffUntil = Date.now() + delay;

      console.warn('Tuneva batch submission failed:', error);

      if (
        !options.silent &&
        !state.sessionEnded &&
        !state.isLoggingOut
      ) {
        showToast(
          'Rewards remain saved in your browser and will retry automatically.'
        );
      }

      return null;

    } finally {
      state.flushPromise = null;
    }
  })();

  return state.flushPromise;
}

// =================================
// ADD LOCAL REWARD
// =================================

function addPendingEvent(action, extra) {
  if (state.sessionEnded || state.isLoggingOut) {
    return null;
  }

  if (!['tap', 'video'].includes(action)) {
    return null;
  }

  extra = extra || {};

  if (action === 'video') {
    if (!extra.videoId) return null;

    const videoId = String(extra.videoId);

    const existing = state.pendingEvents.find(function (event) {
      return (
        event.action === 'video' &&
        event.videoId === videoId
      );
    });

    if (existing) return existing;

    const snapshot = getOptimisticSnapshot();

    if (snapshot.claimedVideos.includes(videoId)) {
      return null;
    }
  }

  const event = Object.assign({
    eventId: createEventId(),
    action: action,
    createdAt: new Date().toISOString()
  }, action === 'video'
    ? {
        videoId: String(extra.videoId),
        videoTitle: String(extra.videoTitle || '')
      }
    : {});

  state.pendingEvents.push(event);

  persistPendingEvents();

  publishOptimisticSnapshot();

  return event;
}

// =================================
// SAVE REWARD
// =================================

function saveBackendEarning(action, extra) {
  if (state.sessionEnded || state.isLoggingOut) {
    return Promise.resolve(null);
  }

  if (action === 'tap') {
    const snapshot = getOptimisticSnapshot();
    const settings = getTapSettings(snapshot);

    if (
      Number(snapshot.tapDailyEarnings || 0) +
      settings.tapReward >
      settings.dailyTapLimit
    ) {
      return Promise.resolve({
        ok: true,
        limitReached: true,

        message:
          'You have reached your daily Tap Tap earnings limit of ' +
          formatDailyLimit(settings.dailyTapLimit) + '.',

        earnings: snapshot
      });
    }

    const event = addPendingEvent('tap');

    if (!event) {
      return Promise.resolve(null);
    }

    // Sync only after the local batch reaches its threshold.

    if (getPendingTapCount() >= BATCH_SIZE) {
      flushPendingEarnings({
        silent: true
      });
    }

    return Promise.resolve({
      ok: true,
      pending: true,
      earnings: getOptimisticSnapshot()
    });
  }

  if (action === 'video') {
    extra = extra || {};

    const event = addPendingEvent('video', extra);

    if (!event) {
      const snapshot = getOptimisticSnapshot();

      if (
        extra.videoId &&
        snapshot.claimedVideos.includes(String(extra.videoId))
      ) {
        return Promise.resolve({
          ok: true,
          pending: true,
          earnings: snapshot
        });
      }

      return Promise.resolve(null);
    }

    // Video rewards are queued locally too.
    // They are synchronized with the next batch.

    return Promise.resolve({
      ok: true,
      pending: true,
      earnings: getOptimisticSnapshot()
    });
  }

  return Promise.resolve(null);
}

// =================================
// AUTOMATIC SYNCHRONIZATION
// =================================

function scheduleFlush() {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
  }

  state.flushTimer = setInterval(function () {
    if (state.pendingEvents.length) {
      flushPendingEarnings({
        silent: true
      });
    }
  }, FLUSH_INTERVAL);
}

window.addEventListener('online', function () {
  flushPendingEarnings({
    silent: true
  });
});

// Flush when the browser is closing or navigating away.

window.addEventListener('pagehide', function () {
  if (state.pendingEvents.length) {
    flushPendingEarnings({
      keepalive: true,
      silent: true
    });
  }
});

// =================================
// TAP EVENT COMPATIBILITY
// =================================

function processTapEarnings(event) {
  const detail = event.detail || {};

  if (!Number(detail.pointsEarned)) return;

  saveBackendEarning('tap');
}

window.addEventListener(
  'tuneva:tap-earned',
  processTapEarnings
);

// =================================
// THEME
// =================================

function requestTheme(theme) {
  window.dispatchEvent(
    new CustomEvent('tuneva:theme-change', {
      detail: {
        theme: theme
      }
    })
  );
}

// =================================
// SHARED DASHBOARD CORE
// =================================

window.TunevaDashboardCore = {
  dashboard: dashboard,
  auth: auth,
  state: state,

  elements: {
    themeButton: themeButton,
    balanceEye: balanceEye,
    referralLinkElement: referralLinkElement,
    copyReferralButton: copyReferralButton,
    copyFeedback: copyFeedback,
    referralSeeAll: referralSeeAll
  },

  updateBalance: updateBalance,
  formatMoney: formatMoney,
  showToast: showToast,

  loadBackendEarnings: loadBackendEarnings,
  saveBackendEarning: saveBackendEarning,
  applyEarningsSnapshot: applyEarningsSnapshot,

  requestTheme: requestTheme,
  getPersistentToken: getPersistentToken,

  flushPendingEarnings: flushPendingEarnings,

  getPendingEvents: function () {
    return state.pendingEvents.slice();
  }
};

// =================================
// PUBLIC EARNINGS API
// =================================

window.TunevaEarnings = {
  load: loadBackendEarnings,
  save: saveBackendEarning,
  apply: applyEarningsSnapshot,
  flush: flushPendingEarnings,

  getPendingEvents: function () {
    return state.pendingEvents.slice();
  },

  getSnapshot: function () {
    return getOptimisticSnapshot();
  }
};

// =================================
// INITIALIZATION
// =================================

// Load this user's local queue and cached earnings first.

loadPendingEvents();
loadCachedSnapshot();

// Display saved browser earnings immediately.

publishOptimisticSnapshot();

// Start periodic synchronization.

scheduleFlush();

// Only load from the backend when no recent browser snapshot exists.

loadBackendEarnings().then(function () {
  if (state.pendingEvents.length) {
    flushPendingEarnings({
      silent: true
    });
  }
});

})();
