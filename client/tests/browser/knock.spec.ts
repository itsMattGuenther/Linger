import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-17T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-17T12:00:01Z"));
  await page.goto("/tests/fixtures/knock.html");
});

test("sender feedback disappears and the server still controls the rate limit", async ({
  page,
}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Knock", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Knocked", exact: true }),
    ).toBeDisabled();
    await page.clock.runFor(2999);
    await expect(
      page.getByRole("button", { name: "Knocked", exact: true }),
    ).toBeVisible();
    await page.clock.runFor(1);
    await expect(
      page.getByRole("button", { name: "Knock", exact: true }),
    ).toBeEnabled();
  }
  await page.evaluate(() => {
    document.documentElement.dataset.mode = "limited";
  });
  await page.getByRole("button", { name: "Knock", exact: true }).click();
  await expect(
    page.getByText("That's three this hour. Give them a bit."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Knock", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.dataset.calls),
  ).toBe("4");
});

test("pending knocks stay disabled and failures can be retried", async ({
  page,
}) => {
  await page.evaluate(() => {
    document.documentElement.dataset.mode = "pending";
  });
  await page.getByRole("button", { name: "Knock", exact: true }).click();
  await page.clock.runFor(10_000);
  await expect(page.getByRole("button", { name: "Knocking…" })).toBeDisabled();
  await page.getByRole("button", { name: "finish request" }).click();
  await expect(
    page.getByRole("button", { name: "Knocked", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(3000);
  await page.evaluate(() => {
    document.documentElement.dataset.mode = "failure";
  });
  await page.getByRole("button", { name: "Knock", exact: true }).click();
  await expect(page.getByText("Couldn't knock.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Knock", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    delete document.documentElement.dataset.mode;
  });
  await page.getByRole("button", { name: "Knock", exact: true }).click();
  await expect(page.getByText("Couldn't knock.")).toHaveCount(0);
});

for (const change of ["toggle card", "switch person", "switch server"]) {
  test(`${change} cannot inherit a late knock response`, async ({ page }) => {
    await page.evaluate(() => {
      document.documentElement.dataset.mode = "pending";
    });
    await page.getByRole("button", { name: "Knock", exact: true }).click();
    await page.getByRole("button", { name: change }).click();
    if (change === "toggle card")
      await page.getByRole("button", { name: change }).click();
    await page.getByRole("button", { name: "finish request" }).click();
    await page.clock.runFor(5000);
    await expect(
      page.getByRole("button", { name: "Knock", exact: true }),
    ).toBeEnabled();
  });
  test(`${change} clears old success feedback without resetting the next timer`, async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Knock", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Knocked", exact: true }),
    ).toBeVisible();
    await page.clock.runFor(2000);
    await page.getByRole("button", { name: change }).click();
    if (change === "toggle card")
      await page.getByRole("button", { name: change }).click();
    await page.getByRole("button", { name: "Knock", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Knocked", exact: true }),
    ).toBeVisible();
    await page.clock.runFor(1000);
    await expect(
      page.getByRole("button", { name: "Knocked", exact: true }),
    ).toBeVisible();
    await page.clock.runFor(2000);
    await expect(
      page.getByRole("button", { name: "Knock", exact: true }),
    ).toBeEnabled();
  });
}
