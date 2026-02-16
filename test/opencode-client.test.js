import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { OpenCodeClient } from "../src/opencode-client.js";

const createAbortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

const withMockedFetch = async (mock, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const createClient = (requestTimeoutMs) =>
  new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    host: "127.0.0.1",
    port: 4096,
    directory: "/tmp",
    username: "opencode",
    password: "",
    autostart: false,
    requestTimeoutMs
  });

test("OpenCodeClient request times out when upstream is stalled", async () => {
  await withMockedFetch((url, init = {}) => {
    assert.match(String(url), /\/session/);
    return new Promise((_, reject) => {
      const signal = init.signal;
      if (!signal) {
        reject(new Error("expected abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(createAbortError());
        },
        { once: true }
      );
    });
  }, async () => {
    const client = createClient(25);
    await assert.rejects(client.listSessions(), /OpenCode GET \/session timed out after 25ms/);
  });
});

test("OpenCodeClient pipeGlobalEvents bypasses request timeout for SSE", async () => {
  await withMockedFetch((url, init = {}) => {
    assert.match(String(url), /\/global\/event/);
    assert.equal(init.signal, undefined);

    return new Promise((resolve) => {
      setTimeout(() => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: ping\n\n"));
            controller.close();
          }
        });
        resolve({
          ok: true,
          status: 200,
          body,
          text: async () => ""
        });
      }, 20);
    });
  }, async () => {
    const client = createClient(5);
    const response = new PassThrough();
    response.writeHead = () => {};

    let output = "";
    response.on("data", (chunk) => {
      output += chunk.toString();
    });

    const endPromise = once(response, "end");
    await client.pipeGlobalEvents(response);
    await endPromise;

    assert.equal(output, "data: ping\n\n");
  });
});
