/** Local illustrations, not user photos or network requests. */
import type { Attachment } from "../../src/generated/Attachment";
import type { MediaItem } from "../../src/generated/MediaItem";

const art = [
  // Keep real HTTP URLs: Vite otherwise inlines these tiny files as data URLs,
  // which are deliberately not accepted by the production server-URL resolver.
  [
    "River at golden hour.svg",
    new URL("./memory-river.svg", location.href).href,
  ],
  ["The long way home.svg", new URL("./memory-walk.svg", location.href).href],
  ["One more evening.svg", new URL("./memory-evening.svg", location.href).href],
];

export const sharedFiles: Attachment[] = art.map(([filename, url], index) => ({
  id: `memory-${index}`,
  filename: filename ?? "memory.svg",
  url: url ?? "",
  mime: "image/svg+xml",
  size_bytes: 184_000 + index * 10_000,
  width: index === 1 ? 480 : 720,
  height: index === 1 ? 720 : 480,
  duration_ms: null,
  blurhash: null,
  poster_url: null,
  starred_at: null,
  uploader_id: index === 1 ? "eli" : "jules",
  created_at: Date.now() - (index + 1) * 86_400_000,
}));

export const sharedMedia: MediaItem[] = sharedFiles.map((file) => ({
  kind: "image",
  cursor: file.id,
  author_id: file.uploader_id,
  created_at: file.created_at,
  message_id: "message-00004",
  room_id: "general",
  attachment: file,
  link: null,
  excerpt: "A little something from the weekend.",
  starred_at: null,
}));
