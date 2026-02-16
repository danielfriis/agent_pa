export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
});

export const sendRaw = (res, status, body, { contentType, headers = {} } = {}) => {
  res.writeHead(status, {
    ...(contentType ? { "content-type": contentType } : {}),
    ...CORS_HEADERS,
    ...headers
  });
  res.end(body);
};

export const sendJson = (res, status, payload, headers = {}) => {
  sendRaw(res, status, JSON.stringify(payload), {
    contentType: "application/json",
    headers
  });
};

export const sendNoContent = (res, status = 204) => {
  res.writeHead(status, CORS_HEADERS);
  res.end();
};

export const readRawBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return Buffer.alloc(0);
  return Buffer.concat(chunks);
};

export const readJsonBody = async (req) => {
  const rawBody = await readRawBody(req);
  if (!rawBody.length) return {};

  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
};

export const readFormBody = async (req) => {
  const rawBody = await readRawBody(req);
  if (!rawBody.length) return {};

  const body = {};
  const params = new URLSearchParams(rawBody.toString("utf8"));
  for (const [key, value] of params) {
    if (!Object.hasOwn(body, key)) {
      body[key] = value;
      continue;
    }

    const current = body[key];
    body[key] = Array.isArray(current) ? [...current, value] : [current, value];
  }

  return body;
};
