import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

// jsdom implements neither, and components legitimately use both.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }),
});

// Scroll-triggered animation needs this, and jsdom has no layout to observe.
// The stub reports every observed element as visible immediately, which is
// the same assumption the components themselves fall back to when the API is
// missing: showing content is always safer than hiding it.
if (!("IntersectionObserver" in window)) {
  class ImmediateIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly scrollMargin = "";
    readonly thresholds = [0];
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
            target,
            time: 0,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }

    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  // defineProperty rather than assignment: narrowing inside this guard tells
  // the compiler the property does not exist, which it is right about.
  const stub = ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(window, "IntersectionObserver", { writable: true, value: stub });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    value: stub,
  });
}

// jsdom has no top layer, so `<dialog>` is inert there. The shim gives the
// element the two methods and the `open` state the component drives it with,
// which is all a test can meaningfully observe -- focus containment and the
// backdrop are the browser's job and are not simulated here.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(returnValue?: string) {
    if (!this.open) return;
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}

if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = vi.fn(() => "blob:test");
  window.URL.revokeObjectURL = vi.fn();
}
