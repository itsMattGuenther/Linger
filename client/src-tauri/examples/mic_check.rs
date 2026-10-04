//! Linger mic check (#398): every microphone on this computer, tested with
//! Linger's own voice code, and a report somebody can send back.
//!
//! Made for a friend whose headset Linger never heard, on a Windows PC nobody
//! working on Linger can sit at. It listens to each microphone for a few
//! seconds while they talk, two ways at once:
//!
//! - **Linger's way**: `voice::device::Microphone`, the same code a call
//!   opens, down to the 20 ms frames the "talking" light reads
//!   (`voice::level`). This is what Linger hears.
//! - **Raw**: the device in its own format, each channel on its own, before
//!   Linger mixes them into one. This is why.
//!
//! It records nothing and sends nothing. The report is device names, formats
//! and levels, in a text file next to the program, which the person sends
//! themselves if they want to.
//!
//! Built for Windows by `.github/workflows/mic-check.yml`; runs anywhere:
//! `cargo run --release --example mic_check` (`LINGER_MIC_CHECK_SECONDS` sets
//! how long each microphone is heard, 5 by default; `LINGER_MIC_CHECK_ONLY`
//! tests only the microphones whose names contain it).

use std::fmt::Write as _;
use std::io::{BufRead as _, Write as _};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample as _, SampleFormat, SizedSample, I24, U24};
use linger_client_lib::voice::audio::Source;
use linger_client_lib::voice::device::{self, Microphone};
use linger_client_lib::voice::level;

/// i16 full scale, for turning Linger's levels into decibels.
const FULL_SCALE: f32 = 32_768.0;

fn main() {
    let seconds = std::env::var("LINGER_MIC_CHECK_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (1..=30).contains(seconds))
        .unwrap_or(5);
    let listen = Duration::from_secs(seconds);

    println!("Linger mic check");
    println!("================");
    println!();
    println!("This listens to each microphone on this computer for {seconds} seconds");
    println!("while you talk, the way Linger does, and writes down what it heard:");
    println!("how loud, and in what format. It records nothing and sends nothing.");
    println!();
    println!("Before you start: close Linger, put your headset on, and have it");
    println!("plugged in or switched on as you normally would.");
    println!();
    wait_for_enter("Press Enter to start.");

    let mut report = String::new();
    let _ = writeln!(
        report,
        "Linger mic check, built from Linger {}{}",
        env!("CARGO_PKG_VERSION"),
        build_note()
    );
    let _ = writeln!(report, "System: {}", system());
    let _ = writeln!(
        report,
        "Linger's \"talking\" line: a 20 ms moment louder than {} ({:.1} dB) lights your name.",
        level::THRESHOLD,
        decibels(level::THRESHOLD / FULL_SCALE)
    );
    let _ = writeln!(report);

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            println!("Couldn't start: {error}");
            wait_for_enter("Press Enter to close.");
            return;
        }
    };

    let listed = match device::list() {
        Ok(listed) => listed,
        Err(error) => {
            let _ = writeln!(report, "Couldn't list the sound devices: {error}");
            finish(&report);
            return;
        }
    };
    let default = listed.default_input.clone();
    let _ = writeln!(report, "Microphones, as Linger lists them:");
    for name in &listed.inputs {
        let mark = if Some(name) == default.as_ref() {
            "  <- system default"
        } else {
            ""
        };
        let _ = writeln!(report, "  - {name}{mark}");
        let _ = writeln!(report, "      its own format: {}", own_format(name));
    }
    if listed.inputs.is_empty() {
        let _ = writeln!(report, "  (none)");
    }
    let _ = writeln!(report, "Speakers, as Linger lists them:");
    for name in &listed.outputs {
        let mark = if Some(name) == listed.default_output.as_ref() {
            "  <- system default"
        } else {
            ""
        };
        let _ = writeln!(report, "  - {name}{mark}");
    }
    let _ = writeln!(report);

    let only = std::env::var("LINGER_MIC_CHECK_ONLY").unwrap_or_default();
    let testing: Vec<&String> = listed
        .inputs
        .iter()
        .filter(|name| name.contains(&only))
        .collect();
    let total = testing.len();
    // Saved after every microphone, so a device that takes the program down
    // with it still leaves what came before.
    save(&report);
    for (index, name) in testing.into_iter().enumerate() {
        println!();
        println!("Microphone {} of {total}: {name}", index + 1);
        println!("  Talk now (count out loud, or read something) until it says stop...");
        let heard = runtime.block_on(test(name, listen));
        println!("  Stop. {}", heard.verdict);
        let _ = writeln!(report, "Microphone {} of {total}: {name}", index + 1);
        report.push_str(&heard.lines);
        let _ = writeln!(report, "  So: {}", heard.verdict);
        let _ = writeln!(report);
        save(&report);
    }

    finish(&report);
}

/// What one microphone gave, as report lines and a one-line verdict.
struct Heard {
    lines: String,
    verdict: String,
}

