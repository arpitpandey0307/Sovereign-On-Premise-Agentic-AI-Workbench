import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  describeError,
  setUnauthorizedHandler,
  tokenStore,
} from "@/lib/api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(code: string, message = "nope", status = 400) {
  return jsonResponse({ error: { code, message, details: {} } }, status);
}

describe("the API client", () => {
  beforeEach(() => {
    setUnauthorizedHandler(null);
    tokenStore.clear();
  });

  it("attaches the session token", async () => {
    tokenStore.set("token-123");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/v1/auth/me");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer token-123");
  });

  it("omits the token on anonymous calls", async () => {
    tokenStore.set("token-123");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/v1/auth/login", {}, { anonymous: true });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("does not set Content-Type for FormData", async () => {
    // The browser has to choose the multipart boundary itself; setting the
    // header by hand produces a body the server cannot parse.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/v1/files/upload", new FormData());

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it.each([
    ["permission_denied", 403],
    ["not_found", 404],
    ["validation_error", 422],
    ["upstream_timeout", 504],
  ])("turns the %s envelope into an ApiError", async (code, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(envelope(code, "m", status)));

    await expect(api.get("/api/v1/documents")).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("reports an unreachable backend rather than a parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("refused")));

    const error = await api
      .get("/api/v1/documents")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("network_error");
  });

  it("handles a response that is not the error envelope", async () => {
    // A proxy or a crash before the handlers ran produces something else
    // entirely; it must not surface as an unhandled parse error.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })),
    );

    await expect(api.get("/api/v1/documents")).rejects.toMatchObject({
      code: "unexpected_response",
      status: 502,
    });
  });

  it("signs out once when several parallel requests are rejected", async () => {
    // A dashboard firing six queries must not produce six redirects.
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    tokenStore.set("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(envelope("unauthenticated", "expired", 401)),
    );

    await Promise.allSettled([
      api.get("/a"),
      api.get("/b"),
      api.get("/c"),
      api.get("/d"),
    ]);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(tokenStore.get()).toBeNull();
  });

  it("does not sign out on a permission denial", async () => {
    // A 403 is information the screen should render. Bouncing the user away
    // hides the reason and makes a governed system feel broken.
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    tokenStore.set("good");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(envelope("permission_denied", "no", 403)),
    );

    await api.get("/api/v1/security/audit").catch(() => {});

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(tokenStore.get()).toBe("good");
  });

  it("returns undefined for 204 rather than failing to parse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.delete("/api/v1/files/x")).resolves.toBeUndefined();
  });
});

describe("error descriptions", () => {
  it("gives every backend code an actionable message", () => {
    const codes = [
      "unauthenticated",
      "permission_denied",
      "not_found",
      "conflict",
      "payload_too_large",
      "unsupported_media_type",
      "validation_error",
      "too_many_attempts",
      "upstream_timeout",
      "network_error",
      "internal_error",
    ];

    for (const code of codes) {
      const { title, detail } = describeError(new ApiError(code, "raw", 400));
      expect(title.length).toBeGreaterThan(0);
      expect(detail.length).toBeGreaterThan(0);
    }
  });

  it("never leaks a raw internal error to the user", () => {
    const { detail } = describeError(
      new ApiError("internal_error", "Traceback: secret", 500),
    );
    expect(detail).not.toContain("Traceback");
  });
});

describe("token storage", () => {
  it("uses sessionStorage, not localStorage", () => {
    // A shared industrial workstation must not be left holding a live
    // credential for whoever sits down next.
    tokenStore.set("abc");
    expect(sessionStorage.getItem("sovereign.token")).toBe("abc");
    expect(localStorage.getItem("sovereign.token")).toBeNull();
  });

  it("survives storage being unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked by policy");
    });
    expect(tokenStore.get()).toBeNull();
    spy.mockRestore();
  });
});
