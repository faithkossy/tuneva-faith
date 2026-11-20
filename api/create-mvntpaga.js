
const crypto = require("crypto");

const {
  readJSON,
  writeJSON
} = require("../lib/github-storage");

const {
  normalizeUsername,
  normalizeEmail,
  validUsername,
  hashPassword
} = require("../lib/auth");

const PAYMENTS_FILE = "data/payments.json";
const USERS_FILE = "data/users.json";
const SETTINGS_FILE = "data/admin-settings.json";

const DEFAULT_ACTIVATION_PRICES = [5300, 9300];
const ACTIVATION_EXPIRY_MINUTES = 50;

/* RESPONSE */

function send(res, status, data) {
  return res.status(status).json(data);
}

/* LOGGING */

function logInfo(event, details = {}) {
  console.log(
    `[TUNEVA CREATE] ${event}`,
    JSON.stringify(details)
  );
}

function logError(event, details = {}) {
  console.error(
    `[TUNEVA CREATE] ${event}`,
    JSON.stringify(details)
  );
}

/* HELPERS */

function makeReference() {
  return (
    "tv_" + Date.now() + "_" +
    crypto.randomBytes(5).toString("hex")
  ).slice(0, 32);
}

function makePaymentId() {
  return "PAY-TUNEVA-" + crypto.randomBytes(12).toString("hex");
}

function makeStatusToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256")
    .update(String(token))
    .digest("hex");
}

function normalizePhone(phone) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("234") && value.length === 13) {
    value = "0" + value.slice(3);
  }

  return value;
}

function getActivationPrices(settings) {
  const prices = settings?.activationPrices;

  if (
    Array.isArray(prices) &&
    prices.length === 2 &&
    prices.every(value =>
      Number.isSafeInteger(value) &&
      value >= 100 &&
      value <= 1000000
    ) &&
    prices[0] !== prices[1]
  ) {
    return prices;
  }

  return DEFAULT_ACTIVATION_PRICES;
}

