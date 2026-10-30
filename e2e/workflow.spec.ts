import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in →" }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
test("admin creates coverage; customer claims; admin rejects; customer sees released balance", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const customer = await customerContext.newPage();
  const other = await otherContext.newPage();
  await login(admin, "admin", "Admin@Demo26");
  await admin
    .getByRole("combobox", { name: "Customer", exact: true })
    .selectOption("customer1");
  await admin.getByLabel("Coverage start").fill("2026-01-01");
  await admin.getByLabel("Coverage end").fill("2026-12-31");
  await admin.getByLabel("Sum insured (INR)").fill("12345.67");
  const created = admin.waitForResponse(
    (r) => r.url().endsWith("/api/policies") && r.request().method() === "POST",
  );
  await admin
    .getByRole("button", { name: "Create policy", exact: true })
    .click();
  const { id } = (await (await created).json()) as { id: string };
  await login(customer, "customer1", "Customer1@Demo26");
  await customer
    .getByRole("combobox", { name: "Policy", exact: true })
    .selectOption(id);
  await customer.getByLabel("Incident date").fill("2026-01-01");
  await customer.getByLabel("Claim amount (INR)").fill("100");
  const submitted = customer.waitForResponse(
    (r) => r.url().endsWith("/api/claims") && r.request().method() === "POST",
  );
  await customer
    .getByRole("button", { name: "Submit claim", exact: true })
    .click();
  const { id: claimId } = (await (await submitted).json()) as { id: string };
  await expect(customer.getByRole("status")).toContainText("Claim submitted");
  await admin.getByRole("button", { name: "Refresh", exact: false }).click();
  const row = admin.getByRole("row").filter({ hasText: claimId.slice(0, 8) });
  await row.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(row.getByText("Rejected", { exact: true })).toBeVisible();
  await customer.getByRole("button", { name: "Refresh", exact: false }).click();
  await expect(
    customer
      .getByRole("row")
      .filter({ hasText: claimId.slice(0, 8) })
      .getByText("Rejected", { exact: true }),
  ).toBeVisible();
  const policy = customer.locator(".policy").filter({ hasText: id });
  await expect(
    policy.locator(".policy-money > div").last().locator("strong"),
  ).toHaveText("₹12,345.67");
  await login(other, "customer2", "Customer2@Demo26");
  await expect(other.locator(".policy").filter({ hasText: id })).toHaveCount(0);
  await customer.getByRole("button", { name: "Sign out" }).click();
  await expect(customer.getByLabel("Username", { exact: true })).toBeVisible();
  await adminContext.close();
  await customerContext.close();
  await otherContext.close();
});
