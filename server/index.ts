import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import {
  claimSchema,
  decisionSchema,
  policySchema,
  type User,
} from "../shared/domain";

type Env = {
  Bindings: { DB: D1Database };
  Variables: { user: User; token: string };
};
const app = new Hono<Env>();
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
const digest = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
      },
      key,
      256,
    ),
  );
}
function equal(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
function fail(
  status: 400 | 401 | 403 | 404 | 409 | 429,
  message: string,
): never {
  throw new HTTPException(status, { message });
}

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      fail(403, "Request origin is not allowed.");
    if (c.req.header("Sec-Fetch-Site") === "cross-site")
      fail(403, "Cross-site requests are not allowed.");
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      fail(400, "Send an application/json request.");
    if (Number(c.req.header("Content-Length") || 0) > 8192)
      fail(400, "Request is too large.");
  }
  await next();
});

app.post("/api/auth/login", async (c) => {
  const { username, password } = z
    .object({
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(200),
    })
    .strict()
    .parse(await c.req.json());
  const now = Math.floor(Date.now() / 1000);
  const key = await digest(
    `${c.req.header("CF-Connecting-IP") || "local"}:${username.toLowerCase()}`,
  );
  const attempt = await c.env.DB.prepare(
    `INSERT INTO login_attempts(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count+1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count`,
  )
    .bind(key, now + 300, now, now)
    .first<{ count: number }>();
  if (attempt && attempt.count > 20)
    fail(429, "Too many login attempts. Try again in five minutes.");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?")
    .bind(username)
    .first<User & { password_hash: string; salt: string }>();
  const hash = await passwordHash(
    password,
    user?.salt || "tailvar-demo-unknown",
  );
  if (!user || !equal(hash, user.password_hash))
    fail(401, "Incorrect username or password.");
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(
      now,
    ),
    c.env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
    ).bind(await digest(token), user.id, now + 28800),
  ]);
  setCookie(c, "session", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 28800,
  });
  return c.json({ id: user.id, username: user.username, role: user.role });
});

