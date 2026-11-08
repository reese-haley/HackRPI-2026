"use client";

import { FormEvent, useState } from "react";
import { supabase } from "@/lib/client";

/** Sign in / create account. The parent page switches views when the session appears. */
export default function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username: username.trim() } },
      });
      if (error) setError(error.message);
      else if (!data.session) setNotice("Check your email to confirm your account, then sign in.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    }
    setBusy(false);
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto 0" }}>
      <h1>Fantasy leagues for anything.</h1>
      <p className="muted" style={{ marginBottom: 32 }}>
        Pick a topic. We pull live questions from Polymarket. Predict, earn points for being right, and beat your
        friends.
      </p>

      <form onSubmit={submit}>
        {mode === "signup" && (
          <>
            <label htmlFor="username">Username</label>
            <input id="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
          </>
        )}
        <label htmlFor="email">Email</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        {notice && <div className="error">{notice}</div>}
        <button disabled={busy} style={{ width: "100%" }}>
          {busy ? "..." : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="muted" style={{ marginTop: 16 }}>
        {mode === "signin" ? "New here? " : "Have an account? "}
        <button className="link" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
