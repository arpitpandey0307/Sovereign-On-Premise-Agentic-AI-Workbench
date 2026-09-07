/**
 * Personal settings: a photo, standing instructions for the model, and how
 * answers should be written.
 *
 * These live in this browser, not on the server, and the interface says so
 * plainly. There is no per-user profile endpoint on this deployment, and the
 * alternative — a form that looks like it saves to an account and does not —
 * is the thing this product cannot afford to do.
 *
 * Local does not mean decorative. The standing instructions are genuinely
 * prepended to every request the workbench sends, and the photo is genuinely
 * the avatar in the shell. What is missing is only that they do not follow you
 * to another machine.
 *
 * `localStorage` rather than `sessionStorage`, unlike the session token: this
 * is a preference with no security value, and it is meant to survive the
 * sign-outs a shared workstation produces all day. It is keyed per user id, so
 * two people at the same terminal do not inherit each other's instructions.
 */

export type ResponseStyle = "concise" | "standard" | "thorough";

export type Profile = {
  /** A data URL. Small by construction — the image is downscaled on the way in. */
  avatar: string | null;
  displayName: string;
  /** What this person does, so answers can be pitched correctly. */
  role: string;
  /** Standing instructions, prepended to every request. */
  instructions: string;
  style: ResponseStyle;
  /** Ask the model to state its uncertainty rather than smoothing over it. */
  flagUncertainty: boolean;
};

export const EMPTY_PROFILE: Profile = {
  avatar: null,
  displayName: "",
  role: "",
  instructions: "",
  style: "standard",
  // Off by default, deliberately. An untouched profile must not quietly add
  // an instruction the person never wrote -- the preamble is only ever their
  // own words or their own explicit choice, and an empty profile sends the
  // request exactly as typed.
  flagUncertainty: false,
};

const KEY = "sovereign.profile";

function keyFor(userId: string | undefined): string {
  return userId ? `${KEY}.${userId}` : KEY;
}

export function loadProfile(userId: string | undefined): Profile {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return EMPTY_PROFILE;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    // Merged over the defaults, so a profile written by an older version that
    // lacks a field still loads.
    return { ...EMPTY_PROFILE, ...parsed };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function saveProfile(userId: string | undefined, profile: Profile): boolean {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(profile));
    // Same-tab listeners; the storage event only fires in *other* tabs.
    window.dispatchEvent(new CustomEvent("sovereign:profile"));
    return true;
  } catch {
    // Quota, or storage disabled by policy. The caller says so rather than
    // pretending the save happened.
    return false;
  }
}

export function clearProfile(userId: string | undefined): void {
  try {
    localStorage.removeItem(keyFor(userId));
    window.dispatchEvent(new CustomEvent("sovereign:profile"));
  } catch {
    /* nothing to clear */
  }
}

const STYLE_INSTRUCTION: Record<ResponseStyle, string> = {
  concise: "Answer briefly. Lead with the finding; omit preamble.",
  standard: "",
  thorough: "Work through the reasoning and show the steps you took.",
};

/**
 * The preamble the workbench prepends to a request.
 *
 * Returns an empty string when nothing has been set, so a request with no
 * profile is sent exactly as typed. Everything here is the operator's own
 * words or their own explicit choice — nothing is inferred about them and
 * silently added, which is the failure mode that makes a memory feature
 * untrustworthy.
 */
export function instructionPreamble(profile: Profile): string {
  const parts: string[] = [];

  if (profile.role.trim()) {
    parts.push(`The person asking is ${profile.role.trim()}.`);
  }
  if (profile.instructions.trim()) {
    parts.push(profile.instructions.trim());
  }
  const style = STYLE_INSTRUCTION[profile.style];
  if (style) parts.push(style);
  if (profile.flagUncertainty) {
    parts.push("Where the evidence is thin, say so rather than filling the gap.");
  }

  return parts.join(" ");
}

/** True when the profile would actually change a request. */
export function hasInstructions(profile: Profile): boolean {
  return instructionPreamble(profile).length > 0;
}

/**
 * Downscale a chosen image to a small square data URL.
 *
 * Kept small deliberately: `localStorage` holds a few megabytes for the whole
 * origin, and a full-size photograph from a phone would consume all of it and
 * break every other preference on the way out.
 */
export async function toAvatarDataUrl(file: File, size = 128): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot process the image.");

  // Cover, centred: a portrait should not be squashed into a square.
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.82);
}
