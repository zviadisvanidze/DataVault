"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, request, session } from "./api";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const revision = useRef(0);
  const signingIn = useRef(false);
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(null);
  async function restore() {
    if (signingIn.current) return;
    const attempt = ++revision.current;
    setLoading(true);
    setError(null);
    if (!session.get()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const restored = await request("/auth/current-user");
      if (attempt === revision.current) setUser(restored);
    } catch (e) {
      if (attempt === revision.current && e.status !== 401) setError(e);
    } finally {
      if (attempt === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    restore();
    const expired = () => {
      setUser(null);
      setError(null);
    };
    window.addEventListener("datavault:expired", expired);
    return () => window.removeEventListener("datavault:expired", expired);
  }, []);
  useEffect(() => {
    if (!user) return;
    try {
      const encoded = session.get()?.split(".")[1];
      const payload = JSON.parse(
        atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (!payload.exp) return;
      const expire = () => {
        session.clear();
        window.dispatchEvent(new Event("datavault:expired"));
      };
      const remaining = payload.exp * 1000 - Date.now();
      if (remaining <= 0) {
        expire();
        return;
      }
      const timer = setTimeout(expire, remaining);
      return () => clearTimeout(timer);
    } catch {
      /* The backend validates token authenticity on every request. */
    }
  }, [user]);
  async function establishSession(result, attempt) {
    if (attempt !== revision.current) return;
    if (typeof result?.accessToken !== "string" || !result.accessToken)
      throw new ApiError(502);
    session.set(result.accessToken);
    try {
      const authenticated = await request("/auth/current-user");
      if (attempt === revision.current) setUser(authenticated);
    } catch (error) {
      if (attempt === revision.current) {
        session.clear();
        setUser(null);
      }
      throw error;
    }
  }
  async function authenticate(path, body) {
    // Supersede any pending restoration before exchanging a one-use code.
    const attempt = ++revision.current;
    signingIn.current = true;
    setError(null);
    setUser(null);
    session.clear();
    try {
      await establishSession(
        await request(path, {
          method: "POST",
          body,
          public: true,
        }),
        attempt,
      );
    } finally {
      if (attempt === revision.current) {
        signingIn.current = false;
        setLoading(false);
      }
    }
  }
  function login(body) {
    return authenticate("/auth/sign-in", body);
  }
  function exchangeGoogle(code) {
    return authenticate("/auth/google/exchange", { code });
  }
  function registerWithGoogle(body) {
    return authenticate("/auth/google/register", body);
  }
  function logout() {
    revision.current++;
    signingIn.current = false;
    setLoading(false);
    session.clear();
    setUser(null);
    setError(null);
  }
  return (
    <AuthContext.Provider
      value={{
        user,
        setUser,
        loading,
        error,
        restore,
        login,
        exchangeGoogle,
        registerWithGoogle,
        logout,
        isAdmin: user?.role === "company_owner",
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext);