app.use("/api/*", async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) fail(401, "Please sign in.");
  const hash = await digest(token);
  const user = await c.env.DB.prepare(
    "SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(hash, Math.floor(Date.now() / 1000))
    .first<User>();
  if (!user) fail(401, "Your session has expired. Please sign in.");
  c.set("user", user);
  c.set("token", hash);
  await next();
});
app.get("/api/auth/me", (c) => c.json(c.get("user")));
app.post("/api/auth/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(c.get("token"))
    .run();
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});
app.get("/api/customers", async (c) => {
  if (c.get("user").role !== "Administrator")
    fail(403, "Administrator access required.");
  return c.json(
    (
      await c.env.DB.prepare(
        "SELECT id,username FROM users WHERE role='Customer' ORDER BY username",
      ).all()
    ).results,
  );
});
app.get("/api/policies", async (c) => {
  const user = c.get("user");
  return c.json(
    (
      await c.env.DB.prepare(
        `SELECT p.id,p.customer_id AS customerId,u.username AS customer,p.start_date AS startDate,p.end_date AS endDate,p.sum_insured AS sumInsured,p.sum_insured-COALESCE(SUM(CASE WHEN cl.status IN ('Submitted','Approved') THEN cl.amount ELSE 0 END),0) AS remaining FROM policies p JOIN users u ON u.id=p.customer_id LEFT JOIN claims cl ON cl.policy_id=p.id WHERE (?='Administrator' OR p.customer_id=?) GROUP BY p.id ORDER BY p.created_at DESC,p.id`,
      )
        .bind(user.role, user.id)
        .all()
    ).results,
  );
});
app.post("/api/policies", async (c) => {
  if (c.get("user").role !== "Administrator")
    fail(403, "Administrator access required.");
  const input = policySchema.parse(await c.req.json());
  const owner = await c.env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND role='Customer'",
  )
    .bind(input.customerId)
    .first();
  if (!owner) fail(400, "Select a valid customer.");
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO policies(id,customer_id,start_date,end_date,sum_insured) VALUES (?,?,?,?,?)",
  )
    .bind(
      id,
      input.customerId,
      input.startDate,
      input.endDate,
      input.sumInsured,
    )
    .run();
  return c.json({ id }, 201);
});
app.get("/api/claims", async (c) => {
  const user = c.get("user");
  return c.json(
    (
      await c.env.DB.prepare(
        `SELECT cl.id,cl.policy_id AS policyId,u.username AS customer,cl.incident_date AS incidentDate,cl.amount,cl.status FROM claims cl JOIN policies p ON p.id=cl.policy_id JOIN users u ON u.id=p.customer_id WHERE (?='Administrator' OR p.customer_id=?) ORDER BY cl.created_at DESC,cl.id`,
      )
        .bind(user.role, user.id)
        .all()
    ).results,
  );
});
app.post("/api/claims", async (c) => {
  const user = c.get("user");
  if (user.role !== "Customer") fail(403, "Customer access required.");
  const input = claimSchema.parse(await c.req.json());
  const policy = await c.env.DB.prepare(
    "SELECT start_date,end_date FROM policies WHERE id=? AND customer_id=?",
  )
    .bind(input.policyId, user.id)
    .first<{ start_date: string; end_date: string }>();
  if (!policy) fail(404, "Policy not found.");
  if (
    input.incidentDate < policy.start_date ||
    input.incidentDate > policy.end_date
  )
    fail(400, "Incident date must fall within policy coverage.");
  const id = crypto.randomUUID();
  // The INSERT and reservation check execute as one atomic statement. No read/write gap.
  await c.env.DB.prepare(
    `INSERT INTO claims(id,policy_id,incident_date,amount,request_id) SELECT ?,p.id,?,?,? FROM policies p WHERE p.id=? AND p.customer_id=? AND ? BETWEEN p.start_date AND p.end_date AND ? <= p.sum_insured-COALESCE((SELECT SUM(amount) FROM claims WHERE policy_id=p.id AND status IN ('Submitted','Approved')),0) AND NOT EXISTS(SELECT 1 FROM claims WHERE request_id=?)`,
  )
    .bind(
      id,
      input.incidentDate,
      input.amount,
      input.requestId,
      input.policyId,
      user.id,
      input.incidentDate,
      input.amount,
      input.requestId,
    )
    .run();
  const claim = await c.env.DB.prepare(
    "SELECT cl.id,cl.policy_id,cl.incident_date,cl.amount,p.customer_id FROM claims cl JOIN policies p ON p.id=cl.policy_id WHERE cl.request_id=?",
  )
    .bind(input.requestId)
    .first<{
      id: string;
      policy_id: string;
      incident_date: string;
      amount: number;
      customer_id: string;
    }>();
  if (!claim)
    fail(409, "Claim exceeds remaining sum insured. Refresh and try again.");
  if (
    claim.customer_id !== user.id ||
    claim.policy_id !== input.policyId ||
    claim.incident_date !== input.incidentDate ||
    claim.amount !== input.amount
  )
    fail(409, "This request identifier has already been used.");
  return c.json({ id: claim.id }, claim.id === id ? 201 : 200);
});
app.post("/api/claims/:id/decision", async (c) => {
  const user = c.get("user");
  if (user.role !== "Administrator")
    fail(403, "Administrator access required.");
  const { status } = decisionSchema.parse(await c.req.json());
  const result = await c.env.DB.prepare(
    "UPDATE claims SET status=?,decided_at=CURRENT_TIMESTAMP,decided_by=? WHERE id=? AND status='Submitted' RETURNING id",
  )
    .bind(status, user.id, c.req.param("id"))
    .first();
  if (!result) fail(409, "Claim is missing or has already been decided.");
  return c.json({ ok: true });
});
app.notFound((c) => c.json({ error: "Endpoint not found." }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return c.json(
      {
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      },
      400,
    );
  if (error instanceof SyntaxError)
    return c.json({ error: "Invalid JSON request." }, 400);
  console.error("Request failed", error);
  return c.json(
    { error: "Unable to complete the request. Please try again." },
    500,
  );
});
export default app;
