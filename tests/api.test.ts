import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { claimSchema, dateSchema, moneySchema } from "../shared/domain";

let mf: Miniflare;
let admin: string;
let customer1: string;
let customer2: string;
async function request(path: string, cookie = "", body?: unknown) {
  return mf.dispatchFetch(`http://localhost/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login(username: string, password: string) {
  const response = await request("/auth/login", "", { username, password });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function policy(owner = "customer1", sumInsured = "100.00") {
  const response = await request("/policies", admin, {
    customerId: owner,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    sumInsured,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
function claim(
  policyId: string,
  amount: string,
  incidentDate = "2026-06-01",
  requestId = crypto.randomUUID(),
) {
  return { policyId, amount, incidentDate, requestId };
}
async function remaining(id: string) {
  const rows = (await (await request("/policies", admin)).json()) as {
    id: string;
    remaining: number;
  }[];
  return rows.find((p) => p.id === id)!.remaining;
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["server/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const sql = await readFile("migrations/0001_initial.sql", "utf8");
  // Keep trigger bodies intact while applying the same SQL shipped for deployment.
  const statements: string[] = [];
  let current = "";
  let trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    current += line + "\n";
    if (line.startsWith("CREATE TRIGGER")) trigger = true;
    if (
      line.trimEnd().endsWith(";") &&
      (!trigger ||
        line.trim() === "END;" ||
        (line.startsWith("CREATE TRIGGER") && line.trimEnd().endsWith("END;")))
    ) {
      statements.push(current);
      current = "";
      trigger = false;
    }
  }
  for (const statement of statements) await db.prepare(statement).run();
  admin = await login("admin", "Admin@Demo26");
  customer1 = await login("customer1", "Customer1@Demo26");
  customer2 = await login("customer2", "Customer2@Demo26");
});
afterAll(async () => {
  await mf?.dispose();
});

describe("validation", () => {
  it("uses exact minor units and rejects invalid precision and signs", () => {
    expect(moneySchema.parse("0.29")).toBe(29);
    for (const value of [
      "0",
      "-1",
      "1.001",
      "1e3",
      "NaN",
      "Infinity",
      "10000000000",
    ])
      expect(moneySchema.safeParse(value).success).toBe(false);
  });
  it("validates calendar dates, leap years and strict input", () => {
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    for (const date of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01"])
      expect(dateSchema.safeParse(date).success).toBe(false);
    expect(
      claimSchema.safeParse({ ...claim("a", "1"), status: "Approved" }).success,
    ).toBe(false);
  });
});
describe("access control and sessions", () => {
  it("requires authentication and rejects bad credentials", async () => {
    expect((await request("/policies")).status).toBe(401);
    expect(
      (
        await request("/auth/login", "", {
          username: "admin",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
  });
  it("isolates customers and rejects forged ownership and admin actions", async () => {
    const id = await policy();
    const rows = (await (await request("/policies", customer2)).json()) as {
      id: string;
    }[];
    expect(rows.some((p) => p.id === id)).toBe(false);
    expect((await request("/claims", customer2, claim(id, "1"))).status).toBe(
      404,
    );
    expect((await request("/policies", customer1, {})).status).toBe(403);
    expect(
      (
        await request("/claims/unknown/decision", customer1, {
          status: "Approved",
        })
      ).status,
    ).toBe(403);
    expect((await request("/customers", customer1)).status).toBe(403);
    await request("/claims", customer1, claim(id, "1"));
    const claims = (await (await request("/claims", customer2)).json()) as {
      policyId: string;
    }[];
    expect(claims.some((c) => c.policyId === id)).toBe(false);
  });
  it("invalidates logged-out and expired sessions", async () => {
    const session = await login("customer2", "Customer2@Demo26");
    expect((await request("/auth/logout", session, {})).status).toBe(200);
    expect((await request("/auth/me", session)).status).toBe(401);
    const expiring = await login("customer2", "Customer2@Demo26");
    const token = expiring.slice("session=".length);
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
    await (
      await mf.getD1Database("DB")
    )
      .prepare("UPDATE sessions SET expires_at=0 WHERE token_hash=?")
      .bind(hash)
      .run();
    expect((await request("/auth/me", expiring)).status).toBe(401);
  });
  it("rejects cross-origin mutations and malformed JSON", async () => {
    const response = await mf.dispatchFetch("http://localhost/api/claims", {
      method: "POST",
      headers: {
        cookie: customer1,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    const invalid = await mf.dispatchFetch("http://localhost/api/claims", {
      method: "POST",
      headers: { cookie: customer1, "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
  });
});
describe("policy and claim accounting", () => {
  it("rejects invalid policies", async () => {
    for (const input of [
      {
        customerId: "admin",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        sumInsured: "1",
      },
      {
        customerId: "customer1",
        startDate: "2026-12-31",
        endDate: "2026-01-01",
        sumInsured: "1",
      },
      {
        customerId: "customer1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        sumInsured: "0",
      },
    ])
      expect((await request("/policies", admin, input)).status).toBe(400);
  });
  it("accepts inclusive dates and rejects outside coverage", async () => {
    const id = await policy();
    for (const date of ["2026-01-01", "2026-12-31"])
      expect(
        (await request("/claims", customer1, claim(id, "1", date))).status,
      ).toBe(201);
    for (const date of ["2025-12-31", "2027-01-01"])
      expect(
        (await request("/claims", customer1, claim(id, "1", date))).status,
      ).toBe(400);
  });
  it("reserves immediately, rejects excess, releases rejection, retains approval", async () => {
    const id = await policy();
    const first = (await (
      await request("/claims", customer1, claim(id, "60"))
    ).json()) as { id: string };
    expect(await remaining(id)).toBe(4000);
    expect((await request("/claims", customer1, claim(id, "50"))).status).toBe(
      409,
    );
    expect(
      (
        await request(`/claims/${first.id}/decision`, admin, {
          status: "Rejected",
        })
      ).status,
    ).toBe(200);
    expect(await remaining(id)).toBe(10000);
    const second = (await (
      await request("/claims", customer1, claim(id, "100"))
    ).json()) as { id: string };
    expect(await remaining(id)).toBe(0);
    expect(
      (
        await request(`/claims/${second.id}/decision`, admin, {
          status: "Approved",
        })
      ).status,
    ).toBe(200);
    expect(await remaining(id)).toBe(0);
    expect(
      (
        await request(`/claims/${second.id}/decision`, admin, {
          status: "Rejected",
        })
      ).status,
    ).toBe(409);
  });
  it("prevents concurrent over-reservation", async () => {
    const id = await policy();
    const responses = await Promise.all([
      request("/claims", customer1, claim(id, "60")),
      request("/claims", customer1, claim(id, "60")),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await remaining(id)).toBe(4000);
  });
  it("deduplicates concurrent retries and rejects changed request payloads", async () => {
    const id = await policy();
    const input = claim(id, "60");
    const responses = await Promise.all([
      request("/claims", customer1, input),
      request("/claims", customer1, input),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await remaining(id)).toBe(4000);
    expect(
      (await request("/claims", customer1, { ...input, amount: "61" })).status,
    ).toBe(409);
  });
  it("allows only one concurrent decision", async () => {
    const id = await policy();
    const submitted = (await (
      await request("/claims", customer1, claim(id, "60"))
    ).json()) as { id: string };
    const responses = await Promise.all(
      ["Approved", "Rejected"].map((status) =>
        request(`/claims/${submitted.id}/decision`, admin, { status }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = (await (await request("/claims", admin)).json()) as {
      id: string;
      status: string;
    }[];
    expect(await remaining(id)).toBe(
      rows.find((c) => c.id === submitted.id)!.status === "Approved"
        ? 4000
        : 10000,
    );
  });
  it("protects accounting even if an insert bypasses the API", async () => {
    const id = await policy();
    const db = await mf.getD1Database("DB");
    await expect(
      db
        .prepare(
          "INSERT INTO claims(id,policy_id,incident_date,amount,request_id) VALUES (?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), id, "2026-01-01", 10001, crypto.randomUUID())
        .run(),
    ).rejects.toThrow("INSUFFICIENT_SI");
  });
});
