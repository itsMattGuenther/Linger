import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { Attachment } from "../../src/generated/Attachment";
import Attachments from "../../src/media/Attachments";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/stream/stream.css";
import { images } from "./images";
import { setInterfaceScale } from "../../src/lib/interface";

const params = new URLSearchParams(location.search);
const image = images.find((item) => item.name === params.get("image")) ?? images[0];
if (!image) throw new Error("missing fixture image");
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
setInterfaceScale(Number(params.get("scale") ?? "100"));

// Known image dimensions without a server, external requests or user files.
const canvas = document.createElement("canvas");
canvas.width = image.width;
canvas.height = image.height;
const context = canvas.getContext("2d");
if (!context) throw new Error("missing canvas context");
const tokens = getComputedStyle(document.documentElement);
context.fillStyle = tokens.getPropertyValue("--surface-2");
context.fillRect(0, 0, image.width, image.height);
context.strokeStyle = tokens.getPropertyValue("--accent");
context.lineWidth = 12;
context.strokeRect(6, 6, image.width - 12, image.height - 12);
context.beginPath();
context.moveTo(0, 0);
context.lineTo(image.width, image.height);
context.moveTo(image.width, 0);
context.lineTo(0, image.height);
context.stroke();

const file: Attachment = {
  id: "preview-fixture", filename: image.name, mime: "image/png", size_bytes: 100,
  url: canvas.toDataURL(), width: image.width, height: image.height,
  duration_ms: null, blurhash: null, poster_url: null, starred_at: null,
  uploader_id: "fixture", created_at: 0,
};
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");

createRoot(root).render(
  <StrictMode>
    <button type="button">outside the preview</button>
    <div style={{ margin: "40px 100px", height: "70vh", overflow: "auto" }}>
      <div className="stream-rows" style={{ height: 1200 }}>
        {/* Same containing-block trigger as Stream's virtualized rows. */}
        <div className="stream-row" style={{ transform: "translateY(160px)" }}>
          <Attachments files={[file]} baseUrl="" />
        </div>
      </div>
    </div>
  </StrictMode>,
);
