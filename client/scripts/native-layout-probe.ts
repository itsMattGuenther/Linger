// Test-only entry. Use real components and the package's existing stylesheet.
import "../tests/fixtures/console";
import { SCALE_OPTIONS, setInterfaceScale } from "../src/lib/interface";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resultTarget = window as Window & { __lingerLayoutResult?: unknown };
resultTarget.__lingerLayoutResult = { status: "pending" };

async function run() {
  const checks: unknown[] = [];
  for (let attempt = 0; !document.querySelector(".rail-dms .room-slug"); attempt++) {
    if (attempt > 100) throw new Error("Synthetic room and DM did not load");
    await wait(50);
  }
  for (const theme of ["dark", "light"]) {
    document.documentElement.dataset.theme = theme;
    for (const scale of SCALE_OPTIONS) {
      setInterfaceScale(scale);
      await wait(60);
      const navigation = document.querySelector<HTMLButtonElement>(".navigation-access");
      if (navigation) navigation.click();
      await wait(60);
      const rail = document.querySelector<HTMLElement>(".rail-content");
      if (!rail || !rail.getBoundingClientRect().width) throw new Error(`Missing visible rail at ${scale}%`);
      // Exercise the reserved scrollbar gutter even on an overlay-scrollbar host.
      rail.style.overflowY = "scroll";
      rail.style.scrollbarGutter = "stable";
      for (const height of [240, 400]) {
        rail.style.height = `${height}px`;
        rail.style.maxHeight = `${height}px`;
        await wait(40);
        const overflow = rail.scrollWidth - rail.clientWidth;
        const gutter = rail.offsetWidth - rail.clientWidth;
        if (gutter <= 0) throw new Error("Native check requires a reserved scrollbar gutter");
        const railStyle = getComputedStyle(rail);
        if (parseFloat(railStyle.marginInlineStart) < 0 || parseFloat(railStyle.marginInlineEnd) < 0)
          throw new Error("Rail scroll box escapes its parent gutter with negative margins (#100)");
        const left = rail.getBoundingClientRect().left + rail.clientLeft;
        const right = left + rail.clientWidth;
        if (overflow > 1) throw new Error(`${theme} ${scale}% ${height}px: sideways rail overflow ${overflow}px`);
        for (const node of rail.querySelectorAll<HTMLElement>(".rail-section, .server-row, .room-item, .server-name, .room-slug, .rail-places")) {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (box.left < left - 1 || box.right > right + 1 || node.scrollWidth > node.clientWidth + 1)
            throw new Error(`${theme} ${scale}%: ${node.className} escapes the scroll box`);
          if (style.textOverflow === "ellipsis" || !["none", ""].includes(style.webkitLineClamp))
            throw new Error(`${node.className} truncates navigation text`);
        }
        checks.push({ theme, scale, height, overflow, gutter });
      }
      document.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]')?.click();
    }
  }
  setInterfaceScale(100);
  await wait(100);
  const interactions = await checkSendingAndKnock();
  resultTarget.__lingerLayoutResult = { status: "passed", checks, interactions };
}
void run().catch((error: unknown) => {
  resultTarget.__lingerLayoutResult = { status: "failed", error: String(error) };
});

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await wait(20);
  }
  throw new Error(label);
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing ${label} control`);
  return found;
}

async function checkSendingAndKnock() {
  // The packaged renderer executes real React controls against isolated,
  // synthetic responses. No account, microphone or real server is involved.
  const person = [...document.querySelectorAll(".roster .person-name")]
    .find((node) => node.textContent === "Jules");
  if (!person?.closest("button")) throw new Error("Missing Jules profile control");
  person.closest("button")!.click();
  await until(() => document.querySelector(`[aria-label="Jules's profile"]`) !== null, "Profile did not open");
  button("Knock").click();
  await until(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Knocked"), "First knock did not settle");
  await until(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Knock"), "Knock feedback did not reset");
  document.documentElement.dataset.holdKnock = "yes";
  button("Knock").click();
  await until(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Knocking…"), "Second knock was not pending");
  if (!button("Knocking…").disabled) throw new Error("Pending knock allowed a duplicate");
  document.dispatchEvent(new Event("finish-knock"));
  await until(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Knocked"), "Second knock did not settle");
  button("Close Jules's profile").click();
  delete document.documentElement.dataset.holdKnock;

  for (const conversation of ["room", "dm"]) {
    if (conversation === "dm") {
      document.querySelector<HTMLButtonElement>(".rail-dms .room-item")!.click();
      await wait(50);
    }
    const box = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    const type = (text: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    };
    document.documentElement.dataset.holdSend = "yes";
    delete document.documentElement.dataset.lastSent;
    box.focus();
    type(`First ${conversation} message`);
    await wait(0);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => !!document.documentElement.dataset.lastSent, "Enter did not submit");
    if (box.value !== "" || document.activeElement !== box) throw new Error("Composer did not clear and retain focus immediately");
    type(`Next ${conversation} draft`);
    await wait(0);
    document.dispatchEvent(new Event("finish-send"));
    await until(() => ![...document.querySelectorAll('[role="status"]')].some((node) => node.textContent === "Sending…"), "Send did not finish");
    if (box.value !== `Next ${conversation} draft`) throw new Error("Send discarded the newer draft");
    if (!document.documentElement.getAttribute("data-last-sent")?.includes(`First ${conversation} message`)) throw new Error("Send changed the committed text");
    delete document.documentElement.dataset.holdSend;
  }
  return { secondKnock: "passed", roomComposer: "passed", dmComposer: "passed" };
}
