import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Attachment } from "../generated/Attachment";
import Attachments from "./Attachments";

const FILE: Attachment = {
  id: "file", filename: "porch.png", mime: "image/png", size_bytes: 100,
  url: "/objects/porch", width: 128, height: 128, duration_ms: null,
  blurhash: null, poster_url: null, starred_at: null, uploader_id: "alice",
  created_at: 0,
};

describe("server media addresses", () => {
  it.each(["http://127.0.0.1:8420", "http://second.local:8420"])(
    "loads an inline image from its own server %s",
    (baseUrl) => {
      const html = renderToStaticMarkup(<Attachments baseUrl={baseUrl} files={[FILE]} />);
      expect(html).toContain(`src="${baseUrl}/objects/porch"`);
    },
  );

  it("resolves both a video and its poster", () => {
    const html = renderToStaticMarkup(
      <Attachments baseUrl="http://box.local" files={[
        { ...FILE, mime: "video/mp4", poster_url: "/objects/poster" },
      ]} />,
    );
    expect(html).toContain('src="http://box.local/objects/porch"');
    expect(html).toContain('poster="http://box.local/objects/poster"');
  });

  it("preserves the separate media origin and its signed query", () => {
    const url = "https://cdn.example/objects/porch?signature=test";
    const html = renderToStaticMarkup(
      <Attachments baseUrl="https://linger.example" files={[{ ...FILE, url }]} />,
    );
    expect(html).toContain(`src="${url}"`);
  });
});
