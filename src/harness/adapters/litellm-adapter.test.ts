import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterInvokeError } from "../errors.js";
import type { InvokeRequest } from "../types.js";
import { LiteLLMAdapter } from "./litellm-adapter.js";

/**
 * Local `node:http` fake server standing in for a LiteLLM proxy — no real
 * network, no third-party mock library (PRD §5's "真实但受控" testing
 * philosophy, same one A1's tests use). Every request the server receives
 * is recorded in `requests` so tests can assert on method/url/headers, not
 * just on `LiteLLMAdapter`'s return value.
 */
interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function startFakeServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(payload);
}

const fakeRequest: InvokeRequest = { role: "coder", prompt: "say hello" };

describe("LiteLLMAdapter", () => {
  let activeServer: FakeServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = undefined;
    }
  });

  it("invoke(): 200 success path returns content/provider/model from the response body", async () => {
    activeServer = await startFakeServer((_req, res) => {
      sendJson(res, 200, {
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      });
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const result = await adapter.invoke(fakeRequest);

    expect(result.content).toBe('{"ok":true}');
    expect(result.provider).toBe("litellm");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.provider).not.toBe("");
    expect(result.model).not.toBe("");
  });

  it.each([401, 403, 429, 500])(
    "invoke(): HTTP %i response is thrown as a typed AdapterInvokeError carrying the status code",
    async (statusCode) => {
      activeServer = await startFakeServer((_req, res) => {
        sendJson(res, statusCode, { error: "nope" });
      });

      const adapter = new LiteLLMAdapter("litellm", {
        base_url: activeServer.baseUrl,
        api_key: "sk-test",
        model: "gpt-4o-mini",
      });

      const invokePromise = adapter.invoke(fakeRequest);

      await expect(invokePromise).rejects.toBeInstanceOf(AdapterInvokeError);
      await invokePromise.catch((err: unknown) => {
        expect(err).toBeInstanceOf(AdapterInvokeError);
        expect((err as AdapterInvokeError).statusCode).toBe(statusCode);
      });
    },
  );

  it("invoke(): base_url with a trailing slash is normalized — no doubled slash in the request path", async () => {
    activeServer = await startFakeServer((_req, res) => {
      sendJson(res, 200, {
        model: "gpt-4o-mini",
        choices: [{ message: { content: "hi" } }],
      });
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: `${activeServer.baseUrl}/`,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    await adapter.invoke(fakeRequest);

    expect(activeServer.requests).toHaveLength(1);
    const [recorded] = activeServer.requests;
    expect(recorded?.url).toBe("/chat/completions");
    expect(recorded?.url?.includes("//")).toBe(false);
  });

  it("invoke(): missing api_key never sends a malformed 'Bearer undefined' Authorization header", async () => {
    activeServer = await startFakeServer((_req, res) => {
      sendJson(res, 200, {
        model: "gpt-4o-mini",
        choices: [{ message: { content: "hi" } }],
      });
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      model: "gpt-4o-mini",
      // api_key intentionally omitted
    });

    await adapter.invoke(fakeRequest);

    const [recorded] = activeServer.requests;
    expect(recorded?.headers.authorization).toBeUndefined();
  });

  it("invoke(): a response body that dies mid-read (connection reset *after* headers are received) is thrown as AdapterInvokeError from the body-read path specifically, not a raw TypeError (Zorro round-1 blocker 1 / round-2: the original version raced the socket destroy against the client's TCP read, so it could fall into the *request-level* catch (litellm-adapter.ts:117-131) instead of the body-read catch (:148-156) this test exists to guard — a mutation test proved that version stayed green even with the round-1 fix reverted)", async () => {
    activeServer = await startFakeServer((_req, res) => {
      // `res.flushHeaders()` pushes the status line + headers onto the
      // wire immediately (not buffered behind more `write()` calls), and
      // the `setTimeout` before `destroy()` gives the client a real
      // chance to receive them and resolve `fetch()`'s `Response` before
      // the connection dies — otherwise `destroy()` can race ahead of the
      // client's read and the failure surfaces from `fetch()` itself,
      // never touching `response.text()` at all. `Content-Length: 10000`
      // vs. the much shorter chunk actually written means `response.text()`
      // is still waiting on more bytes when the socket dies, so undici
      // rejects the body read specifically (a bare `TypeError`,
      // "terminated"/"aborted" — not a `SyntaxError`).
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
      res.flushHeaders();
      res.write('{"model":"gpt-4o-mini","choices":[{"message":{"content":"partial');
      setTimeout(() => res.socket?.destroy(), 50);
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const invokePromise = adapter.invoke(fakeRequest);

    await expect(invokePromise).rejects.toBeInstanceOf(AdapterInvokeError);
    await expect(invokePromise).rejects.not.toBeInstanceOf(TypeError);
    // Assertions tight enough to actually distinguish "failed reading the
    // body" from "the request itself failed" — a generic
    // `toBeInstanceOf(AdapterInvokeError)` is true for *both* catch blocks
    // in litellm-adapter.ts, which is exactly how the previous version of
    // this test stayed green under mutation.
    await invokePromise.catch((err: unknown) => {
      expect(err).toBeInstanceOf(AdapterInvokeError);
      expect((err as AdapterInvokeError).message).toContain("failed to read response body");
      expect((err as AdapterInvokeError).cause).toBeInstanceOf(TypeError);
    });
  });

  it("invoke(): a successful response with \"model\": \"\" falls back to the configured model — InvokeResult.model is never empty-string (Zorro round-1 blocker 2)", async () => {
    activeServer = await startFakeServer((_req, res) => {
      sendJson(res, 200, {
        model: "",
        choices: [{ message: { content: "hi" } }],
      });
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const result = await adapter.invoke(fakeRequest);

    expect(result.model).toBe("gpt-4o-mini");
    expect(result.model).not.toBe("");
    expect(result.provider).toBe("litellm");
    expect(result.provider).not.toBe("");
  });

  it("invoke(): a successful response with \"model\": \"   \" (whitespace-only) also falls back to the configured model — extractModel()'s blank check isn't just an empty-string check (P2 follow-up to Zorro round-1 blocker 2)", async () => {
    activeServer = await startFakeServer((_req, res) => {
      sendJson(res, 200, {
        model: "   ",
        choices: [{ message: { content: "hi" } }],
      });
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const result = await adapter.invoke(fakeRequest);

    expect(result.model).toBe("gpt-4o-mini");
    expect(result.model).not.toBe("   ");
  });

  it("invoke(): a non-JSON response body is thrown as AdapterInvokeError, not a raw SyntaxError", async () => {
    activeServer = await startFakeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json {{{");
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const invokePromise = adapter.invoke(fakeRequest);

    await expect(invokePromise).rejects.toBeInstanceOf(AdapterInvokeError);
    await expect(invokePromise).rejects.not.toBeInstanceOf(SyntaxError);
  });

  it("checkAvailability(): issues a real GET /health/liveliness request and reports available:true on 200", async () => {
    activeServer = await startFakeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      api_key: "sk-test",
      model: "gpt-4o-mini",
    });

    const result = await adapter.checkAvailability();

    expect(activeServer.requests).toHaveLength(1);
    expect(activeServer.requests[0]?.method).toBe("GET");
    expect(activeServer.requests[0]?.url).toBe("/health/liveliness");
    expect(result.available).toBe(true);
    expect(typeof result.checkedAt).toBe("string");
  });

  it("checkAvailability(): reports available:false (without throwing) when the probe response is non-2xx", async () => {
    activeServer = await startFakeServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const adapter = new LiteLLMAdapter("litellm", {
      base_url: activeServer.baseUrl,
      model: "gpt-4o-mini",
    });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("checkAvailability(): reports available:false without a network request when base_url is unset", async () => {
    const adapter = new LiteLLMAdapter("litellm", { model: "gpt-4o-mini" });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toContain("base_url");
  });
});
