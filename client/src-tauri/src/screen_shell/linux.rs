//! The screen itself, on Linux: the desktop's screen-sharing portal picks
//! it, PipeWire carries it, and GStreamer turns it into VP8 (#360, T-1907).
//!
//! The portal (`org.freedesktop.portal.ScreenCast`) shows the desktop's own
//! picker, and answers with a PipeWire stream of what was picked: a node to
//! read and a connection to read it on. Nothing in the answer names a window
//! or an application, and nothing here asks (hard rule 2).
//!
//! GStreamer reads the stream in ordinary memory, not as GPU buffers. That
//! is the point of doing it here: WebKitGTK reads a shared screen only as GPU
//! buffers, and on a computer with two GPUs, or none it can use for this, it
//! can't turn them into pictures (T-1907 in TASKS.md). Every portal can hand
//! over ordinary memory. The pictures are scaled to fit 1080p, held to the
//! share's speed, and encoded the way the page encodes them
//! (`client/src/lib/screen/presets.ts`): VP8 in real time at the same bits a
//! second, a key frame at least every ten seconds.

use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ashpd::desktop::screencast::{
    CursorMode, Screencast, SelectSourcesOptions, SourceType, StartCastOptions,
};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Session};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use linger_core::screen::{ScreenCodec, ScreenFrameHead};

/// Why there's no screen to share.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// The person closed the picker.
    Declined,
    /// This desktop has no screen-sharing portal, or it failed.
    NoScreen(String),
}

/// What was picked: the portal's session, which lasts as long as the share,
/// and where its pictures come from.
pub struct Picked {
    portal: Screencast,
    session: Session<Screencast>,
    remote: OwnedFd,
    node: u32,
    /// How big the portal says the stream is, when it says.
    size: Option<(u32, u32)>,
}

impl Picked {
    /// End the portal's session, which takes the desktop's "sharing" mark
    /// away.
    pub async fn close(self) {
        let _ = self.session.close().await;
        drop(self.portal);
    }
}

/// Ask the desktop for a screen: its picker opens, and this waits for the
/// person.
pub async fn pick() -> Result<Picked, Refused> {
    let refused = |error: ashpd::Error| match error {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => Refused::Declined,
        other => Refused::NoScreen(other.to_string()),
    };
    let portal = Screencast::new().await.map_err(refused)?;
    let session = portal
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(refused)?;
    // One screen or one window, the pointer drawn in, nothing remembered for
    // next time.
    portal
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Embedded)
                .set_sources(SourceType::Monitor | SourceType::Window)
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await
        .map_err(refused)?
        .response()
        .map_err(refused)?;
    let streams = portal
        .start(&session, None, StartCastOptions::default())
        .await
        .map_err(refused)?
        .response()
        .map_err(refused)?;
    // Only the stream's PipeWire node and how big it is, to ask for it at
    // the size it's sent: where it sits and which kind it is aren't needed,
    // and nothing names what it shows.
    let Some((node, size)) = streams.streams().first().map(|stream| {
        let size = stream.size().and_then(|(width, height)| {
            Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
        });
        (stream.pipe_wire_node_id(), size)
    }) else {
        let _ = session.close().await;
        return Err(Refused::NoScreen(
            "the portal answered with no screen".into(),
        ));
    };
    let remote = match portal
        .open_pipe_wire_remote(&session, Default::default())
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let _ = session.close().await;
            return Err(refused(error));
        }
    };
    Ok(Picked {
        portal,
        session,
        remote,
        node,
        size,
    })
}

/// Whether this desktop has a screen-sharing portal that shares screens.
/// It's a property read: nothing opens.
pub async fn portal_shares() -> bool {
    match Screencast::new().await {
        Ok(portal) => portal
            .available_source_types()
            .await
            .is_ok_and(|types| types.contains(SourceType::Monitor)),
        Err(_) => false,
    }
}

