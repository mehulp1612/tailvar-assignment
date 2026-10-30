import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { User, Policy, Claim } from "../shared/domain";
import { formatMoney } from "./format";
import "./styles.css";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(result.error || "Request failed.", response.status);
  return result;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    api<User>("/auth/me")
      .then(setUser)
      .catch((error) => {
        if (!(error instanceof ApiError && error.status === 401))
          setError(message(error));
      })
      .finally(() => setStarting(false));
  }, []);
  async function logout() {
    try {
      await api("/auth/logout", {});
      setUser(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
      else setError(message(error));
    }
  }
  return (
    <>
      <header>
        <a className="brand" href="/">
          TailVaR<span>POLICY DESK</span>
        </a>
        {user && (
          <div className="account">
            <span>
              {user.username}
              <small>{user.role}</small>
            </span>
            <button className="secondary" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main>
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {starting ? (
          <p role="status">Loading your workspace…</p>
        ) : user ? (
          <Dashboard
            user={user}
            expired={() => {
              setUser(null);
              setError("Your session expired. Please sign in again.");
            }}
          />
        ) : (
          <Login onLogin={setUser} />
        )}
      </main>
      <footer>
        TailVaR Consulting · Insurance administration{" "}
        <span>Fictional demo data only</span>
      </footer>
    </>
  );
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      onLogin(
        await api<User>("/auth/login", {
          username: data.get("username"),
          password: data.get("password"),
        }),
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="intro">
        <p className="eyebrow">COVERAGE, WITH CLARITY</p>
        <h1>
          Your policies.
          <br />
          Every claim.
          <br />
          <em>One clear view.</em>
        </h1>
        <p>Manage coverage and follow claims from submission to decision.</p>
        <div className="intro-note">
          Secure access for customers and administrators.
        </div>
      </section>
      <section className="card login-card">
        <p className="eyebrow">WELCOME BACK</p>
        <h2>Sign in to your workspace</h2>
        <form onSubmit={submit}>
          <label>
            Username
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy}>{busy ? "Signing in…" : "Sign in →"}</button>
        </form>
        <details>
          <summary>Demo access</summary>
          <p>Use one of the fictional accounts below.</p>
          <dl>
            <dt>Customer 1</dt>
            <dd>customer1 / Customer1@Demo26</dd>
            <dt>Customer 2</dt>
            <dd>customer2 / Customer2@Demo26</dd>
            <dt>Administrator</dt>
            <dd>admin / Admin@Demo26</dd>
          </dl>
        </details>
      </section>
    </div>
  );
}
function Dashboard({ user, expired }: { user: User; expired: () => void }) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [customers, setCustomers] = useState<
    { id: string; username: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const admin = user.role === "Administrator";
  const selected = policies.find((p) => p.id === policyId);
  function handle(error: unknown) {
    if (error instanceof ApiError && error.status === 401) expired();
    else setError(message(error));
  }
  async function refresh() {
    setLoading(true);
    try {
      const [p, c, u] = await Promise.all([
        api<Policy[]>("/policies"),
        api<Claim[]>("/claims"),
        admin
          ? api<{ id: string; username: string }[]>("/customers")
          : Promise.resolve([]),
      ]);
      setPolicies(p);
      setClaims(c);
      setCustomers(u);
    } catch (error) {
      handle(error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [user.id]);
  async function mutate(
    path: string,
    body: unknown,
    text: string,
    done?: () => void,
  ) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(path, body);
      done?.();
      setSuccess(text);
      await refresh();
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  }
  function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void mutate("/policies", Object.fromEntries(data), "Policy created.", () =>
      form.reset(),
    );
  }
  function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    void mutate(
      "/claims",
      { ...Object.fromEntries(new FormData(form)), requestId },
      "Claim submitted. Its amount is now reserved.",
      () => {
        form.reset();
        setPolicyId("");
        setRequestId(crypto.randomUUID());
      },
    );
  }
  const reserved = policies.reduce(
    (sum, p) => sum + p.sumInsured - p.remaining,
    0,
  );
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">
            {admin ? "ADMINISTRATOR WORKSPACE" : "CUSTOMER WORKSPACE"}
          </p>
          <h1>{admin ? "Coverage overview" : "Your coverage, at a glance"}</h1>
          <p>
            {admin
              ? "Manage policies and make confident claim decisions."
              : "View your policies, submit a claim, and follow its progress."}
          </p>
        </div>
        <button
          className="secondary"
          disabled={loading || busy}
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="notice success" role="status">
          {success}
        </div>
      )}
      <div className="stats">
        <article>
          <span>Policies</span>
          <strong>{policies.length}</strong>
        </article>
        <article>
          <span>Remaining claimable SI</span>
          <strong>
            {formatMoney(policies.reduce((sum, p) => sum + p.remaining, 0))}
          </strong>
        </article>
        <article>
          <span>Reserved & approved</span>
          <strong>{formatMoney(reserved)}</strong>
        </article>
        <article>
          <span>Awaiting decision</span>
          <strong>
            {claims.filter((c) => c.status === "Submitted").length}
          </strong>
        </article>
      </div>
      <div className="workspace">
        <section className="card form-card">
          <p className="eyebrow">{admin ? "NEW COVERAGE" : "START A CLAIM"}</p>
          <h2>{admin ? "Create a policy" : "Submit a claim"}</h2>
          {admin ? (
            <form onSubmit={createPolicy}>
              <label>
                Customer
                <select name="customerId" required defaultValue="">
                  <option value="" disabled>
                    Select customer
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.username}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Coverage start
                <input
                  name="startDate"
                  type="date"
                  min="1900-01-01"
                  max="9999-12-31"
                  required
                />
              </label>
              <label>
                Coverage end
                <input
                  name="endDate"
                  type="date"
                  min="1900-01-01"
                  max="9999-12-31"
                  required
                />
              </label>
              <label>
                Sum insured (INR)
                <input
                  name="sumInsured"
                  type="number"
                  min="0.01"
                  max="9999999999.99"
                  step="0.01"
                  placeholder="1000000.00"
                  required
                />
              </label>
              <button disabled={busy || loading}>
                {busy ? "Saving…" : "Create policy"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={submitClaim}
              onChange={() => setRequestId(crypto.randomUUID())}
            >
              <label>
                Policy
                <select
                  name="policyId"
                  required
                  value={policyId}
                  onChange={(event) => setPolicyId(event.target.value)}
                >
                  <option value="" disabled>
                    Select your policy
                  </option>
                  {policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id.slice(0, 8)} · {formatMoney(p.remaining)} available
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <p className="hint">
                  Coverage: {selected.startDate} to {selected.endDate}
                  <br />
                  Available: {formatMoney(selected.remaining)}
                </p>
              )}
              <label>
                Incident date
                <input
                  name="incidentDate"
                  type="date"
                  min={selected?.startDate || "1900-01-01"}
                  max={selected?.endDate || "9999-12-31"}
                  required
                />
              </label>
              <label>
                Claim amount (INR)
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  max={selected ? selected.remaining / 100 : "9999999999.99"}
                  step="0.01"
                  placeholder="0.00"
                  required
                />
              </label>
              <p className="hint">
                Submitted claims reserve your sum insured immediately. Rejected
                claims release it.
              </p>
              <button disabled={busy || loading || policies.length === 0}>
                {busy ? "Submitting…" : "Submit claim"}
              </button>
            </form>
          )}
        </section>
        <section className="card policies-card">
          <div className="section-title">
            <h2>{admin ? "All policies" : "Your policies"}</h2>
            <span className="count">{policies.length}</span>
          </div>
          {policies.length === 0 ? (
            <div className="empty">
              <h3>No policies yet</h3>
              <p>
                {admin
                  ? "Create the first policy using the form."
                  : "Your administrator will assign coverage here."}
              </p>
            </div>
          ) : (
            <div className="policy-list">
              {policies.map((p) => (
                <article className="policy" key={p.id}>
                  <div className="policy-heading">
                    <strong>Policy {p.id.slice(0, 8)}</strong>
                    {admin && <span>{p.customer}</span>}
                  </div>
                  <p className="id">{p.id}</p>
                  <p className="hint">
                    {p.startDate} — {p.endDate}
                  </p>
                  <div className="policy-money">
                    <div>
                      <small>Original SI</small>
                      <strong>{formatMoney(p.sumInsured)}</strong>
                    </div>
                    <div>
                      <small>Remaining</small>
                      <strong>{formatMoney(p.remaining)}</strong>
                    </div>
                  </div>
                  <progress
                    aria-label={`Remaining coverage for policy ${p.id}`}
                    value={p.remaining}
                    max={p.sumInsured}
                  />
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="card claims-card">
        <div className="section-title">
          <div>
            <h2>{admin ? "Claims review" : "Your claims"}</h2>
            <p className="hint">
              Submitted reserves coverage · Approved consumes coverage ·
              Rejected releases coverage
            </p>
          </div>
          <span className="count">{claims.length}</span>
        </div>
        {claims.length === 0 ? (
          <div className="empty">
            <h3>No claims yet</h3>
            <p>Claims will appear here as they are submitted.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Claim / Policy</th>
                  {admin && <th>Customer</th>}
                  <th>Incident date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  {admin && <th>Decision</th>}
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span title={c.id}>{c.id.slice(0, 8)}</span>
                      <small title={c.policyId}>
                        Policy {c.policyId.slice(0, 8)}
                      </small>
                    </td>
                    {admin && <td>{c.customer}</td>}
                    <td>{c.incidentDate}</td>
                    <td className="amount">{formatMoney(c.amount)}</td>
                    <td>
                      <span className={`badge ${c.status.toLowerCase()}`}>
                        {c.status}
                      </span>
                    </td>
                    {admin && (
                      <td>
                        {c.status === "Submitted" ? (
                          <div className="actions">
                            <button
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `/claims/${c.id}/decision`,
                                  { status: "Approved" },
                                  "Claim approved. Reserved coverage remains consumed.",
                                )
                              }
                            >
                              Approve
                            </button>
                            <button
                              className="reject"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `/claims/${c.id}/decision`,
                                  { status: "Rejected" },
                                  "Claim rejected. Reserved coverage has been released.",
                                )
                              }
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="hint">Decision recorded</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
