import { expect, test } from "@playwright/test";

// The console fixture's `?replies`: message 2 answers message 0, message 3 is
// the same person answering message 0 again (a reply that continues a group,
// the case in #181), and message 4 answers message 2.
for (const theme of ["dark", "light"]) {
  for (const scale of [100, 200]) {
    test(`a quote sits with its own reply, not the message above, ${theme} ${scale}% (#181)`, async ({ page }) => {
      await page.setViewportSize({ width: 11 * scale, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("linger.interface.scale", String(value)), scale);
      await page.goto("/tests/fixtures/console.html?replies");
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.evaluate(() => document.fonts.ready);
      const continued = page.locator('.msg[data-reply="continued"]');
      await expect(continued).toHaveCount(1);
      await expect(page.locator(".msg-reply")).toHaveCount(3);

      const measured = await page.locator(".msg-reply").evaluateAll((quotes) =>
        quotes.map((quote) => {
          const message = quote.closest(".msg")!;
          const row = message.closest(".stream-row")!;
          const text = document.createRange();
          text.selectNodeContents(quote.querySelector(".reply-excerpt")!);
          const line = text.getBoundingClientRect();
          const body = message.querySelector(".msg-body")!.getBoundingClientRect();
          // The row drawn just above this one, by position rather than DOM
          // order: the virtualizer places rows with transforms.
          const above = [...document.querySelectorAll(".stream-row")]
            .filter((other) => other !== row && other.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 1)
            .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
          const bodies = above ? [...above.querySelectorAll(".msg-body")] : [];
          const previous = bodies.at(-1)?.getBoundingClientRect();
          const bracket = getComputedStyle(quote, "::before");
          return {
            continued: message.getAttribute("data-reply") === "continued",
            quoteHeight: quote.getBoundingClientRect().height,
            below: body.top - line.bottom,
            above: previous ? line.top - previous.bottom : null,
            bracket: bracket.borderLeftStyle === "solid" && bracket.borderTopStyle === "solid",
            rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          };
        }),
      );

      for (const quote of measured) {
        // No 2rem button floor under the text any more: a 24px line.
        expect(quote.quoteHeight).toBeLessThanOrEqual(quote.rem * 1.5 + 1);
        // The quote hugs its own reply...
        expect(quote.below).toBeLessThanOrEqual(quote.rem * 0.5);
        // ...and the hairline bracket ties the two together.
        expect(quote.bracket).toBe(true);
      }
      // A reply continuing a group sits further from the message above than
      // from its own text, so the quote reads as this message's, not that one's.
      const continuing = measured.find((quote) => quote.continued)!;
      expect(continuing.above).not.toBeNull();
      expect(continuing.above!).toBeGreaterThan(continuing.below * 2);

      // Still a control: focusable, and it jumps to what it quotes.
      const quote = continued.locator(".msg-reply");
      await quote.focus();
      await expect(quote).toBeFocused();
      await quote.press("Enter");
      await expect(page.locator('.msg[data-flash="true"]')).toHaveCount(1);
    });
  }
}
