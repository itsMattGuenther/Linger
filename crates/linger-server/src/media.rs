//! Turning arriving bytes into something safe to store (ARCHITECTURE §8 step 5).
//!
//! Three jobs, in order:
//!
//! 1. **Find out what the file actually is.** The type the client declared is a
//!    claim, not a fact. Magic bytes decide, and a file whose contents disagree
//!    with its label is refused.
//! 2. **Re-encode every image.** Decoding and re-encoding drops EXIF — which
//!    carries the GPS coordinates of the room the photo was taken in (SPEC
//!    §4.10) — and destroys polyglots, files that are a valid image and a valid
//!    something-else at the same time, in the same step. There is no toggle.
//! 3. **Describe it.** Dimensions, a blurhash to show while the real thing
//!    loads, a poster frame and duration for video, and a display copy of a
//!    large image to draw where it is shown small (#382). No transcoding in V1.
//!
//! Video work shells out to `ffmpeg`/`ffprobe`. They are optional: a server
//! without them stores videos perfectly well and simply has no poster frame.
//! Every run is on a clock and killed when the clock runs out, because the
//! file they are reading is untrusted and a crafted one can keep either tool
//! busy forever.

use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use linger_core::media;

use crate::error::ApiError;

/// The biggest image this server will decode. Well past any camera, and short
/// of the memory a deliberately enormous one would ask for.
pub(crate) const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Decoded-pixel guards against a small file that claims enormous dimensions.
const MAX_IMAGE_DIMENSION: u32 = 16_384;
/// What one image may cost in memory while it is worked on, whatever its
/// type (#487): the file itself, the decoded picture, the decoder's own
/// working memory, and every full-size copy made from it, together. For a GIF
/// it is also the ceiling on its frames counted as whole pictures, though only
/// one is held at a time: that bounds the time it costs too. A file a few
/// hundred bytes long can claim a canvas of gigabytes, and a failed allocation
/// stops the whole server, so this is checked before the memory is asked for,
/// never after.
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
/// How many images are worked on at once: uploads, video posters and the
/// display-copy catch-up together. Each can cost up to [`MAX_DECODE_ALLOC`],
/// so this many times that is the most pictures can cost the server: about
/// 1 GB, inside the 2 GB of the droplet `docs/vps-setup.md` starts from. Two
/// rather than one so that one slow picture doesn't hold up every one behind.
const IMAGE_JOBS: usize = 2;
static IMAGE_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(IMAGE_JOBS);
/// How long an upload waits for one of those places before it is told the
/// server is busy. The app gives a request 30 seconds, and the picture still
/// has to be worked on once its turn comes.
const IMAGE_WAIT: Duration = Duration::from_secs(10);
/// When to try again after being told the server is busy with pictures.
const IMAGE_BUSY_RETRY_MS: u64 = 5_000;
/// How hard the GIF encoder works at a frame of more than 256 colours, from 1
/// (slowest) to 30. At 1 a 2048 × 2048 frame took 3.5 s to choose its colours;
/// at 10 it takes 0.24 s and looks the same in a conversation (#487).
const GIF_SPEED: i32 = 10;
/// Blurhash is meant to be a smear of colour, so it is computed from a thumbnail.
const BLURHASH_MAX_EDGE: u32 = 64;
/// The longest side of an image's display copy (#382, PROTOCOL §6). A photo in
/// a conversation is drawn at most 320 px wide, so 960 is sharp up to three
/// times that: a 2× screen at 150% interface size. Ten phone photos then cost
/// a WebKit page about 65 MB rather than 900 (measured on #382). Past that it
/// softens a little in the conversation, and the viewer opens the original.
pub const DISPLAY_EDGE: u32 = 960;
/// A display copy is looked at small and briefly, then the original opens.
const DISPLAY_QUALITY: u8 = 85;
/// Where in a video to grab the poster frame. One second in, because frame zero
/// of a lot of video is black.
const POSTER_SECONDS: &str = "1";
/// How long `ffprobe` gets to describe a file. Reading a container's header
/// takes well under a second even for a 500 MB upload; this is room for a slow
/// disk, not for a slow file.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the poster frame gets, across both seek positions together — a
/// file that is merely slow must not cost twice for being tried twice.
const POSTER_TIMEOUT: Duration = Duration::from_secs(30);
/// How much of a file ffmpeg reads before deciding what is in it. These are
/// ffmpeg's own defaults, spelled out so a later ffmpeg changing them does not
/// change what an upload can cost.
const PROBE_ARGS: [&str; 4] = ["-probesize", "5000000", "-analyzeduration", "5000000"];

/// What processing worked out about a file.
pub struct Processed {
    /// The real type, which may differ from what the client declared.
    pub mime: String,
    /// The filename, with its extension corrected if re-encoding changed format.
    pub filename: String,
    /// Size after re-encoding — what counts against the pool.
    pub size_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub blurhash: Option<String>,
    /// JPEG bytes of a generated video poster frame, if there is one.
    pub poster: Option<Vec<u8>>,
    /// An image's display copy, in its own format, when it is over
    /// [`DISPLAY_EDGE`] and not a GIF. `None` for an image that is drawn as it
    /// is, and for anything that isn't an image.
    pub display: Option<Vec<u8>>,
}

