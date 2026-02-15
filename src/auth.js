import { timingSafeEqual } from "node:crypto";

const toBuffer = (value) => Buffer.from(String(value), "utf8");
const headerValue = (value) =>
  Array.isArray(value) ? (typeof value[0] === "string" ? value[0] : "") : value || "";

const safeEqual = (left, right) => {
  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const bearerTokenFromHeader = (authorizationHeader) => {
  if (!authorizationHeader) return "";
  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
};

export const isRequestAuthorized = (requestHeaders, securityConfig) => {
  if (!securityConfig.requireAuth) return true;
  const expectedToken = securityConfig.apiToken;
  if (!expectedToken) return false;

  const providedToken =
    bearerTokenFromHeader(headerValue(requestHeaders.authorization)) ||
    headerValue(requestHeaders["x-api-key"]);

  if (!providedToken) return false;
  return safeEqual(providedToken, expectedToken);
};
