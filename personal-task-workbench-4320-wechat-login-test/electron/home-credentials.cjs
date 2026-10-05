const HOME_TOKEN_MIN_LENGTH = 43;

function isValidHomeToken(value) {
  return typeof value === "string"
    && value.length >= HOME_TOKEN_MIN_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function keepOrCreateHomeToken(value, createToken) {
  const candidate = String(value || "").trim();
  return isValidHomeToken(candidate) ? candidate : createToken();
}

module.exports = { HOME_TOKEN_MIN_LENGTH, isValidHomeToken, keepOrCreateHomeToken };