/// Inspect and clean up the staged file **in place**, so the caller can move it
/// straight to its permanent key afterwards.
pub async fn process(
    path: &Path,
    declared_mime: &str,
    filename: &str,
) -> Result<Processed, ApiError> {
    let mime = resolve_mime(path, declared_mime).await?;
    let filename = corrected_filename(filename, declared_mime, &mime);
    let mut out = Processed {
        mime: mime.clone(),
        filename,
        size_bytes: tokio::fs::metadata(path).await.map_err(io)?.len(),
        width: None,
        height: None,
        duration_ms: None,
        blurhash: None,
        poster: None,
        display: None,
    };

    match media::kind_of(&mime) {
        "image" => {
            if out.size_bytes > MAX_IMAGE_BYTES {
                return Err(ApiError::validation(
                    "That image is too big for this server to re-encode. \
                     Send it as a file, or shrink it first.",
                ));
            }
            // The place in the queue comes first and the file is read inside
            // it, so an upload waiting its turn holds none of its bytes.
            let lane = ImageLane::wait_at_most(IMAGE_WAIT).await?;
            let owned_mime = mime.clone();
            let staged = path.to_path_buf();
            let clean = lane
                .run(move || reencode_in_place(&staged, &owned_mime))
                .await??;
            out.size_bytes = tokio::fs::metadata(path).await.map_err(io)?.len();
            out.mime = clean.mime.clone();
            out.filename = corrected_filename(&out.filename, &mime, &clean.mime);
            out.width = Some(clean.width);
            out.height = Some(clean.height);
            out.blurhash = clean.blurhash;
            out.display = clean.display;
        }
        "video" => {
            let probe = ffprobe(path).await;
            out.duration_ms = probe.as_ref().and_then(|p| p.duration_ms);
            out.width = probe.as_ref().and_then(|p| p.width);
            out.height = probe.as_ref().and_then(|p| p.height);
            if let Some(poster) = poster_frame(path).await {
                // A poster is a picture of the video's own size, and the video
                // is as hostile as any upload: it waits its turn like an image.
                // A video whose turn doesn't come in time is stored without
                // a blurhash, as one is on a server without ffmpeg.
                let described = match ImageLane::wait_at_most(IMAGE_WAIT).await {
                    Ok(lane) => {
                        let frame = poster.clone();
                        lane.run(move || {
                            decode_limited(&frame, |_, _, _| 0).ok().map(|decoded| {
                                (decoded.width(), decoded.height(), blurhash_of(&decoded))
                            })
                        })
                        .await
                        .ok()
                        .flatten()
                    }
                    Err(_) => None,
                };
                if let Some((width, height, blurhash)) = described {
                    out.width = out.width.or(Some(width));
                    out.height = out.height.or(Some(height));
                    out.blurhash = blurhash;
                }
                out.poster = Some(poster);
            }
        }
        "audio" => {
            out.duration_ms = ffprobe(path).await.and_then(|p| p.duration_ms);
        }
        _ => {}
    }
    Ok(out)
}

fn io(err: std::io::Error) -> ApiError {
    tracing::error!(error = %err, "upload processing io");
    ApiError::internal()
}

/// A place in the image queue: one of [`IMAGE_JOBS`] across the server
/// (#487). Every picture is read into memory and decoded inside one.
pub(crate) struct ImageLane {
    /// Held only to be let go of: the place frees when this does.
    _place: tokio::sync::SemaphorePermit<'static>,
}

impl ImageLane {
    /// Wait for a place for as long as it takes. For work nobody is waiting
    /// on, like the display-copy catch-up.
    pub(crate) async fn wait() -> Result<Self, ApiError> {
        IMAGE_WORK
            .acquire()
            .await
            .map(|place| Self { _place: place })
            .map_err(|_| ApiError::internal())
    }

    /// Wait for a place, but not past `limit`: then the answer is that the
    /// server is busy with pictures, while the person who sent this one is
    /// still waiting to hear, rather than a request that runs out of time.
    pub(crate) async fn wait_at_most(limit: Duration) -> Result<Self, ApiError> {
        tokio::time::timeout(limit, Self::wait())
            .await
            .unwrap_or_else(|_| Err(busy()))
    }

    /// Do the work off the async threads, holding this place until it ends.
    ///
    /// The place goes into the work and is given up when the work is done,
    /// not when the caller stops waiting: an upload whose request is dropped
    /// still holds its memory until its decode is over, and the next one must
    /// not start beside it as if it had finished.
    pub(crate) async fn run<T: Send + 'static>(
        self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ApiError> {
        tokio::task::spawn_blocking(move || {
            let _place = self;
            work()
        })
        .await
        .map_err(|_| ApiError::internal())
    }
}

/// Too many pictures ahead of this one. It says nothing about the picture,
/// so the upload it belongs to can be completed again (PROTOCOL §6).
fn busy() -> ApiError {
    let mut refusal = ApiError::rate_limited(IMAGE_BUSY_RETRY_MS);
    refusal.message =
        "The server is busy with other pictures. Send this one again in a moment.".to_string();
    refusal
}

// ---------------------------------------------------------------------------
// What is this file, really
// ---------------------------------------------------------------------------

/// Decide the stored type from the declared one and the actual bytes.
///
/// Formats with magic bytes have to match the category they were declared as —
/// that is what catches a file renamed to `.png` to get past the allowlist.
/// Formats with no magic bytes at all (a text file, a project file) can only be
/// taken at their word, so they are allowed through as generic files and served
/// as downloads, where being wrong about them costs nothing.
async fn resolve_mime(path: &Path, declared: &str) -> Result<String, ApiError> {
    let head = read_head(path).await?;
    let declared_kind = media::kind_of(declared);
    let sniffed = infer::get(&head)
        .map(|t| media::canonical_mime(t.mime_type()).to_string())
        .map(|sniffed| sound_only(sniffed, declared));

    match sniffed {
        Some(sniffed) => {
            if !media::is_allowed_mime(&sniffed) {
                return Err(ApiError::unsupported_media(
                    "That isn't a kind of file this server takes.",
                ));
            }
            if media::kind_of(&sniffed) != declared_kind {
                return Err(ApiError::unsupported_media(
                    "That file isn't what it says it is.",
                ));
            }
            Ok(sniffed)
        }
        None if declared_kind == "file" => Ok(media::canonical_mime(declared).to_string()),
        None => Err(ApiError::unsupported_media(
            "That file isn't what it says it is.",
        )),
    }
}

