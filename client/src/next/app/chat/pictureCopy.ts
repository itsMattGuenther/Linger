/**
 * How many pixels along each edge a picture's preview is made at: the box
 * draws it `--composer-thumb` square (40px), and this is enough for that on a
 * screen at three times the pixels.
 */
export const PREVIEW_EDGE = 120;

/**
 * A small square copy of a picture, for the box to show before it's sent
 * (#397): a phone's photo is called something like `9D836261-….jpg`, so its
 * name alone doesn't say whether it's the right one. Made here from the file
 * in hand, with nothing asked of the server. The middle of the picture is
 * kept, as the box shows it.
 *
 * The picture is read whole once and let go at once. What stays is the copy,
 * a few kilobytes, so a twelve-megapixel photo doesn't sit in memory at full
 * size for as long as it waits in the box (#380).
 *
 * Null for anything this engine can't read as a picture (an iPhone's HEIC,
 * say): the box shows the file icon for those, as for any other file.
 */
export async function pictureCopy(file: Blob, edge = PREVIEW_EDGE): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  let picture: ImageBitmap | null = null;
  try {
    picture = await createImageBitmap(file);
    const side = Math.min(picture.width, picture.height);
    if (side === 0) return null;
    const out = Math.max(1, Math.min(edge, side));
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(picture, (picture.width - side) / 2, (picture.height - side) / 2, side, side, 0, 0, out, out);
    picture.close();
    picture = null;
    const copy = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    return copy ? URL.createObjectURL(copy) : null;
  } catch {
    return null;
  } finally {
    picture?.close();
  }
}
