//! The microphone and the speakers, through `cpal` (SPEC §4.14, ARCHITECTURE
//! §2, T-1402).
//!
//! This is the file `audio.rs` said would arrive: the two ends of the seam,
//! filled. [`Microphone`] is an `audio::Source` that produces one 20 ms frame
//! at a time from the default input device, and [`Speaker`] is an
//! `audio::Sink` that mixes every peer's frames into the default output
//! device. Nothing else in the voice path knows a device exists.
//!
//! **Two things live here that AGENTS §"Where you will be wrong" names, and
//! both are handled in the smallest way that is not wrong:**
//!
//! - **Sample rate.** Everything past this file is 48 kHz mono. A device that
//!   will not do 48 kHz gets its native rate and a linear resampler at the
//!   edge — good enough for a voice, and confined to one struct so T-1405 can
//!   replace it without touching anything else.
//! - **Hotplug and the default device changing** (T-1405). A device that
//!   disappears kills its stream, and the stream's error callback rings an
//!   alarm the worker thread is waiting on. The worker drops the dead stream
//!   and opens the device again — the *default* device, if that is what was
//!   asked for, which is how "the OS switched to the headphones" becomes
//!   "audio continues on the headphones". It tries every half second for
//!   about twenty seconds and then gives up honestly: the microphone ends its
//!   source (the engine says `stopped`), the speaker goes quiet. Nothing in
//!   here can tell a device that was unplugged from one that went away for
//!   good, so the timeout is the whole of that decision.
//! - **Another device picked in the middle of a call** (#249). The same worker
//!   is told to build its stream again, now, on the device just chosen. The
//!   call never notices: the microphone's frames and the speaker's lanes are
//!   the same objects before and after, only the stream under them changes.
//!
//! **Threads.** A `cpal` stream is driven by a thread the library owns, and
//! the stream handle itself is not something to hand between threads. So each
//! device gets one worker thread of ours that opens the device, starts the
//! stream, and then sleeps until told to stop — dropping the stream on the
//! same thread that built it. The callbacks talk to the rest of the world
//! through channels and one mutex, and never block.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    FromSample, Sample, SampleFormat, SizedSample, SupportedStreamConfig,
    SupportedStreamConfigRange, I24, U24,
};
use tokio::sync::mpsc;

use crate::voice::audio::{Devices, Refused, Sink, Source, CHANNELS, FRAME_SAMPLES, SAMPLE_RATE};