/// Listen to one microphone both ways at once for `listen`.
async fn test(name: &str, listen: Duration) -> Heard {
    let mut lines = String::new();

    // Raw, alongside: the device in its own format, channel by channel.
    let raw = Arc::new(Mutex::new(Raw::default()));
    let raw_stream = open_raw(name, &raw);
    if let Err(why) = &raw_stream {
        let _ = writeln!(lines, "  Raw: couldn't open it ({why})");
    }

    // Linger's way, as a call opens it, by name.
    let microphone = match tokio::task::spawn_blocking({
        let name = name.to_owned();
        move || Microphone::open(Some(&name))
    })
    .await
    {
        Ok(Ok(microphone)) => microphone,
        Ok(Err(error)) => {
            return Heard {
                lines,
                verdict: format!("Linger couldn't open it: {error}"),
            };
        }
        Err(error) => {
            return Heard {
                lines,
                verdict: format!("the check itself failed: {error}"),
            };
        }
    };
    let refused = microphone.refused();
    if let Some(refused) = &refused {
        let _ = writeln!(
            lines,
            "  Linger couldn't open it ({}), so Linger used the system default instead; the levels below are the default's.",
            refused.why
        );
    }

    let started = Instant::now();
    let mut frames = 0usize;
    let mut loud = 0usize;
    let mut loudest = 0f32;
    let mut zeros = 0usize;
    let mut first_frame = None;
    while let Some(remaining) = listen.checked_sub(started.elapsed()) {
        match tokio::time::timeout(remaining, microphone.frame()).await {
            Ok(Some(frame)) => {
                if first_frame.is_none() {
                    first_frame = Some(started.elapsed());
                }
                frames += 1;
                let rms = level::rms(&frame);
                loudest = loudest.max(rms);
                if rms >= level::THRESHOLD {
                    loud += 1;
                }
                if frame.iter().all(|sample| *sample == 0) {
                    zeros += 1;
                }
            }
            Ok(None) => {
                let _ = writeln!(
                    lines,
                    "  Linger's way: the microphone stopped partway through."
                );
                break;
            }
            Err(_) => break,
        }
    }
    drop(microphone);
    drop(raw_stream);

    let expected = usize::try_from(listen.as_millis() / 20).unwrap_or(usize::MAX);
    let _ = writeln!(
        lines,
        "  Linger's way: {frames} of about {expected} moments of 20 ms arrived{}",
        first_frame.map_or_else(String::new, |at| format!(
            ", the first after {} ms",
            at.as_millis()
        ))
    );
    // Of the moments that arrived, how many were over the talking line.
    let percent = (loud * 100).checked_div(frames);
    if let Some(percent) = percent {
        let _ = writeln!(
            lines,
            "    loudest moment {} ({loudest:.0}); over the talking line {loud} of {frames} ({percent}%); exactly silent {zeros} of {frames}",
            db_text(loudest / FULL_SCALE),
        );
    }
    let raw = raw.lock().map(|held| held.clone()).unwrap_or_default();
    if raw.callbacks > 0 {
        let _ = writeln!(lines, "  Raw, before Linger mixes the channels into one:");
        for (index, channel) in raw.channels.iter().enumerate() {
            let rms = if channel.count == 0 {
                0.0
            } else {
                (channel.squares / channel.count as f64).sqrt() as f32
            };
            let _ = writeln!(
                lines,
                "    channel {}: loudest {}, average {}{}",
                index + 1,
                db_text(channel.peak),
                db_text(rms),
                if channel.peak == 0.0 {
                    " (every sample exactly zero)"
                } else {
                    ""
                }
            );
        }
    }
    let silent_channels = raw
        .channels
        .iter()
        .filter(|channel| channel.peak == 0.0)
        .count();
    if raw.channels.len() > 1 && silent_channels > 0 && silent_channels < raw.channels.len() {
        let _ = writeln!(
            lines,
            "    only {} of {} channels carry sound, and Linger averages them, so it hears this microphone quieter than it is",
            raw.channels.len() - silent_channels,
            raw.channels.len()
        );
    }

    let verdict = if refused.is_some() {
        "Linger couldn't open this microphone, and would quietly use the system default instead"
            .to_owned()
    } else if frames == 0 {
        "no sound arrived at all".to_owned()
    } else if zeros == frames {
        "sound arrived, but every bit of it was exact silence: the computer is handing Linger nothing".to_owned()
    } else if loud == 0 {
        format!(
            "sound arrived, but it never got loud enough to light your name (loudest {}, the line is {})",
            db_text(loudest / FULL_SCALE),
            db_text(level::THRESHOLD / FULL_SCALE)
        )
    } else {
        format!(
            "Linger hears it, and would light your name ({}% of the time here)",
            percent.unwrap_or(0)
        )
    };
    Heard { lines, verdict }
}

/// One channel, raw: its loudest sample and its running average.
#[derive(Debug, Clone, Default)]
struct Channel {
    peak: f32,
    squares: f64,
    count: usize,
}