/// A WebM file is a WebM file to the sniffer, sound or picture, and it calls
/// every one `video/webm`. One declared as `audio/webm` is a voice message
/// (#401), so it's taken as sound, as it says: it's served as `audio/webm`
/// and filed under audio. Were it a video, it would only play as sound.
fn sound_only(sniffed: String, declared: &str) -> String {
    if sniffed == "video/webm" && media::canonical_mime(declared) == "audio/webm" {
        "audio/webm".to_string()
    } else {
        sniffed
    }
}

async fn read_head(path: &Path) -> Result<Vec<u8>, ApiError> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.map_err(io)?;
    let mut head = vec![0u8; 4096];
    let read = file.read(&mut head).await.map_err(io)?;
    head.truncate(read);
    Ok(head)
}

/// Keep the extension honest when re-encoding changed the format.
fn corrected_filename(filename: &str, was: &str, now: &str) -> String {
    if media::canonical_mime(was) == media::canonical_mime(now) {
        return filename.to_string();
    }
    let Some(ext) = media::extension_for(now) else {
        return filename.to_string();
    };
    let stem = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
    format!("{stem}.{ext}")
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/// What re-encoding made of an image. The picture itself has gone to the
/// writer it was given.
struct CleanImage {
    mime: String,
    width: u32,
    height: u32,
    blurhash: Option<String>,
    display: Option<Vec<u8>>,
}

fn unreadable() -> ApiError {
    ApiError::unsupported_media("That image can't be read.")
}

/// Decoder limits: the size caps, and `budget` bytes to allocate.
fn limits(budget: u64) -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(budget);
    limits
}

/// Re-encode the upload at `path`, writing the clean picture beside it and
/// putting it in the upload's place only once it is whole (#487).
///
/// Writing straight over the upload would leave half a picture behind one
/// that fails part-way, and an encode still running for a request nobody is
/// waiting on any more would write into the file a retry assembles under the
/// same name. A rename is all or nothing.
fn reencode_in_place(path: &Path, mime: &str) -> Result<CleanImage, ApiError> {
    let bytes = std::fs::read(path).map_err(io)?;
    let beside = path.parent().ok_or_else(ApiError::internal)?;
    let mut clean_file = tempfile::NamedTempFile::new_in(beside).map_err(io)?;
    let clean = {
        let mut out = std::io::BufWriter::new(clean_file.as_file_mut());
        let clean = reencode_image(&bytes, mime, &mut out)?;
        out.flush().map_err(io)?;
        clean
    };
    drop(bytes);
    // Stored as the upload was, not as the private scratch file it began as.
    let permissions = std::fs::metadata(path).map_err(io)?.permissions();
    clean_file
        .as_file()
        .set_permissions(permissions)
        .map_err(io)?;
    clean_file.persist(path).map_err(|err| io(err.error))?;
    Ok(clean)
}

/// Decode a still picture inside [`MAX_DECODE_ALLOC`] (#487). See
/// [`decode_within`].
fn decode_limited(
    bytes: &[u8],
    copies: impl FnOnce(u32, u32, image::ColorType) -> u64,
) -> Result<image::DynamicImage, ApiError> {
    decode_within(bytes, MAX_DECODE_ALLOC, copies)
}

/// Decode a still picture inside `budget`, counting with it the file, what
/// its decoder holds that `image` doesn't count, and the full-size copies the
/// caller will make from it.
///
/// `copies` is told the picture's size and the type it decodes as, read from
/// its header alone, and answers how many bytes of copies will follow. Only
/// what is left goes to the decoder, which counts the picture itself and what
/// it allocates through `image`'s limits against that. A picture that would
/// fit, but not with all the rest, is refused before any of it is decoded.
fn decode_within(
    bytes: &[u8],
    budget: u64,
    copies: impl FnOnce(u32, u32, image::ColorType) -> u64,
) -> Result<image::DynamicImage, ApiError> {
    use image::ImageDecoder;

    let reader = || {
        image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| unreadable())
    };
    let first = reader()?;
    let format = first.format();
    let header = first.into_decoder().map_err(|_| unreadable())?;
    let (width, height) = header.dimensions();
    let held = bytes.len() as u64
        + decoder_scratch(format, bytes, width, height)?
        + copies(width, height, header.color_type());
    drop(header);
    let left = budget.checked_sub(held).ok_or_else(unreadable)?;

    let mut reader = reader()?;
    reader.limits(limits(left));
    reader.decode().map_err(|_| unreadable())
}