/// The GStreamer elements a share is made of, each from the system's
/// plugins: PipeWire's source (`gst-plugin-pipewire`), the converters, rate
/// and split (`gst-plugins-base` and GStreamer's own) and VP8
/// (`gst-plugins-good`).
const ELEMENTS: [&str; 9] = [
    "pipewiresrc",
    "capsfilter",
    "videoconvert",
    "videoscale",
    "videorate",
    "queue",
    "tee",
    "vp8enc",
    "appsink",
];

/// And the preview's, which a share goes without where it's missing: JPEG
/// (`gst-plugins-good`).
const PREVIEW_ELEMENTS: [&str; 1] = ["jpegenc"];

fn have(names: &[&str]) -> bool {
    names
        .iter()
        .all(|name| gst::ElementFactory::find(name).is_some())
}

/// Whether this computer's GStreamer has every element a share needs.
pub fn can_encode() -> bool {
    gst::init().is_ok() && have(&ELEMENTS)
}

/// One speed's settings, as `presets.ts` has them for the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Speed {
    pub fps: u32,
    pub bits_per_second: u32,
    /// libvpx's speed for real time: higher is less work for a little less
    /// sharpness. A 60 fps share does twice the frames in the same time.
    pub effort: i32,
}

/// The two speeds (SPEC §4.20), or None for any other.
pub fn speed(fps: u8) -> Option<Speed> {
    match fps {
        30 => Some(Speed {
            fps: 30,
            bits_per_second: 4_500_000,
            effort: 8,
        }),
        60 => Some(Speed {
            fps: 60,
            bits_per_second: 6_000_000,
            effort: 12,
        }),
        _ => None,
    }
}

/// The largest picture sent, as for the page's shares.
pub const MAX_WIDTH: u32 = 1920;
pub const MAX_HEIGHT: u32 = 1080;
/// The preview: your own small copy of what's sent, beside Stop, a few
/// times a second (`client/src/next/app/screen/SharingBox.tsx`).
const PREVIEW_WIDTH: u32 = 480;
const PREVIEW_HEIGHT: u32 = 270;
const PREVIEW_FPS: u32 = 4;
/// A share, looked at once a second for whether it has gone black, at a
/// small size, as the page looks at its own (`client/src/lib/screen/black.ts`,
/// which has why): a slide show runs in a window of its own, and a shared
/// window comes out black.
const LOOK_WIDTH: u32 = 160;
const LOOK_HEIGHT: u32 = 90;
const LOOK_FPS: u32 = 1;
/// The brightest a black picture's pixel is, out of 255: GStreamer's
/// conversion puts black at 16 and white at 235, not 0 and 255.
const BLACK_LEVEL: u8 = 24;

/// Whether a picture's brightness, one byte a pixel, is black: one pixel in
/// a thousand may be brighter, for a pointer over it. As `looksBlack` in
/// `black.ts`.
pub fn looks_black(brightness: &[u8]) -> bool {
    if brightness.is_empty() {
        return false;
    }
    let allowed = brightness.len() / 1000;
    brightness
        .iter()
        .filter(|&&value| value > BLACK_LEVEL)
        .count()
        <= allowed
}

/// `width` by `height` made to fit `most_width` by `most_height`, its shape
/// kept, never made bigger, in even numbers (I420 halves both). As
/// `fitWithin` in `presets.ts`.
pub fn fit(width: u32, height: u32, most_width: u32, most_height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (most_width, most_height);
    }
    let scale = (f64::from(most_width) / f64::from(width))
        .min(f64::from(most_height) / f64::from(height))
        .min(1.0);
    let even = |side: u32| -> u32 {
        // In range by construction: side * scale is at most `most_*`.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let scaled = (f64::from(side) * scale).round() as u32;
        (scaled & !1).max(2)
    };
    (even(width), even(height))
}
/// A key frame at least this often, in seconds (`KEYFRAME_EVERY_MS`).
const KEYFRAME_EVERY_S: u32 = 10;
/// A screen that isn't changing still sends a picture this often, so a
/// watcher who arrives gets one and a key frame asked for comes soon.
const STILL_EVERY_MS: u32 = 500;

