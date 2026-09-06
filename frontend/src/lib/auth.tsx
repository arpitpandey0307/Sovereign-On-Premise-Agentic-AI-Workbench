/**
 * Session and role context.
 *
 * Holds the signed-in user, their permissions from the policy engine, and the
 * one place the application decides what to *show*. It never decides what is
 * *allowed* -- the backend re-checks every call, and a hidden button is a
 * convenience rather than a control.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setUnauthorizedHandler, tokenStore } from "@/lib/api";
import type { LoginResponse, Permissions, Role, User } from "@/lib/types";

type AuthState = {
  user: User | null;
  permissions: Permissions | null;
  /** True until the stored token has been checked, so nothing flashes. */
  loading: boolean;
  /** Set when a session ended on its own rather than by signing out. */
  endedReason: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearEndedReason: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [endedReason, setEndedReason] = useState<string | null>(null);

  const clear = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setPermissions(null);
  }, []);

  // The API client calls this when the server rejects the session. Doing it
  // through a registered handler rather than inside the client keeps the
  // client free of React, and keeps sign-out in one place.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clear();
      setEndedReason("Your session ended. Sign in again to continue.");
    });
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const load = useCallback(async () => {
    // Both are needed before the shell renders: the user for identity, the
    // permissions for navigation. Fetching them together avoids a first paint
    // where the sidebar has the wrong items and then corrects itself.
    const [me, perms] = await Promise.all([
      api.get<User>("/api/v1/auth/me"),
      api.get<Permissions>("/api/v1/security/permissions"),
    ]);
    setUser(me);
    setPermissions(perms);
  }, []);

  // Resume a stored session, if it is still good.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        await load();
      } catch {
        // A token that no longer works must land on the login screen, not
        // inside a shell full of failing requests.
        clear();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, clear]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<LoginResponse>(
        "/api/v1/auth/login",
        { email, password },
        { anonymous: true },
      );
      tokenStore.set(result.access_token);
      setEndedReason(null);
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      // Signing out must always succeed locally. A failed round trip cannot
      // be a reason to leave someone signed in.
    }
    clear();
  }, [clear]);

  const value = useMemo(
    () => ({
      user,
      permissions,
      loading,
      endedReason,
      signIn,
      signOut,
      clearEndedReason: () => setEndedReason(null),
    }),
    [user, permissions, loading, endedReason, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

/**
 * What this user may see.
 *
 * `can` mirrors the backend's permission matrix. It is for rendering only --
 * every screen must still handle a 403 arriving from a call it thought was
 * permitted, because the server is the authority and it may disagree.
 */
export function useRole() {
  const { user, permissions } = useAuth();

  return useMemo(() => {
    const roles = permissions?.roles ?? user?.roles ?? [];
    const granted = new Set(permissions?.permissions ?? []);

    return {
      roles,
      clearance: permissions?.clearance ?? "none",
      readable: permissions?.readable_classifications ?? [],
      hasRole: (...wanted: Role[]) => wanted.some((role) => roles.includes(role)),
      can: (resource: string, action: string) =>
        granted.has(`${resource}:${action}`),
      /** Oversight roles: the security centre and the audit ledger. */
      isOversight: roles.includes("ADMIN") || roles.includes("SECURITY_ADMIN"),
      /**
       * True for a role that oversees the system without reading the corpus.
       * Several screens are legitimately empty for it, and must say so
       * deliberately rather than looking broken.
       */
      isSecurityOnly:
        roles.includes("SECURITY_ADMIN") && !roles.includes("ADMIN"),
    };
  }, [user, permissions]);
}

/** A readable label for a set of roles, for the sidebar and profile. */
export function roleLabel(roles: Role[]): string {
  if (roles.includes("ADMIN")) return "Administrator";
  if (roles.includes("SECURITY_ADMIN")) return "Security Administrator";
  if (roles.includes("MANAGER")) return "Manager";
  if (roles.includes("ANALYST")) return "Analyst";
  if (roles.includes("ENGINEER")) return "Engineering Analyst";
  return "No role assigned";
}