/// What a decoder holds besides the picture it makes, where `image` gives it
/// no limit to count against (#487, measured on 8000 × 8000 pictures).
///
/// A JPEG decoder keeps a copy of the file. A progressive JPEG keeps every
/// coefficient until its last pass, two bytes a pixel for each channel: 6.2
/// bytes a pixel in all for a colour one, where a baseline JPEG, what cameras
/// and phones write, holds a few rows at a time. The WebP decoder works
/// through a buffer of its own, up to 6.6 bytes a pixel for a lossy picture
/// with transparency. The PNG decoder is given the limit itself.
fn decoder_scratch(
    format: Option<image::ImageFormat>,
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<u64, ApiError> {
    let pixels = u64::from(width) * u64::from(height);
    let file = bytes.len() as u64;
    Ok(match format {
        Some(image::ImageFormat::Jpeg) => {
            // The header as the decoder that will do the work reads it.
            let mut jpeg =
                zune_jpeg::JpegDecoder::new(zune_jpeg::zune_core::bytestream::ZCursor::new(bytes));
            jpeg.decode_headers().map_err(|_| unreadable())?;
            let info = jpeg.info().ok_or_else(unreadable)?;
            let coefficients = if info.sof.is_progressive() {
                pixels * (2 * u64::from(info.components) + 1)
            } else {
                0
            };
            file + coefficients
        }
        Some(image::ImageFormat::WebP) => file + pixels * 7,
        _ => 0,
    })
}

/// The bytes of a full-size copy of a `width` × `height` picture converted
/// from `from` to `to`: none when it already is `to`, because then it is
/// handed over rather than copied.
fn conversion_bytes(width: u32, height: u32, from: image::ColorType, to: image::ColorType) -> u64 {
    if from == to {
        return 0;
    }
    u64::from(width) * u64::from(height) * u64::from(to.bytes_per_pixel())
}

/// The working memory [`display_copy`] needs for a `width` × `height` picture.
/// Resizing samples the picture down its height first, into a picture as wide
/// as the original and as tall as the copy, of four 32-bit floats a pixel.
/// For a square picture 16 000 pixels a side that is 250 MB, so it is counted.
fn display_scratch(width: u32, height: u32) -> u64 {
    let longest = width.max(height);
    if longest <= DISPLAY_EDGE {
        return 0;
    }
    let copy_height = (u64::from(height) * u64::from(DISPLAY_EDGE)).div_ceil(u64::from(longest));
    u64::from(width) * copy_height * 16
}

/// Re-encode an image so nothing of the original file survives except pixels,
/// writing the clean picture to `out` as it is encoded.
///
/// GIFs go through frame by frame so an animation stays animated. WebP has no
/// encoder in the `image` crate, so a WebP comes back as a PNG — same picture,
/// honest extension, and still no metadata.
fn reencode_image(bytes: &[u8], mime: &str, out: &mut impl Write) -> Result<CleanImage, ApiError> {
    use image::{ColorType, ImageEncoder};

    if mime == "image/gif" {
        return reencode_gif(bytes, out);
    }

    // A JPEG stays a JPEG. Anything else becomes a PNG, WebP included:
    // lossless, and the one format the crate can both read and write for
    // these inputs.
    let (mime, kept) = if mime == "image/jpeg" {
        ("image/jpeg", ColorType::Rgb8)
    } else {
        ("image/png", ColorType::Rgba8)
    };
    let decoded = decode_limited(bytes, |width, height, color| {
        conversion_bytes(width, height, color, kept) + display_scratch(width, height)
    })?;
    // At most one full-size copy, counted above. The decoded picture goes as
    // the copy is made, and a picture already of the kept type is the copy.
    let picture = if kept == ColorType::Rgb8 {
        image::DynamicImage::ImageRgb8(decoded.into_rgb8())
    } else {
        image::DynamicImage::ImageRgba8(decoded.into_rgba8())
    };
    let (width, height) = (picture.width(), picture.height());
    let blurhash = blurhash_of(&picture);

    if mime == "image/jpeg" {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut *out, 88)
            .write_image(picture.as_bytes(), width, height, picture.color().into())
            .map_err(|_| ApiError::internal())?;
    } else {
        write_png(picture.as_bytes(), width, height, out)?;
    }

    let display = display_copy(&picture, mime)?;
    Ok(CleanImage {
        mime: mime.to_string(),
        width,
        height,
        blurhash,
        display,
    })
}

/// Write RGBA pixels as a PNG, a few rows at a time. `image`'s own PNG writer
/// compresses the whole picture in memory before it writes any of it: 269 MB
/// more for a noisy 8000 × 8000 picture, measured (#487).
fn write_png(rgba: &[u8], width: u32, height: u32, out: &mut impl Write) -> Result<(), ApiError> {
    let mut encoder = png::Encoder::new(out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    // What `image` sets.
    encoder.set_compression(png::Compression::Balanced);
    encoder.set_filter(png::Filter::Adaptive);
    let mut writer = encoder.write_header().map_err(|_| ApiError::internal())?;
    let mut rows = writer.stream_writer().map_err(|_| ApiError::internal())?;
    rows.write_all(rgba).map_err(|_| ApiError::internal())?;
    rows.finish().map_err(|_| ApiError::internal())?;
    writer.finish().map_err(|_| ApiError::internal())
}

/// Re-encode a GIF one frame at a time.
///
/// The decoder hands back every frame as a whole canvas, however small the
/// frame was in the file, so a GIF's cost is its canvas times its frames.
/// Three checks keep that inside [`MAX_DECODE_ALLOC`] (#487): the canvas is
/// held to [`MAX_IMAGE_DIMENSION`], and the decoder to the budget less the
/// file and the encoder's buffers; the frames are counted, without being
/// decoded, by [`gif_frames`]; and each frame is encoded as soon as it is
/// decoded, so only one is held at a time.
fn reencode_gif(bytes: &[u8], out: &mut impl Write) -> Result<CleanImage, ApiError> {
    use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
    use image::{AnimationDecoder, ImageDecoder};

    let mut decoder = GifDecoder::new(std::io::Cursor::new(bytes)).map_err(|_| unreadable())?;
    let (width, height) = decoder.dimensions();
    let canvas = u64::from(width) * u64::from(height);
    // Beside the decoder: the file, and the encoder's two buffers for a
    // frame, a byte a pixel for its colours and up to one and a half for
    // them compressed.
    let held = bytes.len() as u64 + canvas * 3;
    let left = MAX_DECODE_ALLOC.checked_sub(held).ok_or_else(unreadable)?;
    decoder.set_limits(limits(left)).map_err(|_| unreadable())?;
    let frames = gif_frames(bytes, canvas)?;

    let mut blurhash = None;
    let mut encoded = 0;
    let mut encoder = GifEncoder::new_with_speed(&mut *out, GIF_SPEED);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|_| ApiError::internal())?;
    for frame in decoder.into_frames().take(frames) {
        let mut frame = frame.map_err(|_| unreadable())?;
        if encoded == 0 {
            // The first frame stands for the animation while it loads. It is
            // lent to the blurhash and taken back, not copied.
            let delay = frame.delay();
            let first = image::DynamicImage::ImageRgba8(frame.into_buffer());
            blurhash = blurhash_of(&first);
            frame = image::Frame::from_parts(first.into_rgba8(), 0, 0, delay);
        }
        encoder
            .encode_frame(frame)
            .map_err(|_| ApiError::internal())?;
        encoded += 1;
    }
    if encoded == 0 {
        return Err(ApiError::unsupported_media("That image has no frames."));
    }
    // Letting go of the encoder writes the GIF's closing byte.
    drop(encoder);

    Ok(CleanImage {
        mime: "image/gif".to_string(),
        width,
        height,
        blurhash,
        // A still copy would stop the animation: a GIF is drawn as it is.
        display: None,
    })
}

