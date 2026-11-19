import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { waitForHttpStatus } from "@relis/test-utils";

// Regression coverage for a review finding on this sub-issue (02.04):
// waitForHttpStatus's bound on `timeoutMs` previously checked the
// deadline only BETWEEN requests — a single pending `fetch` (e.g. a real
// proxy silently dropping packets toward a dead upstream, with no reply
// at all; see proxy-health.test.ts's own comment on nginx's cached-DNS/
// default-connect-timeout behavior) could keep that one request open far
// longer than `timeoutMs`, with nothing bounding it. The fix ties each
// request's own cancellation (`AbortController`) to the REMAINING time
// left in the overall deadline, and clamps the retry delay the same way.
//
// Every scenario here runs against a REAL local HTTP server
// (`node:http`, loopback only, ephemeral port) — deterministic and with
// no dependency on any external service or Docker. No Docker-availability
// gate is needed; this exercises the polling utility itself, not the real
// stack.

interface TestServer {
  url: string;
  server: Server;
  requestCount: () => number;
}

/** Starts a disposable local HTTP server on an ephemeral loopback port, calling `handler` for every request received. */
async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine the test server's assigned port");
  }
  return { url: `http://127.0.0.1:${address.port}/`, server, requestCount: () => count };
}

function stopServer(testServer: TestServer): Promise<void> {
  return new Promise((resolve) => testServer.server.close(() => resolve()));
}

let activeServer: TestServer | undefined;

afterEach(async () => {
  if (activeServer) {
    await stopServer(activeServer);
    activeServer = undefined;
  }
});

describe("waitForHttpStatus", () => {
  it("resolves immediately once the server returns an acceptable status", async () => {
    activeServer = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const response = await waitForHttpStatus(activeServer.url, (status) => status === 200, 5000);
    expect(response.status).toBe(200);
    // The ACCEPTED response's body must reach the caller untouched —
    // never pre-read or cancelled internally.
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("retries past repeated unacceptable statuses and recovers once the server starts succeeding", async () => {
    let failuresLeft = 3;
    activeServer = await startServer((_req, res) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("not ready yet");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const response = await waitForHttpStatus(activeServer.url, (status) => status === 200, 10000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    // Proves it genuinely retried (more than one request reached the
    // server) rather than passing on the first attempt.
    expect(activeServer.requestCount()).toBeGreaterThan(1);
  });

  it("times out with the last observed status when the server never returns an acceptable one", async () => {
    activeServer = await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("still not ready");
    });

    await expect(waitForHttpStatus(activeServer.url, (status) => status === 200, 2500)).rejects.toThrow(/last observed status: 503/i);
  });

  it("is BOUNDED by timeoutMs even when a single request hangs and never responds at all", async () => {
    let serverSawRequest = false;
    activeServer = await startServer((_req, _res) => {
      serverSawRequest = true;
      // Deliberately never calls res.end()/res.writeHead() — simulates a
      // proxy/upstream that accepts the connection but never replies,
      // which is exactly the case the original unbounded implementation
      // could hang on indefinitely.
    });

    const timeoutMs = 1000;
    const start = Date.now();
    await expect(waitForHttpStatus(activeServer.url, () => true, timeoutMs)).rejects.toThrow(/timed out after 1000ms/i);
    const elapsed = Date.now() - start;

    expect(serverSawRequest).toBe(true);
    // The core regression check: total elapsed time stays close to
    // timeoutMs, never anywhere near how long the hang itself could have
    // lasted (unbounded). A generous grace window absorbs real scheduling/
    // event-loop jitter without weakening the actual bound being proven.
    expect(elapsed).toBeLessThan(timeoutMs + 1500);
  });

  it("actually cancels the pending request at the network level when the deadline is hit (not merely giving up locally)", async () => {
    let serverRequestClosed = false;
    activeServer = await startServer((req, _res) => {
      // Never responds; observes whether the UNDERLYING CONNECTION itself
      // was closed by the client — the real signal that our
      // AbortController genuinely cancelled the in-flight request, not
      // just that our own promise settled while the socket stayed open.
      req.on("close", () => {
        serverRequestClosed = true;
      });
    });

    await expect(waitForHttpStatus(activeServer.url, () => true, 500)).rejects.toThrow(/timed out/i);

    // The abort propagates asynchronously over the socket; poll briefly
    // for the server to observe it rather than asserting instantly.
    const deadline = Date.now() + 5000;
    while (!serverRequestClosed && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    expect(serverRequestClosed).toBe(true);
  });

  it("releases a rejected response's body — subsequent polls on the same connection are not stalled by it", async () => {
    // If a rejected (unacceptable) response's body were left undrained,
    // an HTTP client's connection-keep-alive reuse could stall the NEXT
    // request on the same socket. Several consecutive 503s, all on the
    // default keep-alive-eligible connection, completing within a short
    // bound is itself the regression proof.
    let responses = 0;
    activeServer = await startServer((_req, res) => {
      responses += 1;
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`not ready (${responses})`);
    });

    const start = Date.now();
    await expect(waitForHttpStatus(activeServer.url, (status) => status === 200, 3500)).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;

    expect(responses).toBeGreaterThan(1);
    // Bounded close to the requested timeout — no multi-second stall from
    // an undrained body blocking connection reuse.
    expect(elapsed).toBeLessThan(3500 + 1500);
  });
});