/// How many buffers PipeWire is asked to pass pictures in. With its default
/// of two, a portal that fills one while this holds the other (the last
/// picture, kept to send again while the screen is still) had none free and
/// sent one picture in all (sway's portal, 2026-10-25).
const BUFFERS: u32 = 8;

/// The size a share is sent at, from how big the portal says the stream is.
/// A portal that doesn't say gets the largest, and the picture is fitted
/// into it with borders.
pub fn sent_size(stream: Option<(u32, u32)>) -> (u32, u32) {
    match stream {
        Some((width, height)) => fit(width, height, MAX_WIDTH, MAX_HEIGHT),
        None => (MAX_WIDTH, MAX_HEIGHT),
    }
}

/// What PipeWire is asked for: the size it's sent at, which a portal that
/// can scale (a whole monitor, on Hyprland's) makes itself, or else the
/// stream as it is. Asked for as a range, a portal that can scale gave the
/// smallest it could, two pixels by two (2026-10-25), so the size is named.
pub fn source_caps(size: (u32, u32)) -> String {
    format!("video/x-raw,width={},height={};video/x-raw", size.0, size.1)
}

/// The pipeline, as GStreamer's launch syntax: `remote` and `node` are the
/// portal's, `size` the size it's sent at, and the preview is there when
/// `preview`. The look for whether it's black is always there. The preview is switched where its branch starts (`Capture`'s
/// `preview`), not with GStreamer's `valve`: closing a valve there stopped
/// the whole share, and opening it again gave one picture (2026-10-25). Its
/// sink doesn't hold the pipeline up for a first picture (`async=false`):
/// one that starts hidden never gets one, and the share never started. Frames past the share's speed are
/// dropped first, the speed named as a frame rate: PipeWire's stream says it
/// has none, and `videorate`'s `max-rate` lets every frame of a stream like
/// that through, and the picture is made its size before its colours are
/// converted, which is the cheaper order from a big screen: from 4K at 60
/// frames a second this takes about one and a half cores of a desktop CPU,
/// with room for more than twice the frames (measured 2026-10-25). The
/// scaling and converting are spread over up to four threads; on one, they
/// alone held a 1440p screen to about 70 frames a second.
pub fn pipeline_text(
    remote: i32,
    node: u32,
    speed: Speed,
    threads: usize,
    size: (u32, u32),
    preview: bool,
) -> String {
    let source = format!(
        "pipewiresrc fd={remote} path={node} do-timestamp=true keepalive-time={STILL_EVERY_MS} always-copy=true min-buffers={BUFFERS}"
    );
    pipeline_from(&source, speed, threads, size, preview)
}

/// The pipeline after its source: `pipeline_text`'s, or a test's.
fn pipeline_from(
    source: &str,
    speed: Speed,
    threads: usize,
    size: (u32, u32),
    preview: bool,
) -> String {
    let (width, height) = size;
    let helpers = threads.min(4);
    let mut text = format!(
        "{source} \
         ! capsfilter name=source \
         ! videorate drop-only=true ! video/x-raw,framerate={fps}/1 \
         ! videoscale n-threads={helpers} add-borders=true ! video/x-raw,width={width},height={height},pixel-aspect-ratio=1/1 \
         ! videoconvert n-threads={helpers} ! video/x-raw,format=I420 \
         ! tee name=split \
         split. ! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream \
         ! vp8enc name=encoder deadline=1 cpu-used={effort} end-usage=cbr target-bitrate={bits} \
           keyframe-max-dist={keys} lag-in-frames=0 static-threshold=100 threads={threads} \
         ! appsink name=frames sync=false max-buffers=8 emit-signals=false",
        fps = speed.fps,
        effort = speed.effort,
        bits = speed.bits_per_second,
        keys = speed.fps * KEYFRAME_EVERY_S,
    );
    if preview {
        let (small_width, small_height) = fit(width, height, PREVIEW_WIDTH, PREVIEW_HEIGHT);
        text.push_str(&format!(
            " split. ! queue name=preview max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream \
             ! videorate drop-only=true ! video/x-raw,framerate={PREVIEW_FPS}/1 \
             ! videoscale ! video/x-raw,width={small_width},height={small_height} \
             ! jpegenc quality=70 \
             ! appsink name=pictures sync=false async=false max-buffers=1 drop=true emit-signals=false"
        ));
    }
    // Brightness alone, a byte a pixel, from the elements the share already
    // has; like the preview's, its sink holds nothing up.
    text.push_str(&format!(
            " split. ! queue name=look max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream \
             ! videorate drop-only=true ! video/x-raw,framerate={LOOK_FPS}/1 \
             ! videoscale ! video/x-raw,width={LOOK_WIDTH},height={LOOK_HEIGHT} \
             ! videoconvert ! video/x-raw,format=GRAY8 \
             ! appsink name=looks sync=false async=false max-buffers=1 drop=true emit-signals=false"
        ));
    text
}

