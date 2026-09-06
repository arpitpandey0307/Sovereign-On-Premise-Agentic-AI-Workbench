/**
 * The single path to the backend.
 *
 * Every request in the application goes through here, which is what makes the
 * auth header, the error shape and the 401 handling one decision rather than
 * forty. A component that reaches for `fetch` directly has skipped all three.
 */

const TOKEN_KEY = "sovereign.token";
const EXPIRY_KEY = "sovereign.token.expires";

/** The backend's error envelope, which is the same for every failure. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Session token storage.
 *
 * sessionStorage rather than localStorage, deliberately. This is a shared
 * industrial workstation: a token in localStorage outlives the browser session
 * and is left behind for whoever sits down next. sessionStorage is not immune
 * to XSS either, but it does not leave a live credential lying around, which
 * is the realistic risk on a plant floor.
 */
export const tokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null; // private mode, or storage disabled by policy
    }
  },
  set(token: string, expiresAt?: string): void {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      // Kept beside the token so a page reload can tell an expired session
      // from a valid one before spending a request to find out.
      if (expiresAt) sessionStorage.setItem(EXPIRY_KEY, expiresAt);
    } catch {
      /* the session simply will not survive a reload; not fatal */
    }
  },
  /**
   * When the server says this token stops working.
   *
   * Advisory only: the backend decides, and a clock that disagrees changes
   * nothing about whether a call is accepted. It exists so the interface can
   * warn before the session ends instead of failing mid-sentence.
   */
  expiresAt(): Date | null {
    try {
      const raw = sessionStorage.getItem(EXPIRY_KEY);
      if (!raw) return null;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
    } catch {
      /* nothing to do */
    }
  },
};

/**
 * Called when the server rejects the session.
 *
 * Registered once by the auth provider. Held here so the client can react to
 * a 401 without importing React state, and so a burst of parallel requests
 * produces one sign-out rather than one per request.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
let unauthorizedFired = false;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
  unauthorizedFired = false;
}

function handleUnauthorized() {
  // A dashboard firing six queries must not produce six redirects. The latch
  // is released by the next successful request.
  if (unauthorizedFired) return;
  unauthorizedFired = true;
  tokenStore.clear();
  onUnauthorized?.();
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set for endpoints that legitimately answer without a session. */
  anonymous?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, anonymous = false } = options;

  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token && !anonymous) headers.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    // Deliberately no Content-Type: the browser has to set the multipart
    // boundary itself, and setting it by hand produces an unparseable body.
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: payload, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      "network_error",
      "The workbench backend could not be reached. It may not be running.",
      0,
    );
  }

  if (response.status === 401 && !anonymous) {
    handleUnauthorized();
  }
  unauthorizedFired = response.ok ? false : unauthorizedFired;

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) throw toApiError(parsed, response.status);
  return parsed as T;
}

function toApiError(parsed: unknown, status: number): ApiError {
  const envelope = (parsed as { error?: Record<string, unknown> } | null)?.error;
  if (envelope && typeof envelope === "object") {
    return new ApiError(
      String(envelope.code ?? "error"),
      String(envelope.message ?? "The request failed."),
      status,
      (envelope.details as Record<string, unknown>) ?? {},
    );
  }
  // A response that is not the envelope came from somewhere other than the
  // application -- a proxy, or a crash before the handlers ran.
  return new ApiError(
    "unexpected_response",
    `The server returned an unexpected ${status} response.`,
    status,
  );
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),

  /**
   * Fetch a file with the session attached.
   *
   * Downloads cannot be a plain anchor: the href would carry no Authorization
   * header and the server would refuse it.
   */
  async download(path: string, filename: string): Promise<void> {
    const token = tokenStore.get();
    const response = await fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* fall through to the generic error */
      }
      throw toApiError(parsed, response.status);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};

function formatWait(seconds: number): string {
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
  const minutes = Math.ceil(whole / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** A message a person can act on, for each error the backend actually returns. */
export function describeError(error: unknown): { title: string; detail: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: "Something went wrong",
      detail: "An unexpected error occurred. Try again.",
    };
  }

  switch (error.code) {
    case "unauthenticated":
      return {
        title: "Session ended",
        detail: "Sign in again to continue.",
      };
    case "permission_denied":
      return {
        title: "Not permitted",
        detail: error.message,
      };
    case "not_found":
      return {
        title: "Not found",
        detail: "This item does not exist, or is not available to your role.",
      };
    case "conflict":
      return { title: "Cannot do that yet", detail: error.message };
    case "payload_too_large":
      return { title: "File too large", detail: error.message };
    case "unsupported_media_type":
      return { title: "Unsupported file type", detail: error.message };
    case "validation_error":
      return {
        title: "Check the form",
        detail: "One or more fields need attention.",
      };
    case "bad_request":
      return { title: "That request could not be used", detail: error.message };
    // The login throttle answers with `too_many_attempts` and carries the
    // wait; a plain 429 anywhere else answers with `rate_limited`. Both need
    // to say when to try again, or the only remaining option is guessing.
    case "too_many_attempts":
    case "rate_limited": {
      const wait = Number(error.details.retry_after_seconds);
      return {
        title: "Too many attempts",
        detail: Number.isFinite(wait) && wait > 0
          ? `Wait ${formatWait(wait)} before trying again.`
          : error.message,
      };
    }
    case "upstream_timeout":
      return {
        title: "The model runtime did not respond",
        detail: "It may be loading a model. Try again in a moment.",
      };
    case "network_error":
      return { title: "Backend unreachable", detail: error.message };
    case "internal_error":
    case "unexpected_response":
      // The backend already returns generic text here, but the client must
      // not rely on that: an internal failure is exactly the case where a
      // message might carry something from inside the system.
      return {
        title: "Something went wrong",
        detail:
          "The request could not be completed. The failure has been logged on the server.",
      };
    default:
      return {
        title: "Something went wrong",
        detail: error.message,
      };
  }
}
