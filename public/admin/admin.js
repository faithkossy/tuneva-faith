
(function () {
  "use strict";

  const API = "https://api.tunevamobile.com.ng/api/admin";

  const platformScreen = document.getElementById("ta-platform-screen");
  const withdrawalsScreen = document.getElementById("ta-withdrawals-screen");
  const openWithdrawalsButton = document.getElementById("ta-open-withdrawals");
  const backSettingsButton = document.getElementById("ta-back-settings");

  const settingsForm = document.getElementById("ta-settings-form");
  const settingsButton = document.getElementById("ta-save-settings");
  const settingsMessage = document.getElementById("ta-settings-message");

  const withdrawalsToggle = document.getElementById("ta-withdrawals-toggle");
  const withdrawalStatus = document.getElementById("ta-withdrawal-status");
  const withdrawalMessage = document.getElementById("ta-withdrawal-message");

  const fields = {
    priceOne: document.getElementById("ta-price-one"),
    priceTwo: document.getElementById("ta-price-two"),
    tapPoints: document.getElementById("ta-tap-points"),
    tapReward: document.getElementById("ta-tap-reward"),
    dailyLimit: document.getElementById("ta-daily-limit"),
    videoReward: document.getElementById("ta-video-reward")
  };

  const DEFAULT_SETTINGS = {
    activationPrices: [5300, 9300],
    tapPoints: 350,
    tapReward: 100,
    dailyTapLimit: 3000,
    videoReward: 1750,
    withdrawalsEnabled: true
  };

  let requestInProgress = false;
  let settingsLoaded = false;
  let withdrawalsEnabled = true;

  function setMessage(element, message, type) {
    element.textContent = message || "";
    element.classList.remove("success", "error");

    if (type) {
      element.classList.add(type);
    }
  }

  async function apiRequest(method, body) {
    const response = await fetch(API, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? {
          "Content-Type": "application/json"
        } : {})
      },
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined
    });

    let result;

    try {
      result = await response.json();
    } catch (_) {
      throw new Error("Invalid response from the admin server.");
    }

    if (!response.ok || !result || result.ok !== true) {
      throw new Error(
        result?.message ||
        "The admin request could not be completed."
      );
    }

    return result;
  }

  function validNumber(value, minimum, maximum) {
    const number = Number(value);

    return (
      Number.isSafeInteger(number) &&
      number >= minimum &&
      number <= maximum
    );
  }

  function updateWithdrawalControl(enabled) {
    withdrawalsEnabled = enabled;

    withdrawalsToggle.setAttribute(
      "aria-checked",
      enabled ? "true" : "false"
    );

    withdrawalStatus.textContent = enabled
      ? "Withdrawals are currently enabled."
      : "Withdrawals are currently disabled.";
  }

  function populateSettings(settings) {
    const prices = Array.isArray(settings.activationPrices)
      ? settings.activationPrices
      : DEFAULT_SETTINGS.activationPrices;

    fields.priceOne.value = prices[0];
    fields.priceTwo.value = prices[1];

    fields.tapPoints.value =
      settings.tapPoints ?? DEFAULT_SETTINGS.tapPoints;

    fields.tapReward.value =
      settings.tapReward ?? DEFAULT_SETTINGS.tapReward;

    fields.dailyLimit.value =
      settings.dailyTapLimit ?? DEFAULT_SETTINGS.dailyTapLimit;

    fields.videoReward.value =
      settings.videoReward ?? DEFAULT_SETTINGS.videoReward;

    updateWithdrawalControl(
      typeof settings.withdrawalsEnabled === "boolean"
        ? settings.withdrawalsEnabled
        : DEFAULT_SETTINGS.withdrawalsEnabled
    );
  }

  function collectSettings() {
    const values = {
      activationPrices: [
        Number(fields.priceOne.value),
        Number(fields.priceTwo.value)
      ],
      tapPoints: Number(fields.tapPoints.value),
      tapReward: Number(fields.tapReward.value),
      dailyTapLimit: Number(fields.dailyLimit.value),
      videoReward: Number(fields.videoReward.value),
      withdrawalsEnabled
    };

    if (
      !validNumber(values.activationPrices[0], 100, 1000000) ||
      !validNumber(values.activationPrices[1], 100, 1000000)
    ) {
      throw new Error("Enter valid activation fees.");
    }

    if (values.activationPrices[0] === values.activationPrices[1]) {
      throw new Error("The two activation fees must be different.");
    }

    if (!validNumber(values.tapPoints, 1, 1000000)) {
      throw new Error("Enter valid points per Tap.");
    }

    if (!validNumber(values.tapReward, 1, 1000000)) {
      throw new Error("Enter a valid Tap reward.");
    }

    if (!validNumber(values.dailyTapLimit, 1, 100000000)) {
      throw new Error("Enter a valid daily Tap limit.");
    }

    if (!validNumber(values.videoReward, 1, 1000000)) {
      throw new Error("Enter a valid video reward.");
    }

    return values;
  }

  async function loadDashboard() {
    if (requestInProgress) return;

    requestInProgress = true;
    setMessage(settingsMessage, "Loading settings...", "");
    withdrawalsToggle.disabled = true;

    try {
      const result = await apiRequest("GET");

      populateSettings(
        Object.assign(
          {},
          DEFAULT_SETTINGS,
          result.settings || {}
        )
      );

      settingsLoaded = true;
      withdrawalsToggle.disabled = false;

      setMessage(settingsMessage, "", "");
      setMessage(withdrawalMessage, "", "");

    } catch (error) {
      setMessage(settingsMessage, error.message, "error");
      setMessage(withdrawalMessage, error.message, "error");

    } finally {
      requestInProgress = false;
    }
  }

  settingsForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (requestInProgress || !settingsLoaded) return;

    let settings;

    try {
      settings = collectSettings();
    } catch (error) {
      setMessage(settingsMessage, error.message, "error");
      return;
    }

    requestInProgress = true;
    settingsButton.disabled = true;
    settingsButton.textContent = "Saving...";
    setMessage(settingsMessage, "", "");

    try {
      const result = await apiRequest("POST", settings);

      populateSettings(
        Object.assign(
          {},
          DEFAULT_SETTINGS,
          result.settings || settings
        )
      );

      setMessage(
        settingsMessage,
        "All settings saved successfully.",
        "success"
      );

    } catch (error) {
      setMessage(settingsMessage, error.message, "error");

    } finally {
      requestInProgress = false;
      settingsButton.disabled = false;
      settingsButton.textContent = "Save all settings";
    }
  });

  withdrawalsToggle.addEventListener("click", async function () {
    if (requestInProgress || !settingsLoaded) return;

    const previousValue = withdrawalsEnabled;
    const nextValue = !previousValue;

    let settings;

    try {
      settings = collectSettings();
      settings.withdrawalsEnabled = nextValue;
    } catch (error) {
      setMessage(withdrawalMessage, error.message, "error");
      return;
    }

    requestInProgress = true;
    withdrawalsToggle.disabled = true;
    setMessage(withdrawalMessage, "Saving withdrawal setting...", "");

    try {
      const result = await apiRequest("POST", settings);

      const savedValue =
        result.settings &&
        typeof result.settings.withdrawalsEnabled === "boolean"
          ? result.settings.withdrawalsEnabled
          : nextValue;

      updateWithdrawalControl(savedValue);

      setMessage(
        withdrawalMessage,
        savedValue
          ? "Withdrawals have been enabled."
          : "Withdrawals have been disabled.",
        "success"
      );

    } catch (error) {
      updateWithdrawalControl(previousValue);
      setMessage(withdrawalMessage, error.message, "error");

    } finally {
      requestInProgress = false;
      withdrawalsToggle.disabled = false;
    }
  });

  openWithdrawalsButton.addEventListener("click", function () {
    platformScreen.hidden = true;
    withdrawalsScreen.hidden = false;
    window.scrollTo(0, 0);
  });

  backSettingsButton.addEventListener("click", function () {
    withdrawalsScreen.hidden = true;
    platformScreen.hidden = false;
    window.scrollTo(0, 0);
  });

  loadDashboard();

})();