#[derive(Debug, Clone, Default)]
struct Raw {
    channels: Vec<Channel>,
    callbacks: usize,
}

impl Raw {
    fn push(&mut self, samples: impl Iterator<Item = f32>, channels: usize) {
        if self.channels.len() != channels {
            self.channels = vec![Channel::default(); channels];
        }
        self.callbacks += 1;
        for (index, sample) in samples.enumerate() {
            let channel = &mut self.channels[index % channels];
            channel.peak = channel.peak.max(sample.abs());
            channel.squares += f64::from(sample) * f64::from(sample);
            channel.count += 1;
        }
    }
}

/// The input device with this name, as Linger finds it.
fn find(name: &str) -> Option<cpal::Device> {
    cpal::default_host().input_devices().ok()?.find(|device| {
        device
            .description()
            .ok()
            .map(|d| d.name().to_owned())
            .as_deref()
            == Some(name)
    })
}

/// The format Windows (or the system) hands this microphone's sound over in.
fn own_format(name: &str) -> String {
    let Some(device) = find(name) else {
        return "not found".to_owned();
    };
    match device.default_input_config() {
        Ok(config) => format!(
            "{} channel{}, {} Hz, {:?}",
            config.channels(),
            if config.channels() == 1 { "" } else { "s" },
            config.sample_rate(),
            config.sample_format()
        ),
        Err(error) => format!("unknown ({error})"),
    }
}

/// Open the device in its own format and keep raw per-channel levels.
fn open_raw(name: &str, raw: &Arc<Mutex<Raw>>) -> Result<cpal::Stream, String> {
    let device = find(name).ok_or("not found")?;
    let config = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let channels = usize::from(config.channels());
    let format = config.sample_format();
    let config = config.config();
    let stream = match format {
        SampleFormat::F32 => raw_as::<f32>(&device, config, channels, raw),
        SampleFormat::F64 => raw_as::<f64>(&device, config, channels, raw),
        SampleFormat::I8 => raw_as::<i8>(&device, config, channels, raw),
        SampleFormat::I16 => raw_as::<i16>(&device, config, channels, raw),
        SampleFormat::I24 => raw_as::<I24>(&device, config, channels, raw),
        SampleFormat::I32 => raw_as::<i32>(&device, config, channels, raw),
        SampleFormat::U8 => raw_as::<u8>(&device, config, channels, raw),
        SampleFormat::U16 => raw_as::<u16>(&device, config, channels, raw),
        SampleFormat::U24 => raw_as::<U24>(&device, config, channels, raw),
        SampleFormat::U32 => raw_as::<u32>(&device, config, channels, raw),
        other => return Err(format!("its format, {other:?}, isn't one this check reads")),
    }?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(stream)
}

fn raw_as<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    raw: &Arc<Mutex<Raw>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let raw = Arc::clone(raw);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if let Ok(mut held) = raw.lock() {
                    held.push(
                        data.iter().map(|sample| f32::from_sample(*sample)),
                        channels,
                    );
                }
            },
            |error| eprintln!("  (raw: {error})"),
            None,
        )
        .map_err(|error| error.to_string())
}

/// A level from 0 to 1 in decibels below full scale.
fn decibels(level: f32) -> f32 {
    20.0 * level.log10()
}

fn db_text(level: f32) -> String {
    if level <= 0.0 {
        "silent".to_owned()
    } else {
        format!("{:.1} dB", decibels(level))
    }
}

fn build_note() -> String {
    option_env!("GITHUB_SHA").map_or_else(String::new, |sha| {
        format!(" (commit {})", &sha[..sha.len().min(7)])
    })
}

/// Which system this is, in its own words.
fn system() -> String {
    let output = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
    } else {
        std::process::Command::new("uname").args(["-sr"]).output()
    };
    output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| std::env::consts::OS.to_owned())
}

/// Save the report, show it, and wait so the window doesn't vanish.
fn finish(report: &str) {
    let saved = save(report);
    println!();
    println!("{report}");
    match &saved {
        Some(path) => {
            println!("Saved to {}", path.display());
            println!("Send that file to Matt. It has no recordings in it, only the above.");
            if cfg!(windows) {
                let _ = std::process::Command::new("explorer")
                    .arg(format!("/select,{}", path.display()))
                    .spawn();
            }
        }
        None => println!("Couldn't save the report: take a screenshot of this window instead."),
    }
    wait_for_enter("Press Enter to close.");
}

/// Write the report beside the program, or in the home folder when that
/// can't be written (run from inside a zip, say); where it went, if anywhere.
fn save(report: &str) -> Option<PathBuf> {
    let beside = std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name("linger-mic-check.txt"));
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join("linger-mic-check.txt"));
    [beside, home]
        .into_iter()
        .flatten()
        .find(|path| std::fs::write(path, report).is_ok())
}

fn wait_for_enter(prompt: &str) {
    println!("{prompt}");
    let _ = std::io::stdout().flush();
    let _ = std::io::stdin().lock().read_line(&mut String::new());
}
