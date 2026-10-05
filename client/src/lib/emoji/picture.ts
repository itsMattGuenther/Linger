/**
 * A picture made ready to be a server's emoji (#359), so the host never has
 * to resize anything. A still picture bigger than an emoji needs is drawn
 * at 128 pixels on its longer side and sent as a PNG; a GIF is sent as it is,
 * to keep its animation, and has to fit `MAX_EMOJI_BYTES` already. The
 * server checks again either way.
 */
import { MAX_EMOJI_BYTES } from "./names";

/** Plenty for an emoji drawn at 48 pixels on a screen twice as dense. */
const EDGE = 128;
const KINDS = ["image/png", "image/gif", "image/webp", "image/jpeg"];

/** The file to upload, or a sentence saying why this one won't do. */
export async function emojiPicture(file: File): Promise<File | string> {
  if (!KINDS.includes(file.type)) return "An emoji is a PNG, GIF, WebP or JPEG picture.";
  if (file.type === "image/gif") {
    return file.size <= MAX_EMOJI_BYTES ? file : `An animated emoji has to be under 256 KB, and this one is ${Math.ceil(file.size / 1024)} KB.`;
  }
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    return "That picture couldn't be read.";
  }
  const scale = Math.min(1, EDGE / Math.max(image.width, image.height));
  if (scale === 1 && file.size <= MAX_EMOJI_BYTES) {
    image.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "That picture couldn't be read.";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (!blob) return "That picture couldn't be read.";
  if (blob.size > MAX_EMOJI_BYTES) return "That picture is too detailed to make a small emoji.";
  return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".png", { type: "image/png" });
}
