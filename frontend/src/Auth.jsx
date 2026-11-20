import { useState } from "react";
import { api } from "./api.js";

export default function Auth({ onAuthenticated, initialError = "" }) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      const user = await api(`/auth/${registering ? "register" : "login"}`, {
        method: "POST", body: JSON.stringify(fields),
      });
      onAuthenticated(user);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="panel auth-panel">
        <div className="auth-brand"><span className="brand-mark">c.</span><h1>counter.</h1></div>
        <p className="eyebrow">{registering ? "YOUR NEXT GOOD ORDER STARTS HERE" : "WELCOME BACK"}</p>
        <h2>{registering ? "Create your account" : "Log in to Counter"}</h2>
        <p className="muted">{registering ? "Register to browse the menu and place your own orders." : "Kindly login to experience best service."}</p>
        {error && <div role="alert" className="error-banner">{error}</div>}
        <form onSubmit={submit} className="stack-form" key={registering ? "register" : "login"}>
          {registering && <label>Name<input name="name" required maxLength="100" autoComplete="name" disabled={busy} /></label>}
          <label>Email<input name="email" type="email" required maxLength="254" autoComplete="username" disabled={busy} /></label>
          <label>Password<input name="password" type="password" required minLength={registering ? 8 : 1}
            maxLength="128" autoComplete={registering ? "new-password" : "current-password"} disabled={busy} /></label>
          {registering && <p className="muted">Use at least 8 characters. Registration creates a customer account.</p>}
          <button className="button primary full" disabled={busy}>{busy ? "Please wait..." : registering ? "Create account" : "Log in"}</button>
        </form>
        <button className="clear-cart" disabled={busy} onClick={() => {
          setRegistering(!registering);
          setError("");
        }}>{registering ? "Already registered? Log in" : "New customer? Create an account"}</button>
      </section>
    </div>
  );
}

