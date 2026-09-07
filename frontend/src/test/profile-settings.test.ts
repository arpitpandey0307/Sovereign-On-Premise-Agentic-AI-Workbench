/**
 * Personal settings, and what they actually do to a request.
 *
 * The instructions box is only worth having if its effect is exact and
 * inspectable. Two properties matter: an untouched profile must change nothing
 * — a preamble the person never wrote, silently prepended to every question, is
 * the failure that makes an assistant untrustworthy — and everything that does
 * appear must be traceable to something they typed or explicitly chose.
 *
 * Profiles are keyed per user because these are shared industrial
 * workstations: the next person to sign in must not inherit the last one's
 * standing instructions.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE,
  clearProfile,
  hasInstructions,
  instructionPreamble,
  loadProfile,
  saveProfile,
} from "@/lib/profile";

afterEach(() => {
  localStorage.clear();
});

describe("the instruction preamble", () => {
  it("is empty for an untouched profile", () => {
    expect(instructionPreamble(EMPTY_PROFILE)).toBe("");
    expect(hasInstructions(EMPTY_PROFILE)).toBe(false);
  });

  it("carries the operator's own words verbatim", () => {
    const preamble = instructionPreamble({
      ...EMPTY_PROFILE,
      instructions: "Always cite the SOP clause number.",
    });
    expect(preamble).toBe("Always cite the SOP clause number.");
  });

  it("states who is asking, when they have said", () => {
    const preamble = instructionPreamble({
      ...EMPTY_PROFILE,
      role: "a rotating-equipment engineer on Unit 3",
    });
    expect(preamble).toContain("a rotating-equipment engineer on Unit 3");
  });

  it("adds nothing for the standard answer style", () => {
    // "Standard" means the model's own judgement, so it must not smuggle in an
    // instruction of its own.
    expect(instructionPreamble({ ...EMPTY_PROFILE, style: "standard" })).toBe("");
    expect(instructionPreamble({ ...EMPTY_PROFILE, style: "concise" })).not.toBe("");
  });

  it("only mentions uncertainty when that was switched on", () => {
    expect(instructionPreamble(EMPTY_PROFILE)).not.toMatch(/evidence is thin/i);
    expect(
      instructionPreamble({ ...EMPTY_PROFILE, flagUncertainty: true }),
    ).toMatch(/evidence is thin/i);
  });
});

describe("storage", () => {
  it("keeps each user's settings apart on a shared workstation", () => {
    saveProfile("user-a", { ...EMPTY_PROFILE, instructions: "Use metric units." });

    expect(loadProfile("user-a").instructions).toBe("Use metric units.");
    // The next person to sign in at this terminal inherits nothing.
    expect(loadProfile("user-b").instructions).toBe("");
  });

  it("loads a profile written before a field existed", () => {
    // Merged over the defaults rather than replacing them, so an older stored
    // shape does not produce undefined fields the UI then renders.
    localStorage.setItem(
      "sovereign.profile.user-a",
      JSON.stringify({ instructions: "Cite the clause." }),
    );
    const profile = loadProfile("user-a");
    expect(profile.instructions).toBe("Cite the clause.");
    expect(profile.style).toBe("standard");
    expect(profile.avatar).toBeNull();
  });

  it("survives storage being unreadable", () => {
    localStorage.setItem("sovereign.profile.user-a", "not json");
    expect(loadProfile("user-a")).toEqual(EMPTY_PROFILE);
  });

  it("clears back to nothing", () => {
    saveProfile("user-a", { ...EMPTY_PROFILE, role: "an analyst" });
    clearProfile("user-a");
    expect(loadProfile("user-a")).toEqual(EMPTY_PROFILE);
  });
});
