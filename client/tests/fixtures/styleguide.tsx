import { useState } from "react";
import { createRoot } from "react-dom/client";
import Button from "../../src/lib/Button";
import IconButton from "../../src/lib/IconButton";
import { ActionIcon } from "../../src/lib/icons";
import PreferenceSwitch from "../../src/settings/PreferenceSwitch";
import { applyTheme, type ThemePref } from "../../src/lib/theme";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "./styleguide.css";

function Guide() {
  const [theme, setTheme] = useState<ThemePref>("dark");
  const [muted, setMuted] = useState(false);
  const [warmth, setWarmth] = useState(true);
  const [plain, setPlain] = useState(false);
  return (
    <main className="guide">
      <header className="guide-head">
        <div>
          <p className="panel-label">Linger / local design review</p>
          <h1>Clear controls. A little character.</h1>
          <p>
            One visual language, shared with the app. Nothing here is a new
            product feature.
          </p>
        </div>
        <label className="guide-theme">
          Preview theme
          <select
            value={theme}
            onChange={(event) => {
              const next = event.target.value === "light" ? "light" : "dark";
              setTheme(next);
              applyTheme(next);
            }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </header>
      <div className="guide-grid">
        <section>
          <h2>01 / Actions</h2>
          <p>Filled for the next step. Outlined for supporting actions.</p>
          <div className="guide-examples">
            <Button variant="primary">Join voice</Button>
            <Button>Message</Button>
            <IconButton label="Add a server">
              <ActionIcon name="plus" />
            </IconButton>
          </div>
          <div className="guide-examples">
            <Button variant="primary" disabled icon="send">
              Send message
            </Button>
            <span className="guide-note">Disabled: waiting for a message</span>
          </div>
        </section>
        <section>
          <h2>02 / Voice controls</h2>
          <p>Familiar symbols, names on focus, unmistakable state.</p>
          <div className="guide-examples">
            <IconButton
              label={muted ? "Muted" : "Mute"}
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
            >
              <ActionIcon name={muted ? "micOff" : "mic"} />
            </IconButton>
            <IconButton label="Deafen">
              <ActionIcon name="headphones" />
            </IconButton>
            <IconButton label="Leave voice">
              <ActionIcon name="leave" />
            </IconButton>
          </div>
          <div className="guide-examples">
            <IconButton label="Muted" aria-pressed>
              <ActionIcon name="micOff" />
            </IconButton>
            <IconButton label="Deafened" aria-pressed>
              <ActionIcon name="headphonesOff" />
            </IconButton>
          </div>
        </section>
        <section>
          <h2>03 / Preferences</h2>
          <p>
            Stable labels. Immediate changes. State shown without relying on
            color.
          </p>
          <PreferenceSwitch
            label="Evening warmth"
            hint="Softer colors after sunset."
            checked={warmth}
            onChange={setWarmth}
          />
          <PreferenceSwitch
            label="Use plain names"
            hint="Only your view changes."
            checked={plain}
            onChange={setPlain}
          />
        </section>
        <section>
          <h2>04 / Type & color</h2>
          <p>Readable content, quiet metadata, and one purposeful accent.</p>
          <div className="guide-type">
            <strong>A little room to linger.</strong>
            <span>Your message is the most important text here.</span>
            <span className="meta">5:42 PM · EDITED</span>
          </div>
          <div className="guide-palette">
            {["surface-0", "surface-1", "surface-2", "accent"].map((token) => (
              <span key={token}>
                <i style={{ background: `var(--${token})` }} />
                {token}
              </span>
            ))}
          </div>
        </section>
      </div>
      <footer>
        Keyboard focus is a visible ring. Hover reinforces a control—it never
        reveals one for the first time.
        <br />
        No avatars, chat bubbles, surface gradients, shadows, or notification
        counters.
      </footer>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing guide root");
createRoot(root).render(<Guide />);