/// How a share ended by itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The screen went: the desktop's own Stop, or the window shared closed.
    Gone,
    /// GStreamer couldn't read or encode it.
    Failed(String),
}

/// A share that couldn't start: why, and the portal's session, to close.
pub struct StartFailed {
    pub why: String,
    pub picked: Picked,
}

/// Where a share's output goes, each from GStreamer's own threads: every
/// frame, already in the screen socket's shape (PROTOCOL §8: the 12-byte
/// header, then the VP8 frame); the preview's pictures, as JPEG, while it's
/// shown; once a second, whether it's black; and,
/// once, how it ended if it ended by itself.
pub struct Outlets<F, P, L, E> {
    pub frame: F,
    pub picture: P,
    pub looked: L,
    pub ended: E,
}

/// A share running: the picked screen through GStreamer.
pub struct Capture {
    pipeline: gst::Pipeline,
    frames: gst_app::AppSink,
    /// Whether the preview is shown, where there is one: its branch takes
    /// no frames while it isn't.
    preview: Option<Arc<AtomicBool>>,
    picked: Option<Picked>,
}

impl Capture {
    /// Start reading `picked` at `speed`, the preview shown or not.
    pub fn start<F, P, L, E>(
        picked: Picked,
        speed: Speed,
        shown: bool,
        outlets: Outlets<F, P, L, E>,
    ) -> Result<Self, StartFailed>
    where
        F: Fn(Vec<u8>) + Send + Sync + 'static,
        P: Fn(Vec<u8>) + Send + Sync + 'static,
        L: Fn(bool) + Send + Sync + 'static,
        E: Fn(Ended) + Send + Sync + 'static,
    {
        let threads = std::thread::available_parallelism().map_or(2, |count| count.get().min(8));
        let size = sent_size(picked.size);
        let preview = gst::init().is_ok() && have(&PREVIEW_ELEMENTS);
        let text = pipeline_text(
            picked.remote.as_raw_fd(),
            picked.node,
            speed,
            threads,
            size,
            preview,
        );
        match Self::run(&text, size, outlets) {
            Ok((pipeline, frames, switch)) => {
                let capture = Self {
                    pipeline,
                    frames,
                    preview: switch,
                    picked: Some(picked),
                };
                capture.show_preview(shown);
                Ok(capture)
            }
            Err(why) => Err(StartFailed { why, picked }),
        }
    }