/* MAIN HANDLER */

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  const requestId = String(
    req.headers["x-vercel-id"] ||
    req.headers["x-request-id"] ||
    crypto.randomUUID()
  );

  let stage = "request_received";

  const logContext = {
    requestId,
    method: req.method,
    path: req.url || "/api/create-mvntpaga"
  };

  /* CORS HEADERS */

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Cache-Control", "no-store");

  /* REQUEST LOG */

  logInfo("REQUEST", {
    ...logContext,
    origin: req.headers.origin || null,
    userAgent: req.headers["user-agent"] || null,
    time: new Date().toISOString()
  });

  /* AUTOMATIC RESPONSE LOG */

  res.on("finish", function () {
    logInfo("RESPONSE", {
      ...logContext,
      status: res.statusCode,
      stage,
      durationMs: Date.now() - startedAt
    });
  });

  /* CORS PREFLIGHT */

  if (req.method === "OPTIONS") {
    stage = "cors_preflight";

    logInfo("CORS PREFLIGHT", {
      ...logContext,
      origin: req.headers.origin || null,
      requestedMethod:
        req.headers["access-control-request-method"] || null,
      requestedHeaders:
        req.headers["access-control-request-headers"] || null
    });

    return res.status(200).end();
  }

  /* METHOD VALIDATION */

  if (req.method !== "POST") {
    stage = "method_not_allowed";

    return send(res, 405, {
      status: false,
      message: "Method not allowed."
    });
  }

  try {
    /* CHECK PAYMENT CONFIGURATION */

    stage = "checking_payment_configuration";

    const secretKey = process.env.MOVANTRA_SECRET_KEY;

    if (!secretKey) {
      logError("CONFIGURATION ERROR", {
        ...logContext,
        stage
      });

      return send(res, 500, {
        status: false,
        message: "Payment service is not configured."
      });
    }

    /* READ REQUEST DATA */

    stage = "validating_customer_details";

    const body = req.body || {};

    const customerName = String(
      body.customer_name || body.name || ""
    ).trim();

    const customerEmail = normalizeEmail(
      body.customer_email || body.email
    );

    const customerPhone = String(
      body.customer_phone || body.phone || ""
    ).trim();

    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (!customerName || !customerEmail) {
      return send(res, 400, {
        status: false,
        message: "Name and email are required."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return send(res, 400, {
        status: false,
        message: "Enter a valid email address."
      });
    }

    if (!validUsername(username)) {
      return send(res, 400, {
        status: false,
        message: "Username must be 3–20 characters using letters, numbers or underscores."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return send(res, 400, {
        status: false,
        message: "Password must be at least 8 characters."
      });
    }

    logInfo("CUSTOMER VALIDATION PASSED", logContext);

    /* LOAD ADMIN ACTIVATION PRICES */

    stage = "loading_activation_settings";

    logInfo("GITHUB READ STARTED", {
      ...logContext,
      file: SETTINGS_FILE
    });

    const settingsResult = await readJSON(
      SETTINGS_FILE,
      {}
    );

    const activationPrices = getActivationPrices(
      settingsResult.data
    );

    const allowedAmountsKobo = activationPrices.map(
      amount => amount * 100
    );

    logInfo("ACTIVATION SETTINGS LOADED", {
      ...logContext,
      availablePriceCount: activationPrices.length
    });

    /* VALIDATE SELECTED ACTIVATION PRICE */

    stage = "validating_activation_amount";

    const suppliedAmount = body.amount_kobo !== undefined
      ? Number(body.amount_kobo)
      : body.amount !== undefined
        ? Math.round(Number(body.amount) * 100)
        : allowedAmountsKobo[0];

    if (
      !Number.isSafeInteger(suppliedAmount) ||
      !allowedAmountsKobo.includes(suppliedAmount)
    ) {
      return send(res, 400, {
        status: false,
        code: "invalid_activation_amount",
        message: "Choose a valid Tuneva activation price."
      });
    }

    const activationAmountKobo = suppliedAmount;

    /* LOAD EXISTING USERS AND PAYMENTS */

    stage = "loading_users_and_payments";

    logInfo("GITHUB DATA READ STARTED", {
      ...logContext,
      files: [USERS_FILE, PAYMENTS_FILE]
    });

    const [userFile, paymentFile] = await Promise.all([
      readJSON(USERS_FILE, { users: [] }),
      readJSON(PAYMENTS_FILE, { payments: [] })
    ]);

    const users = Array.isArray(userFile.data?.users)
      ? userFile.data.users
      : [];

    const payments = Array.isArray(paymentFile.data?.payments)
      ? paymentFile.data.payments
      : [];

    logInfo("GITHUB DATA LOADED", {
      ...logContext,
      userCount: users.length,
      paymentCount: payments.length
    });

    /* CHECK ACTIVATED ACCOUNTS ONLY */

    stage = "checking_existing_account";

    const customerPhoneNormalized = normalizePhone(customerPhone);

    const existingAccount = users.find(user => {
      const existingUsername = normalizeUsername(user.username);
      const existingEmail = normalizeEmail(user.email);

      const existingPhone = normalizePhone(
        user.phone ||
        user.phoneNumber ||
        user.customerPhone ||
        user.customer_phone
      );

      return (
        existingUsername === username ||
        existingEmail === customerEmail ||
        (
          customerPhoneNormalized &&
          existingPhone &&
          existingPhone === customerPhoneNormalized
        )
      );
    });

    if (existingAccount) {
      logInfo("EXISTING ACCOUNT FOUND", logContext);

      return send(res, 409, {
        status: false,
        code: "account_exists",
        message: "An activated account already exists with this username, email or phone number."
      });
    }

    /* HASH PASSWORD */

    stage = "hashing_password";

    const passwordHash = await hashPassword(password);

    logInfo("PASSWORD HASH COMPLETED", logContext);

    /* CREATE MOVANTRA PAYMENT ACCOUNT */

    stage = "creating_movantra_account";

    const reference = makeReference();

    const movantraBody = {
      amount_kobo: activationAmountKobo,
      customer_name: customerName,
      customer_email: customerEmail,
      reference,
      expiry_minutes: ACTIVATION_EXPIRY_MINUTES
    };

    if (customerPhone) {
      movantraBody.customer_phone = customerPhone;
    }

    if (process.env.PAGA_CALLBACK_URL) {
      movantraBody.callback_url = process.env.PAGA_CALLBACK_URL;
    }

    logInfo("MOVANTRA REQUEST STARTED", {
      ...logContext,
      reference,
      amountKobo: activationAmountKobo
    });

    const providerResponse = await fetch(
      "https://api.movantrapay.com/v1/paga/dynamic-accounts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(movantraBody)
      }
    );

    logInfo("MOVANTRA RESPONSE RECEIVED", {
      ...logContext,
      httpStatus: providerResponse.status,
      ok: providerResponse.ok
    });

    let result;

    try {
      result = await providerResponse.json();
    } catch (error) {
      logError("MOVANTRA INVALID JSON RESPONSE", {
        ...logContext,
        stage,
        httpStatus: providerResponse.status,
        error: error.message
      });

      return send(res, 502, {
        status: false,
        message: "Invalid response from payment provider."
      });
    }

    if (!providerResponse.ok || !result || result.status !== true) {
      logError("MOVANTRA ACCOUNT ERROR", {
        ...logContext,
        stage,
        httpStatus: providerResponse.status,
        providerStatus: result?.status ?? null,
        providerMessage: result?.message || null
      });

      return send(res, 502, {
        status: false,
        message: result?.message ||
          "Unable to create your payment account."
      });
    }

    if (
      !result.account_number ||
      !result.account_name ||
      !result.bank_name
    ) {
      logError("MOVANTRA INCOMPLETE ACCOUNT DETAILS", {
        ...logContext,
        stage,
        httpStatus: providerResponse.status,
        hasAccountNumber: Boolean(result.account_number),
        hasAccountName: Boolean(result.account_name),
        hasBankName: Boolean(result.bank_name)
      });

      return send(res, 502, {
        status: false,
        message: "Payment provider returned incomplete account details."
      });
    }

    const providerReference = String(
      result.reference || reference
    ).trim();

    if (!providerReference) {
      logError("INVALID PAYMENT REFERENCE", {
        ...logContext,
        stage
      });

      return send(res, 502, {
        status: false,
        message: "Invalid payment reference."
      });
    }

    logInfo("MOVANTRA ACCOUNT CREATED", {
      ...logContext,
      reference: providerReference
    });

    /* CREATE PAYMENT RECORD */

    stage = "creating_payment_record";

    const paymentId = makePaymentId();
    const statusToken = makeStatusToken();
    const createdAt = new Date().toISOString();

    const paymentRecord = {
      id: paymentId,
      customerName,
      username,
      email: customerEmail,
      phone: customerPhone,
      passwordHash,

      amount: activationAmountKobo / 100,
      amountKobo: activationAmountKobo,

      method: "paga",
      provider: "movantra",

      reference: providerReference,
      status: "pending",
      statusTokenHash: hashToken(statusToken),

      createdAt,
      processedAt: null,

      activation: true,
      activationExpiresAt:
        result.expires_at ||
        new Date(
          Date.now() +
          ACTIVATION_EXPIRY_MINUTES * 60 * 1000
        ).toISOString(),

      pofPass: null,
      pofGeneratedAt: null,
      pofUsed: false,
      pofUsedAt: null
    };

    if (
      payments.some(item =>
        String(item.reference || "") === providerReference
      )
    ) {
      logError("DUPLICATE PAYMENT REFERENCE", {
        ...logContext,
        reference: providerReference
      });

      return send(res, 409, {
        status: false,
        message: "Payment reference already exists."
      });
    }

    /* SAVE PAYMENT */

    stage = "saving_payment_record";

    logInfo("GITHUB PAYMENT WRITE STARTED", {
      ...logContext,
      file: PAYMENTS_FILE
    });

    await writeJSON(
      PAYMENTS_FILE,
      {
        ...(paymentFile.data || {}),
        payments: [paymentRecord, ...payments]
      },
      paymentFile.sha
    );

    logInfo("GITHUB PAYMENT WRITE COMPLETED", {
      ...logContext,
      paymentId,
      reference: providerReference
    });

    /* RETURN PAYMENT DETAILS */

    stage = "account_created";

    logInfo("ACCOUNT CREATION SUCCESSFUL", {
      ...logContext,
      paymentId,
      reference: providerReference,
      durationMs: Date.now() - startedAt
    });

    return send(res, 200, {
      status: true,
      paymentId,
      statusToken,
      reference: providerReference,
      account_number: result.account_number,
      account_name: result.account_name,
      bank_name: result.bank_name,
      amount_kobo: activationAmountKobo,
      fee_kobo: result.fee_kobo ?? null,
      net_kobo: result.net_kobo ?? null,
      status_text: result.status_text || "pending",
      expires_at: paymentRecord.activationExpiresAt,
      mode: result.mode || null
    });

  } catch (error) {
    logError("UNEXPECTED ERROR", {
      ...logContext,
      stage,
      message: error.message,
      stack: error.stack || null,
      durationMs: Date.now() - startedAt
    });

    return send(res, 500, {
      status: false,
      message: "Unable to create your payment account."
    });
  }
};
