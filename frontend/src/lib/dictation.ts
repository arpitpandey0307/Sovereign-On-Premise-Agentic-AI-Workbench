/**
 * Voice input, using the browser's own speech recognition.
 *
 * A deliberate constraint: this uses the Web Speech API, which in Chrome sends
 * audio to Google's servers to be transcribed. On the air-gapped box that is
 * simply unavailable — there is no route to it — so the button must be absent
 * rather than present and broken, and `isSupported()` is what the composer asks
 * before offering it at all.
 *
 * That is also why nothing here touches a task or a document: dictation only
 * ever fills the text box, and the operator reads what it heard before sending
 * anything. Speech that went straight into a task would put an unreviewed
 * transcription in front of a model, on a system whose whole argument is that
 * you can see what it was given.
 *
 * A local Whisper endpoint would replace this module without changing the
 * composer; the interface below is deliberately small enough for that.
 */

/** The vendor-prefixed constructor, as it actually appears in browsers. */
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

function constructor(): SpeechRecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can transcribe at all. */
export function isSupported(): boolean {
  return constructor() !== null;
}

export type DictationHandlers = {
  /** Fires as words arrive: the settled text so far, plus what it is still unsure of. */
  onTranscript: (final: string, interim: string) => void;
  /** A message fit to show a person, or null when they simply stopped. */
  onError: (message: string | null) => void;
  onEnd: () => void;
};

/** A run of dictation. `stop()` ends it; the handlers stop firing afterwards. */
export type Dictation = { stop: () => void };

/**
 * Messages for the failures that actually happen.
 *
 * `not-allowed` is the common one and is not an error in the product's sense —
 * the person declined the microphone, which is a legitimate answer and must
 * not be reported as a fault.
 */
function describe(error: string): string | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was not granted. Type your request instead.";
    case "no-speech":
      return null;
    case "aborted":
      return null;
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs a network the browser cannot reach here. Type your request instead.";
    default:
      return "Dictation stopped unexpectedly. Type your request instead.";
  }
}

export function startDictation(handlers: DictationHandlers): Dictation | null {
  const Ctor = constructor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = "en-IN";
  // Keep listening through the pauses in dictated prose, and show words as
  // they are heard so the person can see it is working.
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let settled = "";
  let stopped = false;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) settled += text;
      else interim += text;
    }
    handlers.onTranscript(settled.trim(), interim.trim());
  };

  recognition.onerror = (event) => {
    if (stopped) return;
    handlers.onError(describe(event.error));
  };

  recognition.onend = () => {
    if (!stopped) handlers.onEnd();
  };

  try {
    recognition.start();
  } catch {
    // Already running, or blocked outright.
    return null;
  }

  return {
    stop() {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
      handlers.onEnd();
    },
  };
}
