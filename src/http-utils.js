export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
});

export const sendJson = (res, status, payload, headers = {}) => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...CORS_HEADERS,
    ...headers
  });
  res.end(JSON.stringify(payload));
};

export const sendNoContent = (res, status = 204) => {
  res.writeHead(status, CORS_HEADERS);
  res.end();
};

export const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
};