/// How many frames a GIF has, counted without decoding any of them, or a
/// refusal as soon as they come to more than [`MAX_DECODE_ALLOC`] as whole
/// RGBA pictures.
///
/// Each frame counts as the bigger of the canvas, which the decoder hands
/// back for every frame, and the frame itself, which it decodes whole even
/// where the canvas cuts it off. A frame of one pixel takes a dozen bytes of
/// file, so a small file can hold a great many.
fn gif_frames(bytes: &[u8], canvas: u64) -> Result<usize, ApiError> {
    let most = MAX_DECODE_ALLOC / 4;
    let mut options = gif::DecodeOptions::new();
    options.skip_frame_decoding(true);
    let mut reader = options.read_info(bytes).map_err(|_| unreadable())?;
    let (mut frames, mut pixels) = (0, 0u64);
    while let Some(frame) = reader.read_next_frame().map_err(|_| unreadable())? {
        let own = u64::from(frame.width) * u64::from(frame.height);
        pixels += canvas.max(own).max(1);
        frames += 1;
        if pixels > most {
            return Err(unreadable());
        }
    }
    Ok(frames)
}

/// An image's display copy (#382): the picture fitted inside [`DISPLAY_EDGE`]
/// on its longest side, JPEG for a JPEG and PNG for anything else, or `None`
/// when it is small enough to draw as it is.
///
/// Drawn small, a full-size picture still costs its full size: an engine that
/// decodes it whole holds about 50 MB for a phone photo in a 320-pixel box.
/// The working memory it takes here is [`display_scratch`].
fn display_copy(image: &image::DynamicImage, mime: &str) -> Result<Option<Vec<u8>>, ApiError> {
    use image::ImageEncoder;

    if image.width().max(image.height()) <= DISPLAY_EDGE {
        return Ok(None);
    }
    let small = image.resize(
        DISPLAY_EDGE,
        DISPLAY_EDGE,
        image::imageops::FilterType::CatmullRom,
    );
    let mut out = Vec::new();
    if mime == "image/jpeg" {
        let rgb = small.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, DISPLAY_QUALITY)
            .write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|_| ApiError::internal())?;
    } else {
        let rgba = small.to_rgba8();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| ApiError::internal())?;
    }
    Ok(Some(out))
}

/// The display copy of an image already stored, for one uploaded before
/// copies were made (`display.rs`). The stored file was re-encoded on upload,
/// so it is read with the same limits and nothing else is done to it.
pub fn display_copy_of(bytes: &[u8], mime: &str) -> Result<Option<Vec<u8>>, ApiError> {
    if mime == "image/gif" {
        return Ok(None);
    }
    let decoded = decode_limited(bytes, |width, height, _| display_scratch(width, height))?;
    display_copy(&decoded, mime)
}

/// Blurhash is meant to be a smear of colour, so it is computed from a
/// thumbnail. The thumbnail is taken from the picture as it decoded and only
/// then made RGBA: converting the whole picture first would be one more
/// full-size copy.
fn blurhash_of(source: &image::DynamicImage) -> Option<String> {
    let (width, height) = (source.width(), source.height());
    if width == 0 || height == 0 {
        return None;
    }
    let scale = f64::from(BLURHASH_MAX_EDGE) / f64::from(width.max(height));
    let small = if scale < 1.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let (w, h) = (
            ((f64::from(width) * scale).round() as u32).max(1),
            ((f64::from(height) * scale).round() as u32).max(1),
        );
        source.thumbnail_exact(w, h).into_rgba8()
    } else {
        source.to_rgba8()
    };
    blurhash::encode(4, 3, small.width(), small.height(), small.as_raw()).ok()
}

// ---------------------------------------------------------------------------
// Video and audio: ffmpeg, if the host has it
// ---------------------------------------------------------------------------

struct Probe {
    duration_ms: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
}

/// Run a tool against an untrusted file and wait for it, but not forever.
///
/// `None` when the tool is missing, fails to start, or runs past `limit`. On
/// the last of those the child is killed rather than left behind: dropping the
/// future is what gives up waiting, and `kill_on_drop` makes the drop take the
/// process with it. Callers already treat `None` as "no probe data" or "no
/// poster", which is the ordinary outcome on a server without ffmpeg.
async fn bounded_output(mut command: tokio::process::Command, limit: Duration) -> Option<Output> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    // Bound first and match after, so the timed-out future (and with it the
    // child) is dropped here rather than at the end of the match.
    let finished = tokio::time::timeout(limit, command.output()).await;
    match finished {
        Ok(output) => output.ok(),
        Err(_) => {
            tracing::warn!(
                program = ?command.as_std().get_program(),
                limit_secs = limit.as_secs(),
                "media tool ran out of time; killed it"
            );
            None
        }
    }
}

async fn ffprobe(path: &Path) -> Option<Probe> {
    let mut command = tokio::process::Command::new("ffprobe");
    command
        .args(["-v", "error"])
        .args(PROBE_ARGS)
        .args(["-print_format", "json", "-show_format", "-show_streams"])
        .arg(path);
    let output = bounded_output(command, PROBE_TIMEOUT).await?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let duration_ms = json["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| (d * 1000.0).round() as u64);

    let video = json["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s["codec_type"].as_str() == Some("video"))
        })
        .cloned();

    #[allow(clippy::cast_possible_truncation)]
    let dimension = |value: &serde_json::Value| value.as_u64().map(|v| v as u32).filter(|v| *v > 0);

    Some(Probe {
        duration_ms,
        width: video.as_ref().and_then(|v| dimension(&v["width"])),
        height: video.as_ref().and_then(|v| dimension(&v["height"])),
    })
}