    fn run<F, P, L, E>(
        text: &str,
        size: (u32, u32),
        outlets: Outlets<F, P, L, E>,
    ) -> Result<(gst::Pipeline, gst_app::AppSink, Option<Arc<AtomicBool>>), String>
    where
        F: Fn(Vec<u8>) + Send + Sync + 'static,
        P: Fn(Vec<u8>) + Send + Sync + 'static,
        L: Fn(bool) + Send + Sync + 'static,
        E: Fn(Ended) + Send + Sync + 'static,
    {
        gst::init().map_err(|error| error.to_string())?;
        let pipeline = gst::parse_launch(text)
            .map_err(|error| error.to_string())?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "not a pipeline".to_string())?;
        let caps = source_caps(size)
            .parse::<gst::Caps>()
            .map_err(|error| error.to_string())?;
        pipeline
            .by_name("source")
            .ok_or("no source element")?
            .set_property("caps", &caps);
        let sink = |name: &str| {
            pipeline
                .by_name(name)
                .and_then(|element| element.downcast::<gst_app::AppSink>().ok())
        };
        let frames = sink("frames").ok_or("no frames element")?;
        let Outlets {
            frame,
            picture,
            looked,
            ended,
        } = outlets;
        frames.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let Some(buffer) = sample.buffer() else {
                        return Ok(gst::FlowSuccess::Ok);
                    };
                    let key = !buffer.flags().contains(gst::BufferFlags::DELTA_UNIT);
                    let micros = buffer.pts().map_or(0, gst::ClockTime::useconds);
                    let Ok(map) = buffer.map_readable() else {
                        return Ok(gst::FlowSuccess::Ok);
                    };
                    frame(packed(key, micros, map.as_slice()));
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        if let Some(pictures) = sink("pictures") {
            pictures.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(map) = sample
                            .buffer()
                            .and_then(|buffer| buffer.map_readable().ok())
                        {
                            picture(map.as_slice().to_vec());
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }
        if let Some(looks) = sink("looks") {
            looks.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(map) = sample
                            .buffer()
                            .and_then(|buffer| buffer.map_readable().ok())
                        {
                            looked(looks_black(map.as_slice()));
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }
        // Hidden, the preview's branch drops each frame as it comes in, so it
        // holds none and does nothing; everything else carries on as it was.
        let switch = pipeline
            .by_name("preview")
            .and_then(|queue| queue.static_pad("sink"))
            .map(|pad| {
                let shown = Arc::new(AtomicBool::new(false));
                let asked = shown.clone();
                pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                    if asked.load(Ordering::Relaxed) {
                        gst::PadProbeReturn::Ok
                    } else {
                        gst::PadProbeReturn::Drop
                    }
                });
                shown
            });
        let bus = pipeline.bus().ok_or("no bus")?;
        if let Err(error) = pipeline.set_state(gst::State::Playing) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(error.to_string());
        }
        // Watched from here on: the bus keeps what came before for it.
        let ended = Arc::new(ended);
        let watched = std::thread::Builder::new()
            .name("screen-share-bus".into())
            .spawn(move || {
                for message in bus.iter_timed(gst::ClockTime::NONE) {
                    match message.view() {
                        gst::MessageView::Eos(_) => {
                            ended(Ended::Gone);
                            break;
                        }
                        gst::MessageView::Error(error) => {
                            ended(Ended::Failed(error.error().to_string()));
                            break;
                        }
                        // Posted by `stop`: nobody needs telling.
                        gst::MessageView::Application(_) => break,
                        _ => {}
                    }
                }
            });
        if let Err(error) = watched {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(error.to_string());
        }
        Ok((pipeline, frames, switch))
    }

    /// Show the preview or hide it. Hidden, its pictures are dropped before
    /// they're made smaller or turned into JPEG, so it costs nothing.
    pub fn show_preview(&self, shown: bool) {
        if let Some(switch) = &self.preview {
            switch.store(shown, Ordering::Relaxed);
        }
    }

    /// Make the next frame a key frame: somebody new is watching, or a
    /// watcher fell behind.
    pub fn keyframe(&self) {
        // GStreamer's own "force key unit" event, as gst-video builds it,
        // sent up from the end of the pipeline to the encoder.
        let ask = gst::Structure::builder("GstForceKeyUnit")
            .field("running-time", u64::MAX)
            .field("all-headers", true)
            .field("count", 0u32)
            .build();
        self.frames.send_event(gst::event::CustomUpstream::new(ask));
    }

    /// Stop reading and let the portal's session go. Returns the session to
    /// close, which is a call to the desktop.
    pub fn stop(mut self) -> Option<Picked> {
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Some(bus) = self.pipeline.bus() {
            let _ = bus.post(gst::message::Application::new(gst::Structure::new_empty(
                "linger-stop",
            )));
        }
        self.picked.take()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// A frame in the screen socket's shape: the header, then the frame.
pub fn packed(key: bool, micros: u64, data: &[u8]) -> Vec<u8> {
    let head = ScreenFrameHead {
        codec: ScreenCodec::Vp8,
        key,
    }
    .write(micros);
    let mut out = Vec::with_capacity(head.len() + data.len());
    out.extend_from_slice(&head);
    out.extend_from_slice(data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_speeds_match_the_pages() {
        // presets.ts: 30 fps at 4.5 Mbit/s, 60 at 6.
        assert_eq!(speed(30).map(|s| s.bits_per_second), Some(4_500_000));
        assert_eq!(speed(60).map(|s| s.bits_per_second), Some(6_000_000));
        assert_eq!(speed(24), None);
        assert_eq!(speed(0), None);
    }

    #[test]
    fn a_frame_is_packed_as_the_socket_reads_it() {
        let frame = packed(true, 1_234_567, &[9, 8, 7]);
        let head = ScreenFrameHead::read(&frame).expect("a header");
        assert_eq!(head.codec, ScreenCodec::Vp8);
        assert!(head.key);
        assert_eq!(&frame[frame.len() - 3..], &[9, 8, 7]);
        assert!(
            !ScreenFrameHead::read(&packed(false, 0, &[1]))
                .expect("a header")
                .key
        );
    }

    #[test]
    fn the_pipeline_reads_the_portals_stream_and_keeps_to_the_speed() {
        let text = pipeline_text(42, 77, speed(60).expect("60"), 4, (1920, 1080), true);
        assert!(text.starts_with("pipewiresrc fd=42 path=77 "));
        // Named as a rate, which holds a stream with no rate of its own to it.
        assert!(text.contains("videorate drop-only=true ! video/x-raw,framerate=60/1"));
        assert!(!text.contains("max-rate"));
        assert!(text.contains("target-bitrate=6000000"));
        assert!(text.contains("keyframe-max-dist=600"));
        assert!(text.contains("video/x-raw,width=1920,height=1080,pixel-aspect-ratio=1/1"));
        // Made its size before the colours are converted, on four threads at most.
        assert!(
            text.find("videoscale").unwrap_or(usize::MAX) < text.find("videoconvert").unwrap_or(0)
        );
        assert!(
            text.contains("videoscale n-threads=4") && text.contains("videoconvert n-threads=4")
        );
        // Ordinary memory: nothing asks PipeWire for GPU buffers.
        assert!(!text.contains("DMABuf"));
        // The pipeline reads the stream and nothing else: no file, no network.
        for part in text.split('!') {
            let element = part.split_whitespace().next().unwrap_or("");
            let element = element.strip_prefix("split.").map_or(element, str::trim);
            assert!(
                element.is_empty()
                    || ELEMENTS.contains(&element)
                    || PREVIEW_ELEMENTS.contains(&element)
                    || element.starts_with("video/x-raw")
                    || element == "split.",
                "{element} isn't one of the share's elements"
            );
        }
    }

    #[test]
    fn a_still_screen_keeps_sending_and_key_frames_come_often_enough() {
        let text = pipeline_text(3, 4, speed(30).expect("30"), 2, (1280, 720), false);
        assert!(text.contains(&format!("keepalive-time={STILL_EVERY_MS}")));
        assert!(text.contains("keyframe-max-dist=300"));
    }

    #[test]
    fn a_big_screen_is_sent_at_1080p_its_shape_kept_and_a_small_one_as_it_is() {
        assert_eq!(sent_size(Some((3840, 2160))), (1920, 1080));
        assert_eq!(sent_size(Some((2560, 1440))), (1920, 1080));
        // An ultrawide keeps its shape, and the numbers stay even.
        assert_eq!(sent_size(Some((3440, 1440))), (1920, 804));
        assert_eq!(sent_size(Some((1896, 1040))), (1896, 1040));
        assert_eq!(sent_size(Some((801, 601))), (800, 600));
        // A portal that doesn't say: the largest, fitted with borders.
        assert_eq!(sent_size(None), (1920, 1080));
        assert_eq!(fit(0, 0, 1920, 1080), (1920, 1080));
    }

    #[test]
    fn the_size_is_asked_for_by_name_never_as_a_range() {
        // A range gave two pixels by two from a portal that scales (2026-10-25).
        let caps = source_caps((1920, 1080));
        assert_eq!(caps, "video/x-raw,width=1920,height=1080;video/x-raw");
        assert!(!caps.contains('['));
    }

    #[test]
    fn the_preview_is_small_slow_and_switched_off_until_shown() {
        let text = pipeline_text(1, 2, speed(30).expect("30"), 2, (1920, 1080), true);
        let preview = &text[text.find("queue name=preview").expect("a preview")..];
        // Switched at its start, not with a valve, which stopped the whole share.
        assert!(!text.contains("valve"));
        assert!(preview.contains(&format!("framerate={PREVIEW_FPS}/1")));
        assert!(preview.contains("width=480,height=270"));
        assert!(preview.contains("jpegenc"));
        // A preview that starts hidden doesn't hold the share up.
        assert!(preview.contains("appsink name=pictures sync=false async=false"));
        // Without the preview's elements, a share goes without one.
        assert!(
            !pipeline_text(1, 2, speed(30).expect("30"), 2, (1920, 1080), false)
                .contains("preview")
        );
    }

    #[test]
    fn a_black_picture_is_black_and_a_dark_one_with_something_on_it_isnt() {
        let pixels = (LOOK_WIDTH * LOOK_HEIGHT) as usize;
        // GStreamer's black is 16.
        assert!(looks_black(&vec![16; pixels]));
        assert!(looks_black(&vec![BLACK_LEVEL; pixels]));
        assert!(!looks_black(&vec![BLACK_LEVEL + 1; pixels]));
        // A pointer over it: one pixel in a thousand, and no more.
        let mut pointer = vec![16; pixels];
        pointer[..pixels / 1000].fill(235);
        assert!(looks_black(&pointer));
        pointer[pixels / 1000] = 235;
        assert!(!looks_black(&pointer));
        // A line of white text across a black slide.
        let mut title = vec![16; pixels];
        title[..300].fill(235);
        assert!(!looks_black(&title));
        assert!(!looks_black(&[]));
    }

    #[test]
    fn a_share_is_looked_at_small_and_once_a_second_with_its_preview_or_without() {
        for preview in [true, false] {
            let text = pipeline_text(1, 2, speed(60).expect("60"), 2, (1920, 1080), preview);
            let looks = &text[text.find("queue name=look ").expect("a look")..];
            assert!(looks.contains("framerate=1/1"));
            assert!(looks.contains("width=160,height=90"));
            assert!(looks.contains("format=GRAY8"));
            // It holds nothing up, and keeps at most the newest.
            assert!(
                looks.contains("appsink name=looks sync=false async=false max-buffers=1 drop=true")
            );
        }
    }

    /// The look as it runs, on GStreamer's black test picture and its moving
    /// ball, beside the share and its preview as the app runs them: black,
    /// then not, once a second, and the share's frames going out all the
    /// while. Skipped where this computer's GStreamer lacks the elements.
    #[test]
    fn a_black_window_is_seen_black_and_a_moving_one_isnt() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Mutex;
        use std::time::Duration;
        if gst::init().is_err()
            || !have(&ELEMENTS[1..])
            || !have(&PREVIEW_ELEMENTS)
            || !have(&["videotestsrc"])
        {
            eprintln!("skipped: this GStreamer can't run a share's pipeline");
            return;
        }
        for (pattern, black) in [("black", true), ("ball", false)] {
            let source = format!(
                "videotestsrc is-live=true pattern={pattern} ! video/x-raw,width=640,height=360,framerate=30/1"
            );
            let text = pipeline_from(&source, speed(30).expect("30"), 2, (640, 360), true);
            let seen = Arc::new(Mutex::new(Vec::new()));
            let heard = seen.clone();
            let frames = Arc::new(AtomicUsize::new(0));
            let counted = frames.clone();
            let (pipeline, _sink, _switch) = Capture::run(
                &text,
                (640, 360),
                Outlets {
                    frame: move |_| {
                        counted.fetch_add(1, Ordering::Relaxed);
                    },
                    picture: |_| {},
                    looked: move |looked| {
                        heard
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(looked);
                    },
                    ended: |_| {},
                },
            )
            .expect("the pipeline runs");
            std::thread::sleep(Duration::from_millis(2_500));
            let _ = pipeline.set_state(gst::State::Null);
            let seen = seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            // Once a second: two or three in two and a half, at least one on a busy machine.
            assert!(
                !seen.is_empty() && seen.len() <= 4,
                "{pattern}: looked {} times",
                seen.len()
            );
            assert!(
                seen.iter().all(|&looked| looked == black),
                "{pattern}: {seen:?}"
            );
            let frames = frames.load(Ordering::Relaxed);
            assert!(frames > 20, "{pattern}: the share sent {frames} frames");
        }
    }

    /// The pipeline as it runs, from GStreamer's moving test picture in
    /// place of the portal's stream: the share's frames and the preview's
    /// pictures counted while the preview is hidden, shown, hidden and shown
    /// again. Skipped where this computer's GStreamer lacks the elements.
    #[test]
    fn hiding_the_preview_keeps_the_share_going_and_showing_it_brings_it_back() {
        use std::sync::atomic::AtomicUsize;
        use std::time::Duration;
        if gst::init().is_err()
            || !have(&ELEMENTS[1..])
            || !have(&PREVIEW_ELEMENTS)
            || !have(&["videotestsrc"])
        {
            eprintln!("skipped: this GStreamer can't run a share's pipeline");
            return;
        }
        let source = "videotestsrc is-live=true pattern=ball ! video/x-raw,width=640,height=360,framerate=30/1";
        let text = pipeline_from(source, speed(30).expect("30"), 2, (640, 360), true);
        let frames = Arc::new(AtomicUsize::new(0));
        let pictures = Arc::new(AtomicUsize::new(0));
        let (counted, shown) = (frames.clone(), pictures.clone());
        let (pipeline, _sink, switch) = Capture::run(
            &text,
            (640, 360),
            Outlets {
                frame: move |_| {
                    counted.fetch_add(1, Ordering::Relaxed);
                },
                picture: move |_| {
                    shown.fetch_add(1, Ordering::Relaxed);
                },
                looked: |_| {},
                ended: |_| {},
            },
        )
        .expect("the pipeline runs");
        let switch = switch.expect("a preview");
        // Over a while, how many frames and pictures came: at 30 and 4 a
        // second, 45 and 6 in a second and a half, held to far less so a
        // busy machine still passes.
        let over = |wait: Duration| {
            let before = (
                frames.load(Ordering::Relaxed),
                pictures.load(Ordering::Relaxed),
            );
            std::thread::sleep(wait);
            (
                frames.load(Ordering::Relaxed) - before.0,
                pictures.load(Ordering::Relaxed) - before.1,
            )
        };
        let wait = Duration::from_millis(1_500);
        let hidden = over(wait);
        assert!(
            hidden.0 > 10,
            "the share ran with the preview hidden: {hidden:?}"
        );
        assert_eq!(hidden.1, 0, "a hidden preview made pictures");
        switch.store(true, Ordering::Relaxed);
        let shown = over(wait);
        assert!(shown.0 > 10 && shown.1 >= 2, "shown: {shown:?}");
        switch.store(false, Ordering::Relaxed);
        let _ = over(Duration::from_millis(300));
        let hidden_again = over(wait);
        // A valve here stopped the whole share (2026-10-25).
        assert!(
            hidden_again.0 > 10,
            "the share stopped when the preview was hidden: {hidden_again:?}"
        );
        assert_eq!(hidden_again.1, 0);
        switch.store(true, Ordering::Relaxed);
        let back = over(wait);
        // And opening it again gave one picture, then none.
        assert!(back.0 > 10 && back.1 >= 2, "shown again: {back:?}");
        let _ = pipeline.set_state(gst::State::Null);
    }
}
