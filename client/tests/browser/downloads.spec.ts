import { expect, test } from "@playwright/test";

for (const surface of ["chat", "media"]) {
  for (const relative of [false, true]) {
    test(`${surface} reports a refused download and can retry (${relative ? "relative" : "signed"} URL)`, async ({ page }) => {
      await page.goto(`/tests/fixtures/downloads.html?surface=${surface}${relative ? "&relative" : ""}`);
      const address = relative ? "https://app.example/objects/file" : "https://cdn.example/objects/file?signature=a%2Fb&part=1";
      const download = page.getByRole("button", { name: /^(save|download in browser)$/ });
      await download.click();
      await expect(page.getByRole("alert")).toContainText("Couldn't open your browser");
      await expect(page.getByRole("textbox", { name: "download link" })).toHaveValue(address);
      await expect(download).toBeEnabled();
      await page.evaluate(() => { document.documentElement.dataset.refuseOpen = "no"; });
      await download.click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".att-download").getByRole("status")).toContainText("Check your browser's downloads");
      expect(await page.evaluate(() => document.documentElement.dataset.requestedUrl)).toBe(address);
      await expect(page.getByRole("textbox", { name: "download link" })).toHaveValue(address);
      await expect(page.getByText(/^saved$/)).toHaveCount(0);
    });
  }
}