/// One frame, as JPEG. `None` whenever ffmpeg isn't installed, the file has
/// no frame to give, or it takes too long to give one — a missing poster is not
/// a failed upload.
async fn poster_frame(path: &Path) -> Option<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + POSTER_TIMEOUT;
    for seek in [POSTER_SECONDS, "0"] {
        let temp = tempfile::Builder::new()
            .suffix(".jpg")
            .tempfile()
            .ok()?
            .into_temp_path();
        let mut command = tokio::process::Command::new("ffmpeg");
        command
            .args(["-v", "error", "-nostdin", "-y"])
            .args(PROBE_ARGS)
            .args(["-ss", seek, "-i"])
            .arg(path)
            .args(["-an", "-sn", "-dn", "-frames:v", "1", "-f", "image2"])
            .arg(&temp);
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let output = bounded_output(command, left).await?;
        if output.status.success() {
            if let Ok(bytes) = tokio::fs::read(&temp).await {
                if !bytes.is_empty() {
                    return Some(bytes);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// A greyscale PNG of one bit a pixel, all black. It decodes to one byte
    /// a pixel, and its RGBA copy is four, so it is the cheapest way to make a
    /// picture whose copies cost far more than the picture.
    fn one_bit_png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::One);
        let row = usize::try_from(width.div_ceil(8)).unwrap();
        let rows = usize::try_from(height).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&vec![0; row * rows]).unwrap();
        writer.finish().unwrap();
        out
    }

    /// Re-encode into memory, for a test to look at.
    fn reencoded(bytes: &[u8], mime: &str) -> Result<(CleanImage, Vec<u8>), ApiError> {
        let mut out = Vec::new();
        let clean = reencode_image(bytes, mime, &mut out)?;
        Ok((clean, out))
    }

    #[test]
    fn re_encoding_keeps_the_picture_and_produces_a_blurhash() {
        let (clean, bytes) = reencoded(&png_bytes(40, 30), "image/png").unwrap();
        assert_eq!((clean.width, clean.height), (40, 30));
        assert_eq!(clean.mime, "image/png");
        assert!(clean.blurhash.is_some());
        assert!(decode_limited(&bytes, |_, _, _| 0).is_ok());

        // A JPEG stays one, and a big picture gets its display copy.
        let photo = {
            let mut out = Vec::new();
            image::DynamicImage::ImageRgb8(image::RgbImage::new(1200, 900))
                .write_to(
                    &mut std::io::Cursor::new(&mut out),
                    image::ImageFormat::Jpeg,
                )
                .unwrap();
            out
        };
        let (clean, bytes) = reencoded(&photo, "image/jpeg").unwrap();
        assert_eq!(clean.mime, "image/jpeg");
        assert_eq!((clean.width, clean.height), (1200, 900));
        assert_eq!(
            image::guess_format(&bytes).unwrap(),
            image::ImageFormat::Jpeg
        );
        let display = image::load_from_memory(&clean.display.unwrap()).unwrap();
        assert_eq!((display.width(), display.height()), (960, 720));
    }

    /// A picture that needs a copy made of it is still taken when the copy
    /// fits: a one-bit PNG is kept as RGBA, four times what it decodes to.
    #[test]
    fn a_picture_that_needs_a_copy_is_re_encoded_when_it_fits() {
        let (clean, bytes) = reencoded(&one_bit_png(64, 48), "image/png").unwrap();
        assert_eq!((clean.width, clean.height), (64, 48));
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgba8);
    }

    /// The smaller half of #487. This picture is 100 MB decoded, well inside
    /// the budget on its own, but kept as RGBA it is another 400 MB, and the
    /// display copy's working memory another 150: refused from its header,
    /// before any of it is decoded.
    #[test]
    fn a_picture_whose_copies_would_not_fit_is_refused_before_decoding() {
        let png = one_bit_png(10_000, 10_000);
        let started = std::time::Instant::now();
        let refused = reencoded(&png, "image/png")
            .err()
            .expect("a picture whose copies don't fit is refused");
        assert_eq!(refused.message, "That image can't be read.");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A GIF written by hand: a `width` × `height` canvas, then `frames`
    /// frames of one black pixel each in its top-left corner. A few bytes a
    /// frame, whatever size the canvas claims to be.
    fn gif_bytes(width: u16, height: u16, frames: usize) -> Vec<u8> {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&width.to_le_bytes());
        gif.extend_from_slice(&height.to_le_bytes());
        // A global colour table of two colours, black and white.
        gif.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]);
        for _ in 0..frames {
            // An image descriptor at (0, 0), one pixel by one, no local table,
            // then its pixel: colour 0, LZW-coded with a two-bit code size.
            gif.extend_from_slice(&[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
            gif.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        }
        gif.push(0x3b);
        gif
    }

    fn frames_in(gif: &[u8]) -> usize {
        use image::AnimationDecoder;
        image::codecs::gif::GifDecoder::new(std::io::Cursor::new(gif))
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap()
            .len()
    }

    #[test]
    fn a_gif_stays_animated() {
        let (clean, bytes) = reencoded(&gif_bytes(8, 6, 3), "image/gif").unwrap();
        assert_eq!(clean.mime, "image/gif");
        assert_eq!((clean.width, clean.height), (8, 6));
        assert!(clean.blurhash.is_some());
        assert!(clean.display.is_none());
        assert_eq!(frames_in(&bytes), 3);
    }

    /// The bomb in #487: a few dozen bytes that claim a 65535 × 65535 canvas,
    /// 17 GB as pixels. It is refused from its header, and quickly.
    #[test]
    fn a_gif_that_claims_a_huge_canvas_is_refused_without_drawing_it() {
        let started = std::time::Instant::now();
        let refused = reencoded(&gif_bytes(u16::MAX, u16::MAX, 1), "image/gif")
            .err()
            .expect("a 65535 × 65535 GIF is refused");
        assert_eq!(refused.message, "That image can't be read.");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// Every frame of a GIF comes out of the decoder as a whole canvas. A
    /// thousand one-pixel frames on a 2048 × 2048 canvas is 16 GB of them, in
    /// a file of 15 KB, and it is refused before any of them is drawn.
    #[test]
    fn a_gif_with_too_many_frames_for_its_canvas_is_refused_before_drawing_them() {
        let started = std::time::Instant::now();
        let refused = reencoded(&gif_bytes(2048, 2048, 1000), "image/gif")
            .err()
            .expect("frames × canvas past the budget is refused");
        assert_eq!(refused.message, "That image can't be read.");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A frame can be bigger than its canvas, and is decoded whole before
    /// the canvas clips it. Fifteen 3000 × 3000 frames on a canvas of one
    /// pixel: 135 million pixels to decode, in a file of a few hundred KB,
    /// refused before any of them is decoded.
    #[test]
    fn a_gif_whose_frames_are_bigger_than_its_canvas_is_counted_by_its_frames() {
        let mut gif = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut gif, 1, 1, &[0, 0, 0, 255, 255, 255]).unwrap();
            let mut frame = gif::Frame {
                width: 3000,
                height: 3000,
                buffer: std::borrow::Cow::Owned(vec![0; 3000 * 3000]),
                ..gif::Frame::default()
            };
            // Compressed once, written fifteen times.
            frame.make_lzw_pre_encoded();
            for _ in 0..15 {
                encoder.write_lzw_pre_encoded_frame(&frame).unwrap();
            }
        }
        let started = std::time::Instant::now();
        let refused = reencoded(&gif, "image/gif")
            .err()
            .expect("frames past the budget are refused, whatever the canvas");
        assert_eq!(refused.message, "That image can't be read.");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// The clean picture is written beside the upload and put in its place
    /// only once it is whole. A picture that fails part-way leaves the upload
    /// as it arrived, and a re-encode still running for a request nobody is
    /// waiting on never writes into a file a retry has made since.
    #[tokio::test]
    async fn a_picture_that_fails_to_re_encode_leaves_the_upload_as_it_was() {
        let _turn = QUEUE.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("assembled");
        // A real PNG, cut off after its header: it sniffs as a PNG and its
        // pixels can't be read.
        let mut broken = png_bytes(64, 64);
        broken.truncate(100);
        tokio::fs::write(&path, &broken).await.unwrap();

        let refused = process(&path, "image/png", "cut.png")
            .await
            .err()
            .expect("a cut-off PNG is refused");
        assert_eq!(refused.message, "That image can't be read.");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), broken);
        // Nothing left lying beside it either.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// The line is drawn at the budget, not short of it: on that canvas, the
    /// frames that fit in 512 MB are counted, and one more is refused.
    #[test]
    fn a_gif_may_have_as_many_frames_as_the_budget_holds() {
        let canvas = 2048 * 2048;
        let fit = usize::try_from(MAX_DECODE_ALLOC / (canvas * 4)).unwrap();
        assert_eq!(
            gif_frames(&gif_bytes(2048, 2048, fit), canvas).unwrap(),
            fit
        );
        assert!(gif_frames(&gif_bytes(2048, 2048, fit + 1), canvas).is_err());
    }

    /// A progressive JPEG keeps every coefficient until its last pass, about
    /// three times the memory of a plain one, and `image` doesn't count it.
    /// Two copies of one 64 × 64 picture: the plain one needs its file twice
    /// and 12 KB of pixels, under 14 KB; the progressive one 7 bytes a pixel
    /// more, 30 KB. At 24 KB the plain one decodes and the progressive one
    /// is refused.
    #[test]
    fn a_progressive_jpeg_counts_what_its_decoder_holds() {
        let baseline = include_bytes!("../tests/fixtures/baseline-64.jpg");
        let progressive = include_bytes!("../tests/fixtures/progressive-64.jpg");
        let budget = 24 * 1024;
        assert!(decode_within(baseline, budget, |_, _, _| 0).is_ok());
        let refused = decode_within(progressive, budget, |_, _, _| 0)
            .expect_err("the coefficients are counted");
        assert_eq!(refused.message, "That image can't be read.");
        // With room for them, it decodes like any other.
        assert!(decode_within(progressive, 2 * budget, |_, _, _| 0).is_ok());
    }

    /// The tests of the image queue share it, so they take turns with it.
    static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Work done in the image queue, as an upload does it.
    async fn queued<T: Send + 'static>(
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ApiError> {
        ImageLane::wait().await?.run(work).await
    }

    /// An upload that can't get a place in time hears that the server is
    /// busy, and when to try again, well before the app gives up on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_upload_that_cant_get_a_place_in_time_hears_the_server_is_busy() {
        let _turn = QUEUE.lock().await;

        let mut holders = tokio::task::JoinSet::new();
        for _ in 0..IMAGE_JOBS {
            let lane = ImageLane::wait().await.unwrap();
            holders.spawn(lane.run(|| std::thread::sleep(Duration::from_millis(500))));
        }
        let waited = tokio::time::timeout(
            Duration::from_secs(2),
            ImageLane::wait_at_most(Duration::from_millis(50)),
        )
        .await
        .expect("the wait for a place has a limit");
        let refused = waited.err().expect("no place came free in time");
        assert_eq!(refused.code, linger_core::wire::ErrorCode::RateLimited);
        assert_eq!(refused.retry_after_ms, Some(IMAGE_BUSY_RETRY_MS));

        while let Some(held) = holders.join_next().await {
            held.unwrap().unwrap();
        }
        assert!(ImageLane::wait_at_most(Duration::from_millis(50))
            .await
            .is_ok());
    }

    /// At most [`IMAGE_JOBS`] run at once, however many are waiting.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn only_a_couple_of_images_are_worked_on_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let _turn = QUEUE.lock().await;

        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let (running, most) = (running.clone(), most.clone());
            jobs.spawn(queued(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(100));
                running.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap().unwrap();
        }
        let most = most.load(Ordering::SeqCst);
        assert!((1..=IMAGE_JOBS).contains(&most), "{most} ran at once");
    }

    /// A request that stops waiting doesn't hand its place to the next image
    /// while its own is still being worked on: that memory is still in use.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_abandoned_image_keeps_its_place_until_its_work_ends() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let _turn = QUEUE.lock().await;

        let finished = Arc::new(AtomicUsize::new(0));
        for _ in 0..IMAGE_JOBS {
            let finished = finished.clone();
            let job = queued(move || {
                std::thread::sleep(Duration::from_millis(300));
                finished.fetch_add(1, Ordering::SeqCst);
            });
            // Given up on long before the work is done.
            assert!(tokio::time::timeout(Duration::from_millis(20), job)
                .await
                .is_err());
        }
        // The next one gets the first place to come free, which is when the
        // first of them is done: not as soon as nobody is waiting for them.
        let seen = finished.clone();
        let finished_first = queued(move || seen.load(Ordering::SeqCst)).await.unwrap();
        assert!(finished_first >= 1, "the next image started beside them");
    }

    #[test]
    fn a_webp_comes_back_as_a_png_with_a_matching_name() {
        assert_eq!(
            corrected_filename("holiday.webp", "image/webp", "image/png"),
            "holiday.png"
        );
        assert_eq!(
            corrected_filename("holiday.jpg", "image/jpeg", "image/jpeg"),
            "holiday.jpg"
        );
    }

    #[tokio::test]
    async fn a_file_that_isnt_what_it_says_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("staged");

        tokio::fs::write(&path, png_bytes(4, 4)).await.unwrap();
        assert_eq!(resolve_mime(&path, "image/png").await.unwrap(), "image/png");
        // A real PNG declared as a video is still a lie.
        assert!(resolve_mime(&path, "video/mp4").await.is_err());

        // A zip wearing a .png name.
        tokio::fs::write(&path, b"PK\x03\x04zipzipzip")
            .await
            .unwrap();
        assert!(resolve_mime(&path, "image/png").await.is_err());

        // Plain text has no magic bytes, so it is taken at its word.
        tokio::fs::write(&path, b"just some notes\n").await.unwrap();
        assert_eq!(
            resolve_mime(&path, "text/plain").await.unwrap(),
            "text/plain"
        );
        assert!(resolve_mime(&path, "image/jpeg").await.is_err());
    }

    /// The start of a WebM file as the sniffer knows one: the EBML header with
    /// its doc type, then enough of anything to pass its length check.
    fn webm_bytes() -> Vec<u8> {
        let mut bytes = vec![0x1a, 0x45, 0xdf, 0xa3, 0x8f, 0x42, 0x86, 0x81, 0x01];
        bytes.extend_from_slice(&[0x42, 0x82, 0x84]);
        bytes.extend_from_slice(b"webm");
        bytes.extend_from_slice(&[0x42, 0x87, 0x81, 0x04]);
        bytes.resize(400, 0xec);
        bytes
    }

    #[tokio::test]
    async fn a_webm_declared_as_sound_is_sound_and_otherwise_a_video() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("staged");
        tokio::fs::write(&path, webm_bytes()).await.unwrap();
        assert_eq!(
            resolve_mime(&path, "audio/webm").await.unwrap(),
            "audio/webm"
        );
        assert_eq!(
            resolve_mime(&path, "video/webm").await.unwrap(),
            "video/webm"
        );
        // Sound in some other container is still checked as it was.
        assert!(resolve_mime(&path, "audio/ogg").await.is_err());
        // And a PNG declared as sound is still a lie.
        tokio::fs::write(&path, png_bytes(4, 4)).await.unwrap();
        assert!(resolve_mime(&path, "audio/webm").await.is_err());
    }

    /// The case the limit exists for: a tool that never finishes. It has to
    /// come back as "no answer" on time, and it must not be left running.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_that_runs_too_long_is_killed_and_gives_no_answer() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            .arg(format!("echo $$ > '{}'; exec sleep 30", pidfile.display()));

        let started = std::time::Instant::now();
        assert!(bounded_output(command, Duration::from_millis(500))
            .await
            .is_none());
        assert!(started.elapsed() < Duration::from_secs(5));

        // `exec` makes the sleep the same process the shell was, so the pid
        // it wrote is the process that has to be gone. A zombie waiting to be
        // reaped counts as gone: it is dead and holds nothing.
        #[cfg(target_os = "linux")]
        {
            let pid = std::fs::read_to_string(&pidfile).unwrap();
            let stat = format!("/proc/{}/stat", pid.trim());
            let mut alive = true;
            for _ in 0..50 {
                alive = std::fs::read_to_string(&stat)
                    .map(|s| !s.split_whitespace().nth(2).is_some_and(|st| st == "Z"))
                    .unwrap_or(false);
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(!alive, "the timed-out child is still running");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_that_finishes_in_time_hands_back_its_output() {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg("echo probed");
        let output = bounded_output(command, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"probed\n");
    }

    /// A tool that is not installed is the ordinary case on a server without
    /// ffmpeg, and it is an absence, not an error.
    #[tokio::test]
    async fn a_missing_tool_gives_no_answer() {
        let command = tokio::process::Command::new("linger-no-such-tool");
        assert!(bounded_output(command, Duration::from_secs(1))
            .await
            .is_none());
    }
}