/// Why a device could not be opened, in words the voice surface can show.
#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("no {0} device")]
    NoDevice(&'static str),
    #[error("the {0} device produces {1} samples, which this build cannot read")]
    Format(&'static str, SampleFormat),
    #[error("{0}")]
    Cpal(#[from] cpal::Error),
    #[error("could not start the audio thread: {0}")]
    Thread(#[from] std::io::Error),
    #[error("the audio thread stopped before the device was ready")]
    Gone,
    /// Which of the two would not open, and why (#261). Joining opens both,
    /// and "permission denied" means something different for a microphone.
    #[error("the {0} wouldn't open: {1}")]
    Opening(&'static str, Box<DeviceError>),
}

/// Open the default microphone and the default speakers.
///
/// Both or neither: joining voice with no way to hear anybody is not a
/// conversation, and joining with no microphone is what mute is for.
pub fn open_default() -> Result<Devices, DeviceError> {
    open(None, None)
}

/// Open a microphone and speakers by name, or the defaults for `None`.
///
/// A name that is no longer there — headphones chosen last week and not
/// plugged in today — falls back to the default rather than failing, because
/// the person asked to talk, not to talk through one particular thing. So does
/// one that is listed but won't open (`or_default`). The picker shows what is
/// actually present, so a missing device is visible there; a microphone that
/// is present and won't open is said in the voice bar, with why
/// (`Source::refused`, #398).
pub fn open(input: Option<&str>, output: Option<&str>) -> Result<Devices, DeviceError> {
    let source = Microphone::open(input)
        .map_err(|error| DeviceError::Opening("microphone", Box::new(error)))?;
    let sink =
        Speaker::open(output).map_err(|error| DeviceError::Opening("speakers", Box::new(error)))?;
    Ok(Devices {
        source: Arc::new(source),
        sink: Arc::new(sink),
    })
}

/// What the picker draws (T-1404): every device by name, and which two are
/// the defaults.
///
/// Crosses to the window over Tauri IPC, not the server's wire — so it is
/// serialised here rather than exported from `linger-core`, the same way the
/// stored-session shape is.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

/// Enumerate the sound devices. Blocks briefly, like the opens.
pub fn list() -> Result<DeviceList, DeviceError> {
    let host = cpal::default_host();
    Ok(DeviceList {
        inputs: names(host.input_devices()?),
        outputs: names(host.output_devices()?),
        default_input: host.default_input_device().and_then(|d| name_of(&d)),
        default_output: host.default_output_device().and_then(|d| name_of(&d)),
    })
}

/// A device's name, which is what the picker shows and what a preference
/// remembers. A device that will not say its name is left out rather than
/// shown as a blank.
fn name_of(device: &cpal::Device) -> Option<String> {
    device
        .description()
        .ok()
        .map(|description| description.name().to_owned())
}

fn names(devices: impl Iterator<Item = cpal::Device>) -> Vec<String> {
    devices.filter_map(|device| name_of(&device)).collect()
}

/// The named device from a list, or the default when there is no name or
/// the name is not there any more.
fn find(
    wanted: Option<&str>,
    devices: impl Iterator<Item = cpal::Device>,
    default: Option<cpal::Device>,
    kind: &'static str,
) -> Result<cpal::Device, DeviceError> {
    if let Some(name) = wanted {
        for device in devices {
            if name_of(&device).as_deref() == Some(name) {
                return Ok(device);
            }
        }
    }
    default.ok_or(DeviceError::NoDevice(kind))
}

/// The frames a microphone produces, and a way to stop it.
pub struct Microphone {
    frames: tokio::sync::Mutex<mpsc::Receiver<Vec<i16>>>,
    /// The device asked for by name, or `None` for the default. Read on every
    /// build, so changing it and waking the worker is a switch (#249).
    wanted: Arc<Mutex<Option<String>>>,
    /// The device asked for when it wouldn't open and the default is in its
    /// place (#398). Set on every build, so a later build clears it.
    refused: Arc<Mutex<Option<Refused>>>,
    worker: Worker,
}

impl Microphone {
    /// Open an input device by name, or the default for `None`.
    ///
    /// Blocks while the device is opened, which on some hosts is tens of
    /// milliseconds — call it from a blocking task, not from the reactor.
    pub fn open(name: Option<&str>) -> Result<Self, DeviceError> {
        let wanted = Arc::new(Mutex::new(name.map(str::to_owned)));
        let chosen = Arc::clone(&wanted);
        let refused = Arc::new(Mutex::new(None));
        let noted = Arc::clone(&refused);
        // Sixteen frames is a third of a second. The callback drops frames if
        // the engine falls further behind than that, because a queue that
        // grows is latency nobody asked for.
        let (tx, rx) = mpsc::channel::<Vec<i16>>(16);
        let sentinel = tx.clone();
        let worker = Worker::start(
            move |alarm: &Alarm| {
                let host = cpal::default_host();
                let name = lock(&chosen).clone();
                let device = find(
                    name.as_deref(),
                    host.input_devices()?,
                    host.default_input_device(),
                    "input",
                )?;
                let (stream, why) = or_default(
                    name.as_deref(),
                    &device,
                    || host.default_input_device(),
                    "microphone",
                    |device| input_stream(device, &tx, alarm),
                )?;
                *lock(&noted) = name.zip(why).map(|(name, why)| Refused { name, why });
                Ok((stream, ()))
            },
            // Given up: an empty frame is the sentinel `frame()` reads as "the
            // device is gone". `blocking_send` is fine on the worker thread.
            move || {
                let _ = sentinel.blocking_send(Vec::new());
            },
            Retry::default(),
        )?;
        Ok(Self {
            frames: tokio::sync::Mutex::new(rx),
            wanted,
            refused,
            worker,
        })
    }
}

#[async_trait]
impl Source for Microphone {
    async fn frame(&self) -> Option<Vec<i16>> {
        let frame = self.frames.lock().await.recv().await?;
        // The sentinel the worker sends when it has given up reopening the
        // device: this source is over. Returning `None` is what ends the
        // engine's sending loop and lights `stopped` on the surface. While the
        // worker is still trying, frames simply pause — there is no sentinel
        // and no `None`, and the first frame from the new device resumes the
        // call where it was.
        if frame.is_empty() {
            return None;
        }
        Some(frame)
    }

    fn choose(&self, name: Option<&str>) {
        if choose(&self.wanted, name) {
            self.worker.switch();
        }
    }

    fn refused(&self) -> Option<Refused> {
        lock(&self.refused).clone()
    }
}

/// A stream from an input device, turning what it delivers into frames.
fn input_stream(
    device: &cpal::Device,
    tx: &mpsc::Sender<Vec<i16>>,
    alarm: &Alarm,
) -> Result<cpal::Stream, DeviceError> {
    opened(
        preferred(device.supported_input_configs()?),
        || Ok(device.default_input_config()?),
        |config| open_input(device, config, tx, alarm),
    )
}

/// A stream from a microphone, in one format it offered.
fn open_input(
    device: &cpal::Device,
    config: SupportedStreamConfig,
    tx: &mpsc::Sender<Vec<i16>>,
    alarm: &Alarm,
) -> Result<cpal::Stream, DeviceError> {
    let mut framer = Framer::new(config.channels(), config.sample_rate(), tx.clone());
    let config_format = config.sample_format();
    let alarm = alarm.clone();
    let died = move |error: cpal::Error| {
        eprintln!("voice: microphone: {error}");
        alarm.ring();
    };
    let config = config.config();
    Ok(match config_format {
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| framer.push(data.iter().copied()),
            died,
            None,
        )?,
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| framer.push(data.iter().map(|s| from_f32(*s))),
            died,
            None,
        )?,
        // Any other format is converted on the way in (#261): a microphone on
        // Windows can offer 24- or 32-bit samples and nothing else.
        SampleFormat::I8 => input_as::<i8>(device, config, framer, died)?,
        SampleFormat::I24 => input_as::<I24>(device, config, framer, died)?,
        SampleFormat::I32 => input_as::<i32>(device, config, framer, died)?,
        SampleFormat::I64 => input_as::<i64>(device, config, framer, died)?,
        SampleFormat::U8 => input_as::<u8>(device, config, framer, died)?,
        SampleFormat::U16 => input_as::<u16>(device, config, framer, died)?,
        SampleFormat::U24 => input_as::<U24>(device, config, framer, died)?,
        SampleFormat::U32 => input_as::<u32>(device, config, framer, died)?,
        SampleFormat::U64 => input_as::<u64>(device, config, framer, died)?,
        SampleFormat::F64 => input_as::<f64>(device, config, framer, died)?,
        other => return Err(DeviceError::Format("input", other)),
    })
}

/// An input stream in a sample format other than the two the path speaks,
/// each sample converted to 16 bits as it arrives.
fn input_as<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut framer: Framer,
    died: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, DeviceError>
where
    T: SizedSample,
    i16: FromSample<T>,
{
    Ok(device.build_input_stream(
        config,
        move |data: &[T], _| framer.push(data.iter().map(|s| i16::from_sample(*s))),
        died,
        None,
    )?)
}

/// An output stream in a sample format other than the two the path speaks.
fn output_as<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    (lanes, cues, deafened): Playback,
    channels: usize,
    died: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, DeviceError>
where
    T: SizedSample + FromSample<i16>,
{
    Ok(device.build_output_stream(
        config,
        move |out: &mut [T], _| mix(&lanes, &cues, &deafened, channels, out, T::from_sample),
        died,
        None,
    )?)
}

/// Build on the device found for `name`; if that was a device picked by name
/// and it won't open, build on the default instead, and hand back why it
/// wouldn't, to be said where the person can see it (#398).
///
/// A device can be listed and still refuse: busy, held by another program, or
/// a sound card output nothing is plugged into (seen on a real machine: ALSA
/// "unable to open slave"). Retrying it would go on for twenty seconds and
/// then leave the call silent; the default is what Linger promises for a
/// device that isn't there (#249). Quietly, though, the default looks like the
/// picked microphone not hearing you: a Windows headset whose system default
/// was a silent virtual microphone did exactly that (#398).
fn or_default<D, T>(
    name: Option<&str>,
    device: &D,
    default: impl FnOnce() -> Option<D>,
    what: &str,
    build: impl Fn(&D) -> Result<T, DeviceError>,
) -> Result<(T, Option<String>), DeviceError> {
    match build(device) {
        Err(error) if name.is_some() => {
            eprintln!("voice: {what}: {name:?} would not open ({error}); using the default");
            match default() {
                Some(fallback) => build(&fallback).map(|built| (built, Some(error.to_string()))),
                None => Err(error),
            }
        }
        built => built.map(|built| (built, None)),
    }
}

/// Remember the device asked for. True when it is a different one, and the
/// stream has to be built again for it.
fn choose(wanted: &Mutex<Option<String>>, name: Option<&str>) -> bool {
    let mut wanted = lock(wanted);
    if wanted.as_deref() == name {
        return false;
    }
    *wanted = name.map(str::to_owned);
    true
}

/// Mixes every peer into the default output device, and Linger's own sounds
/// on top (#250).
pub struct Speaker {
    lanes: Arc<Mutex<HashMap<String, Lane>>>,
    /// Linger's own sounds (#250), at the device's rate, waiting to be played
    /// over whatever else is. Sounds that overlap are summed into it, so a
    /// knock during a chime is both, not one after the other.
    cues: Cues,
    deafened: Arc<AtomicBool>,
    /// The device's rate. Frames arrive at `SAMPLE_RATE` and are resampled on
    /// the way into a lane if this differs, so the callback only ever copies.
    /// Atomic because the device can change under us (T-1405) and come back
    /// at another rate; the worker rewrites it, and the lanes, on reopen.
    rate: Arc<AtomicU32>,
    /// The device asked for by name, or `None` for the default (#249). See
    /// [`Microphone`].
    wanted: Arc<Mutex<Option<String>>>,
    worker: Worker,
}

/// Linger's own sounds, queued at the device's rate as wider samples, so
/// that summing overlapping ones can't wrap before the clamp in `mix`.
type Cues = Arc<Mutex<VecDeque<i32>>>;

/// What an output stream's callback mixes: the lanes, the sounds and the deafen gate.
type Playback = (Arc<Mutex<HashMap<String, Lane>>>, Cues, Arc<AtomicBool>);

/// The longest run of sounds held at once: a cue is well under a second, so
/// anything past this is sounds piling up faster than they play.
const MAX_CUE_MS: u32 = 4_000;

/// One peer's audio, waiting to be played.
struct Lane {
    queue: VecDeque<i16>,
    resampler: Option<Linear>,
    /// Your volume for them. Applied on the way in, so the callback only
    /// ever sums.
    gain: f32,
}

impl Lane {
    fn new(rate: u32) -> Self {
        Self {
            queue: VecDeque::new(),
            resampler: (rate != SAMPLE_RATE).then(|| Linear::new(SAMPLE_RATE, rate)),
            gain: 1.0,
        }
    }

    /// The device changed: what was queued was for the old one, at the old
    /// rate. Your volume for this person is not about the device, so it stays.
    fn retune(&mut self, rate: u32) {
        self.queue.clear();
        self.resampler = (rate != SAMPLE_RATE).then(|| Linear::new(SAMPLE_RATE, rate));
    }
}

impl Speaker {
    /// Open an output device by name, or the default for `None`. Blocks like
    /// [`Microphone::open`].
    pub fn open(name: Option<&str>) -> Result<Self, DeviceError> {
        let wanted = Arc::new(Mutex::new(name.map(str::to_owned)));
        let chosen = Arc::clone(&wanted);
        let lanes: Arc<Mutex<HashMap<String, Lane>>> = Arc::new(Mutex::new(HashMap::new()));
        let cues: Cues = Arc::default();
        let rate = Arc::new(AtomicU32::new(SAMPLE_RATE));
        let deafened = Arc::new(AtomicBool::new(false));
        let shared_deafened = Arc::clone(&deafened);
        let shared = Arc::clone(&lanes);
        let shared_cues = Arc::clone(&cues);
        let shared_rate = Arc::clone(&rate);
        let worker = Worker::start(
            move |alarm: &Alarm| {
                let host = cpal::default_host();
                let name = lock(&chosen).clone();
                let device = find(
                    name.as_deref(),
                    host.output_devices()?,
                    host.default_output_device(),
                    "output",
                )?;
                let (stream, _) = or_default(
                    name.as_deref(),
                    &device,
                    || host.default_output_device(),
                    "speaker",
                    |device| {
                        output_stream(
                            device,
                            &shared,
                            &shared_cues,
                            &shared_deafened,
                            &shared_rate,
                            alarm,
                        )
                    },
                )?;
                Ok((stream, ()))
            },
            // Given up: nothing plays, and the lanes fill to their ceiling and
            // then drop. There is no sink-side sentinel — the call continues
            // in silence, which is what a room with no speakers is.
            || eprintln!("voice: speaker: the output device did not come back"),
            Retry::default(),
        )?;
        Ok(Self {
            lanes,
            cues,
            deafened,
            rate,
            wanted,
            worker,
        })
    }

    /// Play one of Linger's own sounds (#250): mono samples at `SAMPLE_RATE`,
    /// mixed over whatever is playing. Deafen doesn't hold it back: the
    /// deafen sound is one of them, and it is the answer to pressing Deafen.
    pub fn cue(&self, samples: &[i16]) {
        let rate = self.rate.load(Ordering::Relaxed);
        if rate == SAMPLE_RATE {
            overlay(&self.cues, samples, rate);
        } else {
            let mut resampled =
                Vec::with_capacity(samples.len() * rate as usize / SAMPLE_RATE as usize + 2);
            Linear::new(SAMPLE_RATE, rate).push(samples, &mut resampled);
            overlay(&self.cues, &resampled, rate);
        }
    }
}

/// Lay a sound over the queue from its front: summed with what is already
/// there, and longer than it where it runs past the end.
fn overlay(cues: &Mutex<VecDeque<i32>>, samples: &[i16], rate: u32) {
    let cap = (rate / 1000 * MAX_CUE_MS) as usize;
    let mut bed = lock(cues);
    for (at, sample) in samples.iter().take(cap).enumerate() {
        match bed.get_mut(at) {
            Some(held) => *held += i32::from(*sample),
            None => bed.push_back(i32::from(*sample)),
        }
    }
}

/// A stream to an output device, mixing every lane and every sound into it.
fn output_stream(
    device: &cpal::Device,
    lanes: &Arc<Mutex<HashMap<String, Lane>>>,
    cues: &Cues,
    deafened: &Arc<AtomicBool>,
    rate: &AtomicU32,
    alarm: &Alarm,
) -> Result<cpal::Stream, DeviceError> {
    opened(
        preferred(device.supported_output_configs()?),
        || Ok(device.default_output_config()?),
        |config| open_output(device, config, lanes, cues, deafened, rate, alarm),
    )
}

/// A stream to an output device in one format it offered.
fn open_output(
    device: &cpal::Device,
    config: SupportedStreamConfig,
    lanes: &Arc<Mutex<HashMap<String, Lane>>>,
    cues: &Cues,
    deafened: &Arc<AtomicBool>,
    rate: &AtomicU32,
    alarm: &Alarm,
) -> Result<cpal::Stream, DeviceError> {
    let channels = usize::from(config.channels());
    let device_rate = config.sample_rate();
    // Whatever was queued was for the device that just went; the new one may
    // run at another rate. Retune every lane before a single callback fires on
    // it.
    for lane in lock(lanes).values_mut() {
        lane.retune(device_rate);
    }
    // A sound half played on the old device was at its rate; let it go.
    lock(cues).clear();
    rate.store(device_rate, Ordering::Relaxed);
    let alarm = alarm.clone();
    let died = move |error: cpal::Error| {
        eprintln!("voice: speaker: {error}");
        alarm.ring();
    };
    let (lanes, cues, deafened) = (Arc::clone(lanes), Arc::clone(cues), Arc::clone(deafened));
    let format = config.sample_format();
    let config = config.config();
    Ok(match format {
        SampleFormat::I16 => device.build_output_stream(
            config,
            move |out: &mut [i16], _| mix(&lanes, &cues, &deafened, channels, out, |s| s),
            died,
            None,
        )?,
        SampleFormat::F32 => device.build_output_stream(
            config,
            move |out: &mut [f32], _| mix(&lanes, &cues, &deafened, channels, out, to_f32),
            died,
            None,
        )?,
        // Converted on the way out, as the microphone's are on the way in (#261).
        SampleFormat::I8 => {
            output_as::<i8>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::I24 => {
            output_as::<I24>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::I32 => {
            output_as::<i32>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::I64 => {
            output_as::<i64>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::U8 => {
            output_as::<u8>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::U16 => {
            output_as::<u16>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::U24 => {
            output_as::<U24>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::U32 => {
            output_as::<u32>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::U64 => {
            output_as::<u64>(device, config, (lanes, cues, deafened), channels, died)?
        }
        SampleFormat::F64 => {
            output_as::<f64>(device, config, (lanes, cues, deafened), channels, died)?
        }
        other => return Err(DeviceError::Format("output", other)),
    })
}

/// How far behind playback is allowed to fall before old audio is thrown
/// away: 200 ms. Past that, a queue is not absorbing jitter, it is adding
/// delay to every word from here on.
const MAX_QUEUED_MS: u32 = 200;

#[async_trait]
impl Sink for Speaker {
    async fn play(&self, peer: &str, samples: &[i16]) {
        let rate = self.rate.load(Ordering::Relaxed);
        let cap = (rate / 1000 * MAX_QUEUED_MS) as usize;
        let mut lanes = lock(&self.lanes);
        if self.deafened.load(Ordering::Relaxed) {
            return;
        }
        let lane = lanes
            .entry(peer.to_string())
            .or_insert_with(|| Lane::new(rate));
        let scaled;
        let samples = if (lane.gain - 1.0).abs() < f32::EPSILON {
            samples
        } else {
            scaled = scale(samples, lane.gain);
            &scaled
        };
        match lane.resampler.as_mut() {
            Some(resampler) => {
                let mut out = Vec::with_capacity(samples.len());
                resampler.push(samples, &mut out);
                lane.queue.extend(out);
            }
            None => lane.queue.extend(samples),
        }
        while lane.queue.len() > cap {
            lane.queue.pop_front();
        }
    }

    async fn forget(&self, peer: &str) {
        lock(&self.lanes).remove(peer);
    }

    async fn set_deafened(&self, deafened: bool) {
        set_playback_deafened(
            &self.lanes,
            &self.deafened,
            deafened,
            self.rate.load(Ordering::Relaxed),
        );
    }

    async fn set_volume(&self, peer: &str, volume: f32) {
        // The lane is made if it is not there yet, so a volume set before the
        // first frame arrives is not lost.
        lock(&self.lanes)
            .entry(peer.to_string())
            .or_insert_with(|| Lane::new(self.rate.load(Ordering::Relaxed)))
            .gain = volume.clamp(0.0, MAX_GAIN);
    }

    fn choose(&self, name: Option<&str>) {
        if choose(&self.wanted, name) {
            self.worker.switch();
        }
    }

    fn cue(&self, samples: &[i16]) -> bool {
        Speaker::cue(self, samples);
        true
    }
}

/// Twice as loud as sent is as far as the control goes. Past that a quiet
/// microphone becomes a loud hiss, and a clamp on every sample is doing the
/// work a limiter should.
pub const MAX_GAIN: f32 = 2.0;

/// Multiply a frame by a gain, clamped to the sample range.
fn scale(samples: &[i16], gain: f32) -> Vec<i16> {
    samples
        .iter()
        .map(|s| {
            #[allow(clippy::cast_possible_truncation)]
            let v = (f32::from(*s) * gain).clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16;
            v
        })
        .collect()
}

/// The output callback: one sample from every lane and from Linger's own
/// sounds, summed, into every channel of the device. A lane with nothing
/// queued contributes silence, which is what a pause between words is.
/// Deafened, the voices are silent and the sounds still play (#250).
fn mix<T: Copy>(
    lanes: &Mutex<HashMap<String, Lane>>,
    cues: &Mutex<VecDeque<i32>>,
    deafened: &AtomicBool,
    channels: usize,
    out: &mut [T],
    convert: impl Fn(i16) -> T,
) {
    let mut lanes = lock(lanes);
    let mut cues = lock(cues);
    let voices = !deafened.load(Ordering::Relaxed);
    for frame in out.chunks_mut(channels.max(1)) {
        let mut acc: i32 = cues.pop_front().unwrap_or(0);
        if voices {
            for lane in lanes.values_mut() {
                if let Some(sample) = lane.queue.pop_front() {
                    acc += i32::from(sample);
                }
            }
        }
        #[allow(clippy::cast_possible_truncation)]
        let sample = acc.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        for slot in frame {
            *slot = convert(sample);
        }
    }
}

fn set_playback_deafened(
    lanes: &Mutex<HashMap<String, Lane>>,
    gate: &AtomicBool,
    deafened: bool,
    rate: u32,
) {
    let mut lanes = lock(lanes);
    if gate.swap(deafened, Ordering::Relaxed) != deafened {
        for lane in lanes.values_mut() {
            lane.retune(rate);
        }
    }
}

/// A mutex that survives a panic on the other side. Audio callbacks must not
/// be the thing that stops the app.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Open a device in the format `pick` preferred and, when it won't open that
/// one, in its own default. A device can list a format it then refuses: a
/// friend's Logitech PRO X 2 headset on Windows answered "The parameter is
/// incorrect" (os error -2147024809) to what Linger chose, so he couldn't
/// join voice at all (2026-10-03, #398; `plain_beyond_stereo` is the likely
/// reason). A device's default is the format Windows mixes in, which always
/// opens; its rate and channels the path already converts. Nothing
/// preferred: the default. Both refused: the first refusal, which is what was
/// asked for.
fn opened<C, S, E>(
    preferred: Option<C>,
    default: impl FnOnce() -> Result<C, E>,
    mut open: impl FnMut(C) -> Result<S, E>,
) -> Result<S, E> {
    let Some(config) = preferred else {
        return open(default()?);
    };
    match open(config) {
        Ok(stream) => Ok(stream),
        Err(refused) => match default() {
            Ok(fallback) => open(fallback).map_err(|_| refused),
            Err(_) => Err(refused),
        },
    }
}

/// The format to try first, before the device's own default (`opened`).
///
/// On Windows that's the device's own: none of ours. Windows mixes every
/// device in one format, opens that one for anybody, and is asked for any
/// other only through a conversion a driver may get wrong. Two friends'
/// headsets did (2026-10-03, #398): a Logitech PRO X 2 refused the 16-bit
/// format outright, and a SteelSeries Arctis Nova 5's microphone opened in it
/// and stayed silent, where Discord, which takes the device's own, heard it.
/// The path converts whatever rate, channels and samples the device has.
/// Elsewhere, 48 kHz, mono and 16-bit where offered, as `pick` chooses.
fn preferred(
    ranges: impl Iterator<Item = SupportedStreamConfigRange>,
) -> Option<SupportedStreamConfig> {
    if cfg!(windows) {
        drop(ranges);
        None
    } else {
        pick(ranges)
    }
}

/// Prefer 48 kHz, prefer mono, and take any sample format the callbacks can
/// read or convert. `None` means the device offers no 48 kHz at all and the
/// caller should take the default and resample.
fn pick(ranges: impl Iterator<Item = SupportedStreamConfigRange>) -> Option<SupportedStreamConfig> {
    let mut best: Option<SupportedStreamConfig> = None;
    for range in ranges {
        if format_rank(range.sample_format()).is_none() || plain_beyond_stereo(&range) {
            continue;
        }
        let Some(config) = range.try_with_sample_rate(SAMPLE_RATE) else {
            continue;
        };
        if best.as_ref().is_none_or(|held| rank(&config) < rank(held)) {
            best = Some(config);
        }
    }
    best
}

/// 16- and 8-bit samples on more than two channels, which Windows can't be
/// asked for. cpal describes those formats to Windows the old, plain way
/// (`WAVE_FORMAT_PCM`), which only ever meant mono or stereo, and a device
/// that mixes in more, like a headset set to 7.1 surround, answers "The
/// parameter is incorrect" (os error -2147024809, #398). Windows lists such a
/// device's channels and nothing fewer, so its float formats are taken
/// instead, which cpal describes the newer way.
fn plain_beyond_stereo(range: &SupportedStreamConfigRange) -> bool {
    range.channels() > 2 && matches!(range.sample_format(), SampleFormat::I16 | SampleFormat::U8)
}

/// Lower is better: fewest channels beyond one, then i16 over f32 because it
/// is what the rest of the path speaks, then anything else converted.
fn rank(config: &SupportedStreamConfig) -> (u16, u8) {
    let channels = config.channels().saturating_sub(CHANNELS);
    let format = format_rank(config.sample_format()).unwrap_or(u8::MAX);
    (channels, format)
}

/// How much work a sample format is: none for 16-bit, a scale for float, a
/// conversion for the rest. `None` for what can't be read at all (DSD).
fn format_rank(format: SampleFormat) -> Option<u8> {
    match format {
        SampleFormat::I16 => Some(0),
        SampleFormat::F32 => Some(1),
        SampleFormat::I8
        | SampleFormat::I24
        | SampleFormat::I32
        | SampleFormat::I64
        | SampleFormat::U8
        | SampleFormat::U16
        | SampleFormat::U24
        | SampleFormat::U32
        | SampleFormat::U64
        | SampleFormat::F64 => Some(2),
        _ => None,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn from_f32(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
}

fn to_f32(sample: i16) -> f32 {
    f32::from(sample) / -f32::from(i16::MIN)
}

/// Turns whatever the device delivers into frames of mono at `SAMPLE_RATE`.
struct Framer {
    channels: usize,
    resampler: Option<Linear>,
    pending: Vec<i16>,
    tx: mpsc::Sender<Vec<i16>>,
}

impl Framer {
    fn new(channels: u16, rate: u32, tx: mpsc::Sender<Vec<i16>>) -> Self {
        Self {
            channels: usize::from(channels).max(1),
            resampler: (rate != SAMPLE_RATE).then(|| Linear::new(rate, SAMPLE_RATE)),
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
            tx,
        }
    }

    /// Interleaved samples in; whole frames out, as many as are ready.
    fn push(&mut self, samples: impl Iterator<Item = i16>) {
        let mono = downmix(samples, self.channels);
        match self.resampler.as_mut() {
            Some(resampler) => resampler.push(&mono, &mut self.pending),
            None => self.pending.extend(mono),
        }
        while self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(..FRAME_SAMPLES).collect();
            // Dropped rather than queued if the engine is behind — see the
            // channel size in `Microphone::open`.
            let _ = self.tx.try_send(frame);
        }
    }
}

/// Average the channels of each interleaved frame into one sample.
fn downmix(samples: impl Iterator<Item = i16>, channels: usize) -> Vec<i16> {
    let mut out = Vec::new();
    let mut acc: i32 = 0;
    let mut n = 0;
    for sample in samples {
        acc += i32::from(sample);
        n += 1;
        if n == channels {
            #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
            out.push((acc / channels as i32) as i16);
            acc = 0;
            n = 0;
        }
    }
    out
}

/// Linear interpolation between two rates.
///
/// The simplest resampler that is not wrong for a voice: it aliases a little
/// above what anybody says, and it costs one multiply per sample. It keeps
/// its place across calls, so frames of any length go in and nothing is
/// dropped at the boundaries.
struct Linear {
    /// Input samples per output sample.
    step: f64,
    /// Where the next output sample falls, in input samples, measured from
    /// the sample before this call's input (`last`).
    pos: f64,
    last: i16,
}

impl Linear {
    fn new(from: u32, to: u32) -> Self {
        Self {
            step: f64::from(from) / f64::from(to),
            pos: 0.0,
            last: 0,
        }
    }

    fn push(&mut self, input: &[i16], out: &mut Vec<i16>) {
        let Some(newest) = input.last() else { return };
        // Position 0 is the sample carried from the previous call, position k
        // is `input[k - 1]`; output lands between two of those.
        let at = |k: usize| {
            if k == 0 {
                f64::from(self.last)
            } else {
                f64::from(input[k - 1])
            }
        };
        let end = input.len() as f64;
        let mut pos = self.pos;
        while pos < end {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let k = pos as usize;
            let frac = pos - k as f64;
            let a = at(k);
            let b = at(k + 1);
            #[allow(clippy::cast_possible_truncation)]
            out.push((a + (b - a) * frac).round() as i16);
            pos += self.step;
        }
        self.pos = pos - end;
        self.last = *newest;
    }
}

/// Something a worker can start and hold: a `cpal` stream, or a stand-in in
/// the tests. `Send` because it is built and dropped on the worker's thread
/// but the closure that builds it is handed across from the caller's.
pub(crate) trait Playing: Send {
    fn play(&self) -> Result<(), cpal::Error>;
}

impl Playing for cpal::Stream {
    fn play(&self) -> Result<(), cpal::Error> {
        StreamTrait::play(self)
    }
}

/// What wakes a worker: its stream died, another device was chosen, or its
/// owner is done with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Wake {
    // In order of what matters most when several are waiting: see `strongest`.
    Died,
    Switch,
    Stop,
}

/// The stream's way of telling the worker it is dead. Cloned into each
/// stream's error callback; ringing it from anywhere is fine, and ringing it
/// twice for one death is harmless because the worker drains extras.
#[derive(Clone)]
pub(crate) struct Alarm(std::sync::mpsc::Sender<Wake>);

impl Alarm {
    pub(crate) fn ring(&self) {
        let _ = self.0.send(Wake::Died);
    }
}

/// How hard a worker tries to get a device back before giving up.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Retry {
    /// Between attempts, and after a death before the first one.
    pub pause: Duration,
    /// Failed reopenings tolerated in a row before giving up.
    pub attempts: u32,
}

impl Default for Retry {
    /// Half a second between tries, forty tries: about twenty seconds. Long
    /// enough to swap headphones; short enough that a room does not spend a
    /// minute wondering whether you can hear.
    fn default() -> Self {
        Self {
            pause: Duration::from_millis(500),
            attempts: 40,
        }
    }
}

/// A thread that owns one `cpal` stream for as long as the device is wanted,
/// and gets it back when it dies (T-1405).
///
/// Not joined on drop, on purpose. The last handle to a device can be let go
/// of from anywhere — a cancelled task on the runtime, a track reader ending
/// — and waiting for a sound card to close from inside the reactor is the
/// kind of stall AGENTS says never to build. The thread hears the stop,
/// closes the stream, and ends on its own.
struct Worker<T = ()> {
    #[allow(dead_code)]
    info: T,
    stop: Option<std::sync::mpsc::Sender<Wake>>,
}

impl<T: Send + 'static> Worker<T> {
    /// Run `build` on a fresh thread, start the stream it returns, and hold
    /// it until it dies or this worker is dropped. Returns once the first
    /// stream is playing, or with the first attempt's error — the caller asked
    /// to open a device *now*, and a device that is not there now is an answer.
    ///
    /// After that, a death is followed by another `build`, and another, on
    /// `retry`'s schedule; `abandon` is called once if they all fail.
    fn start<S, B, A>(build: B, abandon: A, retry: Retry) -> Result<Self, DeviceError>
    where
        S: Playing + 'static,
        B: FnMut(&Alarm) -> Result<(S, T), DeviceError> + Send + 'static,
        A: FnOnce() + Send + 'static,
    {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<T, DeviceError>>();
        let (wake_tx, wake_rx) = std::sync::mpsc::channel::<Wake>();
        let alarm = Alarm(wake_tx.clone());
        std::thread::Builder::new()
            .name("linger-audio".into())
            .spawn(move || supervise(build, abandon, retry, alarm, wake_rx, ready_tx))?;
        let info = ready_rx.recv().map_err(|_| DeviceError::Gone)??;
        Ok(Self {
            info,
            stop: Some(wake_tx),
        })
    }
}

impl<T> Worker<T> {
    /// Build the stream again now, on whatever device is wanted now (#249).
    /// Nothing waits for it: the worker does it on its own thread, and a
    /// device that won't open goes on the same retry schedule as a death.
    fn switch(&self) {
        if let Some(wake) = &self.stop {
            let _ = wake.send(Wake::Switch);
        }
    }
}

impl<T> Drop for Worker<T> {
    fn drop(&mut self) {
        // Said explicitly rather than by dropping the sender: the alarm clones
        // inside the stream callbacks hold senders too, so the channel would
        // not close on its own.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(Wake::Stop);
        }
    }
}

/// The worker thread's whole life: build, play, wait; rebuild on a death,
/// give up after enough failures in a row, leave when told.
///
/// Pure with respect to devices — it only ever calls `build` — so the tests
/// drive it with a stand-in stream and a fake alarm and prove the schedule.
fn supervise<S, T, B, A>(
    mut build: B,
    abandon: A,
    retry: Retry,
    alarm: Alarm,
    wake: std::sync::mpsc::Receiver<Wake>,
    ready: std::sync::mpsc::Sender<Result<T, DeviceError>>,
) where
    S: Playing,
    B: FnMut(&Alarm) -> Result<(S, T), DeviceError>,
    A: FnOnce(),
{
    let mut ready = Some(ready);
    let mut failures: u32 = 0;
    loop {
        let built = build(&alarm).and_then(|(stream, info)| {
            stream.play()?;
            Ok((stream, info))
        });
        match built {
            Ok((stream, info)) => {
                failures = 0;
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(info));
                }
                // Hold the stream until something happens to it or to us.
                let Ok(woke) = wake.recv() else { return };
                drop(stream);
                match strongest(&wake, woke) {
                    Wake::Died => {
                        if wait_or_stop(&wake, retry.pause, &mut failures) {
                            return;
                        }
                    }
                    // Another device: build it straight away (#249).
                    Wake::Switch => {}
                    Wake::Stop => return,
                }
            }
            Err(error) => {
                // The very first open failing is the caller's answer, not
                // something to retry behind their back.
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err(error));
                    return;
                }
                failures += 1;
                if failures >= retry.attempts {
                    eprintln!("voice: device did not come back after {failures} tries: {error}");
                    abandon();
                    return;
                }
                if wait_or_stop(&wake, retry.pause, &mut failures) {
                    return;
                }
            }
        }
    }
}

/// Everything already waiting, boiled down to the one that matters: a stop
/// over a switch, a switch over a death. One death can ring more than once,
/// and a stop or a switch must never be lost behind the extra rings.
fn strongest(wake: &std::sync::mpsc::Receiver<Wake>, first: Wake) -> Wake {
    let mut strongest = first;
    while let Ok(next) = wake.try_recv() {
        strongest = strongest.max(next);
    }
    strongest
}

/// Sleep for `pause`, unless something arrives first. True means stop. A
/// switch cuts the wait short and starts the count of failures again, since
/// the device being tried is a new one.
fn wait_or_stop(
    wake: &std::sync::mpsc::Receiver<Wake>,
    pause: Duration,
    failures: &mut u32,
) -> bool {
    let woke = match wake.recv_timeout(pause) {
        Ok(woke) => strongest(wake, woke),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return false,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return true,
    };
    match woke {
        Wake::Stop => true,
        Wake::Switch => {
            *failures = 0;
            false
        }
        Wake::Died => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(channels: u16, format: SampleFormat) -> SupportedStreamConfigRange {
        SupportedStreamConfigRange::new(
            channels,
            48_000,
            48_000,
            cpal::SupportedBufferSize::Unknown,
            format,
        )
    }

    #[test]
    fn stereo_takes_sixteen_bit_samples_and_surround_never_does() {
        // A stereo headset: 16-bit, as the rest of the path speaks.
        let stereo = pick([range(2, SampleFormat::F32), range(2, SampleFormat::I16)].into_iter());
        assert_eq!(
            stereo.map(|c| (c.channels(), c.sample_format())),
            Some((2, SampleFormat::I16))
        );
        // The same headset set to 7.1 (#398): Windows lists eight channels in
        // every format, and only float can be asked for.
        let surround = pick(
            [
                range(8, SampleFormat::I16),
                range(8, SampleFormat::U8),
                range(8, SampleFormat::F32),
                range(8, SampleFormat::I32),
            ]
            .into_iter(),
        );
        assert_eq!(
            surround.map(|c| (c.channels(), c.sample_format())),
            Some((8, SampleFormat::F32))
        );
    }

    #[test]
    fn windows_opens_a_device_in_its_own_format_and_elsewhere_we_choose() {
        let listed = [range(2, SampleFormat::F32), range(2, SampleFormat::I16)];
        let chosen = preferred(listed.into_iter()).map(|config| config.sample_format());
        if cfg!(windows) {
            // Nothing of ours: `opened` goes straight to the device's own (#398).
            assert_eq!(chosen, None);
        } else {
            assert_eq!(chosen, Some(SampleFormat::I16));
        }
    }

    #[test]
    fn a_device_that_opens_what_it_listed_is_opened_that_way() {
        let mut tried = Vec::new();
        let got: Result<&str, &str> = opened(
            Some("mono"),
            || panic!("the default isn't asked for"),
            |config| {
                tried.push(config);
                Ok(config)
            },
        );
        assert_eq!(got, Ok("mono"));
        assert_eq!(tried, ["mono"]);
    }

    #[test]
    fn a_device_that_refuses_what_it_listed_opens_in_its_own_default() {
        let mut tried = Vec::new();
        let got: Result<&str, &str> = opened(
            Some("mono"),
            || Ok("its mix format"),
            |config| {
                tried.push(config);
                if config == "mono" {
                    Err("The parameter is incorrect.")
                } else {
                    Ok(config)
                }
            },
        );
        assert_eq!(got, Ok("its mix format"));
        assert_eq!(tried, ["mono", "its mix format"]);
    }

    #[test]
    fn refused_both_ways_it_says_why_the_first_one_failed() {
        let got: Result<&str, &str> = opened(
            Some("mono"),
            || Ok("default"),
            |config| {
                Err(if config == "mono" {
                    "refused mono"
                } else {
                    "refused default"
                })
            },
        );
        assert_eq!(got, Err("refused mono"));
        let got: Result<&str, &str> =
            opened(Some("mono"), || Err("no default"), |_| Err("refused mono"));
        assert_eq!(got, Err("refused mono"));
    }

    #[test]
    fn a_device_with_nothing_preferred_opens_in_its_default() {
        let got: Result<&str, &str> = opened(None, || Ok("default"), Ok);
        assert_eq!(got, Ok("default"));
    }

    #[test]
    fn a_stereo_frame_becomes_one_sample() {
        assert_eq!(
            downmix([100i16, 300, -50, -50].into_iter(), 2),
            vec![200, -50]
        );
    }

    #[test]
    fn a_partial_frame_waits_for_the_rest() {
        // Three samples of a stereo stream is one frame and a half; the half
        // is not a sample yet.
        assert_eq!(downmix([1i16, 3, 5].into_iter(), 2), vec![2]);
    }

    #[test]
    fn float_samples_map_onto_the_whole_range() {
        assert_eq!(from_f32(0.0), 0);
        assert_eq!(from_f32(1.0), i16::MAX);
        assert_eq!(from_f32(-1.0), -i16::MAX);
        assert_eq!(from_f32(2.0), i16::MAX, "out-of-range input must clamp");
        assert!((to_f32(i16::MIN) + 1.0).abs() < 1e-6);
    }

    /// Every plain sample format a device can offer is taken (#261); only
    /// DSD, which isn't samples at all, is refused. 16-bit is preferred, then
    /// float, then anything that needs converting.
    #[test]
    fn every_plain_sample_format_is_readable() {
        use SampleFormat::*;
        for format in [I8, I16, I24, I32, I64, U8, U16, U24, U32, U64, F32, F64] {
            assert!(format_rank(format).is_some(), "{format} refused");
        }
        for format in [DsdU8, DsdU16, DsdU32] {
            assert!(format_rank(format).is_none(), "{format} taken");
        }
        assert!(format_rank(I16) < format_rank(F32));
        assert!(format_rank(F32) < format_rank(I32));
    }

    /// Converting in and out keeps silence silent and full scale full.
    #[test]
    fn converted_samples_keep_their_level() {
        assert_eq!(i16::from_sample(0i32), 0);
        assert_eq!(i16::from_sample(i32::MAX), i16::MAX);
        assert_eq!(i16::from_sample(I24::new(-(1 << 23)).unwrap()), i16::MIN);
        assert_eq!(i16::from_sample(32_768u16), 0, "u16's middle is silence");
        assert_eq!(i16::from_sample(0.5f64), 16_384);
        assert_eq!(u16::from_sample(0i16), 32_768);
        assert_eq!(i32::from_sample(i16::MIN), i32::MIN);
        assert!((f64::from_sample(i16::MIN) + 1.0).abs() < 1e-9);
    }

    /// A failed join says which device it was and why, for the voice strip
    /// to show (#261).
    #[test]
    fn a_device_that_wont_open_is_named() {
        let error = DeviceError::Opening("microphone", Box::new(DeviceError::NoDevice("input")));
        assert_eq!(
            error.to_string(),
            "the microphone wouldn't open: no input device"
        );
    }

    /// `or_default`'s build, for devices that are only names: "busy" refuses,
    /// anything else opens as itself.
    fn open_unless_busy(device: &&'static str) -> Result<&'static str, DeviceError> {
        if *device == "busy" {
            Err(DeviceError::NoDevice("input"))
        } else {
            Ok(*device)
        }
    }

    #[test]
    fn a_picked_device_that_opens_is_used_and_nothing_is_said() {
        let built = or_default(
            Some("headset"),
            &"headset",
            || Some("default"),
            "microphone",
            open_unless_busy,
        );
        assert_eq!(built.ok(), Some(("headset", None)));
    }

    #[test]
    fn a_picked_device_that_wont_open_falls_back_and_says_why() {
        // The Windows headset held by another program, with a silent
        // virtual microphone as the default (#398): the call still opens,
        // and why the headset didn't comes back to be said.
        let built = or_default(
            Some("busy"),
            &"busy",
            || Some("default"),
            "microphone",
            open_unless_busy,
        );
        assert_eq!(
            built.ok(),
            Some(("default", Some("no input device".to_owned())))
        );
    }

    #[test]
    fn the_default_that_wont_open_has_nothing_to_fall_back_to() {
        let built = or_default(
            None,
            &"busy",
            || Some("default"),
            "microphone",
            open_unless_busy,
        );
        assert_eq!(
            built.err().map(|error| error.to_string()),
            Some("no input device".to_owned())
        );
        // And a picked device that refuses, with a default that refuses too,
        // says why the picked one failed.
        let built = or_default(
            Some("busy"),
            &"busy",
            || Some("busy"),
            "microphone",
            open_unless_busy,
        );
        assert!(built.is_err());
    }

    #[test]
    fn resampling_a_constant_stays_constant_and_changes_length() {
        let mut linear = Linear::new(44_100, 48_000);
        let mut out = Vec::new();
        // Feed it in odd-sized pieces so the boundary carry is exercised.
        linear.push(&[1000i16; 441], &mut out);
        linear.push(&[1000i16; 300], &mut out);
        linear.push(&[1000i16; 141], &mut out);
        // 882 in at 44.1 kHz is 20 ms, which is 960 out at 48 kHz, give or
        // take the sample carried across the edge.
        assert!(
            (958..=961).contains(&out.len()),
            "got {} samples",
            out.len()
        );
        // The first two outputs lean on the zero carried in before any input
        // (they fall between it and the first real sample); all the rest is
        // the constant.
        assert!(out[2..].iter().all(|s| *s == 1000), "the level wandered");
    }

    #[test]
    fn resampling_at_the_same_rate_is_a_copy() {
        let mut linear = Linear::new(48_000, 48_000);
        let mut out = Vec::new();
        linear.push(&[10i16, 20, 30, 40], &mut out);
        // One sample of delay (the carried one), then the input verbatim.
        assert_eq!(out, vec![0, 10, 20, 30]);
        linear.push(&[50i16], &mut out);
        assert_eq!(out, vec![0, 10, 20, 30, 40]);
    }

    #[test]
    fn a_framer_cuts_frames_at_exactly_twenty_milliseconds() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut framer = Framer::new(1, SAMPLE_RATE, tx);
        framer.push(std::iter::repeat_n(7i16, FRAME_SAMPLES - 1));
        assert!(rx.try_recv().is_err(), "a frame was cut short");
        framer.push(std::iter::once(7i16));
        let frame = rx.try_recv().expect("a whole frame");
        assert_eq!(frame.len(), FRAME_SAMPLES);
        assert!(frame.iter().all(|s| *s == 7));
    }

    /// Mixing is a sum with a ceiling: two loud peers must not wrap around
    /// into a click.
    #[test]
    fn mixing_sums_peers_and_clamps() {
        let lanes = Mutex::new(HashMap::new());
        for (peer, level) in [("a", 20_000i16), ("b", 20_000)] {
            lanes.lock().unwrap().insert(
                peer.to_string(),
                Lane {
                    queue: VecDeque::from(vec![level, -level, 100]),
                    resampler: None,
                    gain: 1.0,
                },
            );
        }
        let mut out = [0i16; 8];
        mix(
            &lanes,
            &Mutex::default(),
            &AtomicBool::new(false),
            2,
            &mut out,
            |s| s,
        );
        // Stereo: each mixed sample lands in both slots.
        assert_eq!(out[0], i16::MAX);
        assert_eq!(out[1], i16::MAX);
        assert_eq!(out[2], i16::MIN);
        assert_eq!(out[3], i16::MIN);
        assert_eq!(out[4], 200);
        assert_eq!(out[5], 200);
        // Both lanes ran dry: silence, not a stale sample.
        assert_eq!(out[6], 0);
        assert_eq!(out[7], 0);
    }

    #[test]
    fn deafen_discards_queued_voice_without_changing_personal_volume() {
        let lanes = Mutex::new(HashMap::from([(
            "friend".to_string(),
            Lane {
                queue: VecDeque::from(vec![4000; 20]),
                resampler: None,
                gain: 0.4,
            },
        )]));
        let gate = AtomicBool::new(false);
        set_playback_deafened(&lanes, &gate, true, SAMPLE_RATE);
        let mut out = [123i16; 4];
        mix(&lanes, &Mutex::default(), &gate, 1, &mut out, |s| s);
        assert_eq!(out, [0; 4]);
        assert!(lock(&lanes)["friend"].queue.is_empty());
        set_playback_deafened(&lanes, &gate, false, SAMPLE_RATE);
        mix(&lanes, &Mutex::default(), &gate, 1, &mut out, |s| s);
        assert_eq!(out, [0; 4], "undeafen must not play old speech");
        assert_eq!(lock(&lanes)["friend"].gain, 0.4);
        lock(&lanes).get_mut("friend").unwrap().queue.push_back(800);
        mix(&lanes, &Mutex::default(), &gate, 1, &mut out, |s| s);
        assert_eq!(out, [800, 0, 0, 0]);
    }

    #[tokio::test]
    async fn deafened_speaker_drops_new_frames_and_new_peers() {
        // The production speaker queue without opening a physical device.
        let speaker = Speaker {
            lanes: Arc::new(Mutex::new(HashMap::new())),
            cues: Arc::default(),
            deafened: Arc::new(AtomicBool::new(false)),
            rate: Arc::new(AtomicU32::new(SAMPLE_RATE)),
            wanted: Arc::new(Mutex::new(None)),
            worker: Worker {
                info: (),
                stop: None,
            },
        };
        speaker.set_volume("friend", 0.5).await;
        speaker.play("friend", &[4000; 40]).await;
        speaker.set_deafened(true).await;
        speaker.play("friend", &[8000; 40]).await;
        speaker.play("new friend", &[8000; 40]).await;
        assert_eq!(lock(&speaker.lanes).len(), 1);
        assert!(lock(&speaker.lanes)["friend"].queue.is_empty());
        let mut out = [99i16; 4];
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(out, [0; 4]);
        speaker.set_deafened(false).await;
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(out, [0; 4]);
        speaker.play("friend", &[4000; 4]).await;
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(out, [2000; 4]);
    }

    fn quiet_speaker(rate: u32) -> Speaker {
        Speaker {
            lanes: Arc::new(Mutex::new(HashMap::new())),
            cues: Arc::default(),
            deafened: Arc::new(AtomicBool::new(false)),
            rate: Arc::new(AtomicU32::new(rate)),
            wanted: Arc::new(Mutex::new(None)),
            worker: Worker {
                info: (),
                stop: None,
            },
        }
    }

    /// Linger's own sounds play over the voices, overlapping ones sum, and
    /// deafen silences the voices but not the sounds (#250): the deafen
    /// sound is one of them.
    #[tokio::test]
    async fn sounds_play_over_voices_and_through_deafen() {
        let speaker = quiet_speaker(SAMPLE_RATE);
        speaker.play("friend", &[1000; 4]).await;
        speaker.cue(&[10, 20, 30]);
        speaker.cue(&[1, 2]);
        let mut out = [0i16; 5];
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(out, [1011, 1022, 1030, 1000, 0]);

        speaker.set_deafened(true).await;
        speaker.play("friend", &[1000; 4]).await;
        speaker.cue(&[7, 7]);
        let mut out = [0i16; 3];
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(
            out,
            [7, 7, 0],
            "deafen held back a sound, or let a voice through"
        );
    }

    /// Loud sounds landing together are clamped, never wrapped into a click.
    #[test]
    fn overlapping_sounds_clamp() {
        let speaker = quiet_speaker(SAMPLE_RATE);
        speaker.cue(&[30_000, -30_000]);
        speaker.cue(&[30_000, -30_000]);
        let mut out = [0i16; 2];
        mix(
            &speaker.lanes,
            &speaker.cues,
            &speaker.deafened,
            1,
            &mut out,
            |s| s,
        );
        assert_eq!(out, [i16::MAX, i16::MIN]);
    }

    /// A sound comes at 48 kHz and plays at the device's rate.
    #[test]
    fn a_sound_is_resampled_to_the_device() {
        let speaker = quiet_speaker(44_100);
        speaker.cue(&vec![500; 4_800]);
        let queued = lock(&speaker.cues).len();
        assert!(
            (4_408..=4_412).contains(&queued),
            "100 ms became {queued} samples"
        );
    }

    /// Sounds piling up faster than they play are held to a ceiling.
    #[test]
    fn sounds_queued_are_held_to_a_ceiling() {
        let speaker = quiet_speaker(SAMPLE_RATE);
        speaker.cue(&vec![1; (SAMPLE_RATE / 1000 * MAX_CUE_MS) as usize + 1000]);
        assert_eq!(
            lock(&speaker.cues).len(),
            (SAMPLE_RATE / 1000 * MAX_CUE_MS) as usize
        );
    }

    /// Your volume for somebody is a multiply with a ceiling, not a way to
    /// make a click.
    #[test]
    fn scaling_multiplies_and_clamps() {
        assert_eq!(scale(&[100, -100], 0.5), vec![50, -50]);
        assert_eq!(scale(&[20_000, -20_000], 2.0), vec![i16::MAX, i16::MIN]);
        assert_eq!(scale(&[1234], 0.0), vec![0]);
    }

    /// The picker draws names; the enumeration has to come back with the
    /// defaults among them, or the picker cannot say which is which.
    #[test]
    #[ignore = "needs real audio devices"]
    fn listing_devices_names_the_defaults() {
        let devices = list().expect("enumerate devices");
        assert!(!devices.inputs.is_empty(), "no input devices at all");
        assert!(!devices.outputs.is_empty(), "no output devices at all");
        let input = devices.default_input.expect("a default input");
        let output = devices.default_output.expect("a default output");
        assert!(
            devices.inputs.contains(&input),
            "default input {input} is not in the list"
        );
        assert!(
            devices.outputs.contains(&output),
            "default output {output} is not in the list"
        );
    }

    // --- the reopen schedule (T-1405), with no device anywhere near it ---

    /// A stream that is nothing but a handle. What matters is that it was
    /// built, and how many times.
    struct Fake;
    impl Playing for Fake {
        fn play(&self) -> Result<(), cpal::Error> {
            Ok(())
        }
    }

    use std::sync::atomic::AtomicUsize;

    const FAST: Retry = Retry {
        pause: Duration::from_millis(5),
        attempts: 3,
    };

    /// Wait for a counter to reach a value, with a ceiling well past any
    /// honest schedule so a hang fails rather than stalls the suite.
    fn wait_until(counter: &AtomicUsize, at_least: usize) -> usize {
        for _ in 0..400 {
            let seen = counter.load(Ordering::SeqCst);
            if seen >= at_least {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        counter.load(Ordering::SeqCst)
    }

    #[test]
    fn a_dead_stream_is_built_again_and_a_stop_ends_it() {
        let builds = Arc::new(AtomicUsize::new(0));
        let alarm_out: Arc<Mutex<Option<Alarm>>> = Arc::new(Mutex::new(None));
        let (b, a) = (Arc::clone(&builds), Arc::clone(&alarm_out));
        let worker = Worker::start(
            move |alarm: &Alarm| {
                b.fetch_add(1, Ordering::SeqCst);
                *a.lock().unwrap() = Some(alarm.clone());
                Ok((Fake, ()))
            },
            || panic!("gave up on a device that came back"),
            FAST,
        )
        .expect("first open");
        assert_eq!(builds.load(Ordering::SeqCst), 1);

        // The device dies: the worker builds again after the pause.
        alarm_out.lock().unwrap().as_ref().unwrap().ring();
        assert_eq!(wait_until(&builds, 2), 2, "the stream was not rebuilt");

        // Two rings for one death are one rebuild, not two.
        let alarm = alarm_out.lock().unwrap().clone().unwrap();
        alarm.ring();
        alarm.ring();
        assert_eq!(wait_until(&builds, 3), 3);
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(
            builds.load(Ordering::SeqCst),
            3,
            "a stale ring caused a rebuild"
        );

        // Dropping the worker stops it; nothing is built afterwards even if
        // the old stream's alarm still rings.
        drop(worker);
        std::thread::sleep(Duration::from_millis(20));
        alarm.ring();
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(
            builds.load(Ordering::SeqCst),
            3,
            "built after being stopped"
        );
    }

    #[test]
    fn the_first_open_failing_is_the_callers_answer() {
        let builds = Arc::new(AtomicUsize::new(0));
        let b = Arc::clone(&builds);
        let result: Result<Worker, _> = Worker::start(
            move |_: &Alarm| -> Result<(Fake, ()), DeviceError> {
                b.fetch_add(1, Ordering::SeqCst);
                Err(DeviceError::NoDevice("input"))
            },
            || panic!("abandon is for later failures, not the first"),
            FAST,
        );
        assert!(matches!(result, Err(DeviceError::NoDevice("input"))));
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(
            builds.load(Ordering::SeqCst),
            1,
            "the first failure was retried"
        );
    }

    #[test]
    fn a_device_that_never_comes_back_is_given_up_on_once() {
        let builds = Arc::new(AtomicUsize::new(0));
        let abandoned = Arc::new(AtomicUsize::new(0));
        let alarm_out: Arc<Mutex<Option<Alarm>>> = Arc::new(Mutex::new(None));
        let (b, a, gone) = (
            Arc::clone(&builds),
            Arc::clone(&alarm_out),
            Arc::clone(&abandoned),
        );
        let _worker = Worker::start(
            move |alarm: &Alarm| {
                let n = b.fetch_add(1, Ordering::SeqCst);
                *a.lock().unwrap() = Some(alarm.clone());
                if n == 0 {
                    Ok((Fake, ()))
                } else {
                    Err(DeviceError::NoDevice("output"))
                }
            },
            move || {
                gone.fetch_add(1, Ordering::SeqCst);
            },
            FAST,
        )
        .expect("first open");
        alarm_out.lock().unwrap().as_ref().unwrap().ring();
        // One good build, then `attempts` failures in a row, then it stops.
        assert_eq!(
            wait_until(&builds, 1 + FAST.attempts as usize),
            1 + FAST.attempts as usize
        );
        assert_eq!(wait_until(&abandoned, 1), 1, "never gave up");
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(
            builds.load(Ordering::SeqCst),
            1 + FAST.attempts as usize,
            "kept trying after giving up"
        );
        assert_eq!(
            abandoned.load(Ordering::SeqCst),
            1,
            "gave up more than once"
        );
    }

    #[test]
    fn a_failure_run_that_recovers_resets_the_count() {
        let builds = Arc::new(AtomicUsize::new(0));
        let alarm_out: Arc<Mutex<Option<Alarm>>> = Arc::new(Mutex::new(None));
        let (b, a) = (Arc::clone(&builds), Arc::clone(&alarm_out));
        let _worker = Worker::start(
            move |alarm: &Alarm| {
                let n = b.fetch_add(1, Ordering::SeqCst);
                *a.lock().unwrap() = Some(alarm.clone());
                // Good, then two failures, then good again — under the limit
                // each time, so never abandoned.
                if n == 1 || n == 2 {
                    Err(DeviceError::NoDevice("output"))
                } else {
                    Ok((Fake, ()))
                }
            },
            || panic!("gave up on a device that came back"),
            FAST,
        )
        .expect("first open");
        alarm_out.lock().unwrap().as_ref().unwrap().ring();
        assert_eq!(
            wait_until(&builds, 4),
            4,
            "did not recover after two failures"
        );
    }

    /// A pause long enough that a test would notice a worker waiting it out
    /// when it should have acted at once.
    const SLOW: Retry = Retry {
        pause: Duration::from_millis(400),
        attempts: 3,
    };

    /// A device picked mid-call (#249): the worker builds again straight away,
    /// on the name wanted now, and nothing waits out a pause.
    #[test]
    fn a_switch_builds_again_at_once_on_the_device_chosen() {
        let wanted = Arc::new(Mutex::new(Some("Speakers".to_string())));
        let opened: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let builds = Arc::new(AtomicUsize::new(0));
        let (w, o, b) = (
            Arc::clone(&wanted),
            Arc::clone(&opened),
            Arc::clone(&builds),
        );
        let worker = Worker::start(
            move |_: &Alarm| {
                o.lock().unwrap().push(w.lock().unwrap().clone());
                b.fetch_add(1, Ordering::SeqCst);
                Ok((Fake, ()))
            },
            || panic!("gave up on a switch"),
            SLOW,
        )
        .expect("first open");

        assert!(choose(&wanted, Some("Headphones")));
        worker.switch();
        let started = std::time::Instant::now();
        assert_eq!(wait_until(&builds, 2), 2, "the switch built nothing");
        assert!(
            started.elapsed() < SLOW.pause,
            "the switch waited out a pause"
        );
        assert!(choose(&wanted, None));
        worker.switch();
        assert_eq!(wait_until(&builds, 3), 3);
        assert_eq!(
            *opened.lock().unwrap(),
            vec![Some("Speakers".into()), Some("Headphones".into()), None]
        );
    }

    /// Picking what is already picked opens nothing again.
    #[test]
    fn choosing_the_same_device_is_not_a_switch() {
        let wanted = Mutex::new(Some("Headphones".to_string()));
        assert!(!choose(&wanted, Some("Headphones")));
        assert!(choose(&wanted, None));
        assert!(!choose(&wanted, None));
        assert!(choose(&wanted, Some("Headphones")));
    }

    /// A switch while the worker is waiting to retry a dead device tries the
    /// new one now, and the count of failures starts again for it.
    #[test]
    fn a_switch_during_retries_tries_the_new_device_now() {
        let builds = Arc::new(AtomicUsize::new(0));
        let alarm_out: Arc<Mutex<Option<Alarm>>> = Arc::new(Mutex::new(None));
        let (b, a) = (Arc::clone(&builds), Arc::clone(&alarm_out));
        let worker = Worker::start(
            move |alarm: &Alarm| {
                let n = b.fetch_add(1, Ordering::SeqCst);
                *a.lock().unwrap() = Some(alarm.clone());
                // The first device works, then dies and stays gone; the one
                // switched to (the fourth build) works.
                if n == 0 || n >= 3 {
                    Ok((Fake, ()))
                } else {
                    Err(DeviceError::NoDevice("output"))
                }
            },
            || panic!("gave up although a working device was chosen"),
            Retry {
                pause: Duration::from_millis(400),
                attempts: 3,
            },
        )
        .expect("first open");
        alarm_out.lock().unwrap().as_ref().unwrap().ring();
        // The death waits a pause, then fails (build 2); the switch arrives in
        // the next pause and builds at once, failing again (build 3, the
        // count reset to zero rather than reaching its limit)...
        assert_eq!(wait_until(&builds, 2), 2);
        let started = std::time::Instant::now();
        worker.switch();
        assert_eq!(wait_until(&builds, 3), 3);
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "the switch waited"
        );
        // ...and after one more pause the new device opens.
        assert_eq!(wait_until(&builds, 4), 4);
    }

    /// A stop that arrives on the heels of a death is not lost behind it: the
    /// worker ends rather than building again.
    #[test]
    fn a_stop_behind_a_death_is_heard() {
        let builds = Arc::new(AtomicUsize::new(0));
        let alarm_out: Arc<Mutex<Option<Alarm>>> = Arc::new(Mutex::new(None));
        let (b, a) = (Arc::clone(&builds), Arc::clone(&alarm_out));
        let worker = Worker::start(
            move |alarm: &Alarm| {
                b.fetch_add(1, Ordering::SeqCst);
                *a.lock().unwrap() = Some(alarm.clone());
                Ok((Fake, ()))
            },
            || {},
            Retry {
                pause: Duration::from_millis(100),
                attempts: 3,
            },
        )
        .expect("first open");
        let alarm = alarm_out.lock().unwrap().clone().unwrap();
        // Both waiting before the worker wakes: the death, then the stop.
        alarm.ring();
        alarm.ring();
        drop(worker);
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            builds.load(Ordering::SeqCst),
            1,
            "built after being stopped"
        );
    }

    #[test]
    fn a_retuned_lane_keeps_its_volume_and_loses_its_queue() {
        let mut lane = Lane::new(48_000);
        lane.gain = 0.5;
        lane.queue.extend([1i16, 2, 3]);
        lane.retune(44_100);
        assert!(lane.queue.is_empty());
        assert!(lane.resampler.is_some());
        assert!((lane.gain - 0.5).abs() < f32::EPSILON);
        lane.retune(48_000);
        assert!(lane.resampler.is_none());
    }

    // The tests below need a real audio device and are run by hand
    // (`cargo test -- --ignored`). CI has no sound card, and a test that skips
    // itself quietly on a runner is not the same as one that passed.

    /// The microphone produces frames of the right shape, at roughly the
    /// right rate. What it heard is not checked — a quiet room is a valid
    /// microphone.
    #[tokio::test]
    #[ignore = "needs a real input device"]
    async fn the_microphone_produces_frames_in_real_time() {
        let microphone = Microphone::open(None).expect("open the default microphone");
        let started = std::time::Instant::now();
        for _ in 0..25 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(2), microphone.frame())
                .await
                .expect("a frame within two seconds")
                .expect("the microphone stopped");
            assert_eq!(frame.len(), FRAME_SAMPLES);
        }
        // 25 frames is half a second of audio; a device delivering them much
        // faster is making them up and much slower is dropping them.
        let took = started.elapsed().as_millis();
        assert!((350..=1500).contains(&took), "25 frames took {took} ms");
    }

    /// Every output device in turn, under one open speaker, as Settings does
    /// mid-call (#249). Plays silence, so it can run without anybody hearing
    /// it; what it proves is that each switch builds a stream on a real device
    /// and the speaker keeps taking frames across them.
    #[tokio::test]
    #[ignore = "needs real output devices"]
    async fn the_speaker_switches_between_real_devices() {
        let devices = list().expect("enumerate devices");
        let speaker = Speaker::open(None).expect("open the default speakers");
        let quiet = vec![0i16; FRAME_SAMPLES];
        for name in devices
            .outputs
            .iter()
            .map(|name| Some(name.as_str()))
            .chain([None])
        {
            speaker.choose(name);
            for _ in 0..10 {
                speaker.play("test", &quiet).await;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            eprintln!(
                "switched to {name:?} at {} Hz",
                speaker.rate.load(Ordering::Relaxed)
            );
        }
        drop(speaker);
    }

    /// Half a second of a tone out of the speakers. Whether it was heard is a
    /// human check; what this proves is that the device opens, plays, and
    /// closes again without complaint.
    #[tokio::test]
    #[ignore = "needs a real output device, and makes a sound"]
    async fn the_speaker_plays_a_tone_and_closes() {
        let speaker = Speaker::open(None).expect("open the default speakers");
        let tone = crate::voice::audio::Tone::default();
        for _ in 0..25 {
            let frame = tone.frame().await.expect("a frame");
            speaker.play("test", &frame).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        speaker.forget("test").await;
        drop(speaker);
    }
}
