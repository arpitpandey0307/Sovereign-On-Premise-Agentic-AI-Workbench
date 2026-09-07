import { useEffect, useRef, useState } from "react";
import { Camera, Check, Info, Loader2, Trash2, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  clearProfile,
  hasInstructions,
  instructionPreamble,
  loadProfile,
  saveProfile,
  toAvatarDataUrl,
  type Profile,
  type ResponseStyle,
} from "@/lib/profile";

/**
 * Personal settings.
 *
 * A photo, standing instructions the model is given on every request, and how
 * answers should be written. All of it stored in this browser, and the panel
 * says so at the top rather than implying an account that saves.
 *
 * The preview at the bottom is the point: it shows the exact text that will be
 * prepended to the next request. A "custom instructions" box whose effect you
 * cannot see is a box you have to trust, and on a system built around being
 * inspectable that is the wrong shape.
 */

const STYLES: Array<{ id: ResponseStyle; label: string; hint: string }> = [
  { id: "concise", label: "Concise", hint: "Finding first, no preamble" },
  { id: "standard", label: "Standard", hint: "The model's own judgement" },
  { id: "thorough", label: "Thorough", hint: "Shows its working" },
];

export function PersonalSettings() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile>(() => loadProfile(user?.id));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The identity arrives after the first render, and the stored profile is
  // keyed by it.
  useEffect(() => {
    setProfile(loadProfile(user?.id));
  }, [user?.id]);

  function update(patch: Partial<Profile>) {
    setProfile((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  function persist() {
    setError(null);
    if (saveProfile(user?.id, profile)) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    } else {
      setError(
        "This browser refused to store the settings — it may be in private mode, or storage may be disabled by policy.",
      );
    }
  }

  async function onPickPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      update({ avatar: await toAvatarDataUrl(file) });
    } catch {
      setError("That image could not be read. Try a JPEG or PNG.");
    } finally {
      setBusy(false);
    }
  }

  const preamble = instructionPreamble(profile);

  return (
    <section className="mt-8">
      <h3 className="section-title">Personal settings</h3>

      <p
        className="mt-2 flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px]"
        style={{
          background: "var(--warn-bg)",
          border: "1px solid var(--warn-line)",
          color: "var(--warn-text)",
        }}
      >
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        These are stored in this browser, not on your account — there is no
        per-user profile service on this deployment. They take effect
        immediately here, and will not follow you to another machine.
      </p>

      <div className="card mt-3">
        {/* --- photo --- */}
        <div className="flex items-center gap-4">
          <div className="profile-avatar">
            {profile.avatar ? (
              <img src={profile.avatar} alt="" />
            ) : (
              <UserRound className="size-6" aria-hidden />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Camera className="size-3.5" aria-hidden />
                )}
                {profile.avatar ? "Change photo" : "Add a photo"}
              </button>
              {profile.avatar && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => update({ avatar: null })}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Remove
                </button>
              )}
            </div>
            <p className="hint" style={{ marginTop: "6px" }}>
              Downscaled to 128px and kept in this browser. It never leaves the
              machine.
            </p>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp"
              onChange={onPickPhoto}
            />
          </div>
        </div>

        {/* --- who you are --- */}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Display name</span>
            <input
              className="input"
              value={profile.displayName}
              placeholder={user?.name ?? "Your name"}
              onChange={(event) => update({ displayName: event.target.value })}
            />
            <span className="hint">Shown in the shell instead of your account name.</span>
          </label>

          <label className="block">
            <span className="field-label">What you do</span>
            <input
              className="input"
              value={profile.role}
              placeholder="a rotating-equipment engineer on Unit 3"
              onChange={(event) => update({ role: event.target.value })}
            />
            <span className="hint">
              Given to the model so answers are pitched for your work.
            </span>
          </label>
        </div>

        {/* --- standing instructions --- */}
        <label className="mt-5 block">
          <span className="field-label">Standing instructions to the model</span>
          <textarea
            className="textarea"
            rows={4}
            value={profile.instructions}
            placeholder="Always cite the SOP clause number. Use metric units. Flag anything that would need a hot work permit."
            onChange={(event) => update({ instructions: event.target.value })}
          />
          <span className="hint">
            Prepended to every request you send from the workbench.
          </span>
        </label>

        {/* --- style --- */}
        <div className="mt-5">
          <span className="field-label">Answer style</span>
          <div className="effort-seg" style={{ marginTop: "4px" }}>
            {STYLES.map((option) => (
              <button
                key={option.id}
                type="button"
                title={option.hint}
                className={"effort-opt" + (profile.style === option.id ? " active" : "")}
                onClick={() => update({ style: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            checked={profile.flagUncertainty}
            onChange={(event) => update({ flagUncertainty: event.target.checked })}
            className="size-3.5 accent-[var(--accent)]"
          />
          Ask the model to say when the evidence is thin
        </label>

        {/* --- exactly what this does --- */}
        <div className="mt-5">
          <span className="field-label">What gets sent with your next request</span>
          {hasInstructions(profile) ? (
            <p
              className="mono mt-1 rounded-[var(--r-md)] p-3 text-[12px]"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text-dim)",
              }}
            >
              {preamble}
            </p>
          ) : (
            <p className="hint" style={{ marginTop: "4px" }}>
              Nothing. Your requests are sent exactly as you type them.
            </p>
          )}
        </div>

        {error && (
          <p className="error-note" style={{ marginTop: "12px" }}>
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-3">
          <button type="button" className="btn btn-sm btn-accent" onClick={persist}>
            {saved ? <Check className="size-3.5" aria-hidden /> : null}
            {saved ? "Saved" : "Save settings"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              clearProfile(user?.id);
              setProfile(loadProfile(user?.id));
              setSaved(false);
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  );
}
