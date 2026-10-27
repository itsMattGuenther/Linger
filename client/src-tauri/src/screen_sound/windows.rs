//! The computer's sound on Windows, less Linger's own (#736, SPEC §4.20).
//!
//! WASAPI's process loopback (Windows 10 2004, build 19041, and later)
//! captures what every program plays except one process and everything it
//! started. That one is Linger itself, by its own process id: its voice and
//! chimes play from here, through `cpal`, and the web engine's processes,
//! WebView2's, are Linger's children, so whatever the page plays is left out
//! too. Captured whole, the call's own voices would go back out in the share
//! and everybody would hear themselves, late.
//!
//! Nothing here names, lists or asks about another program (hard rule 2):
//! the only process it names is its own, and what it gets back is the mix
//! of everything else as samples, with no word of what made them.
//!
//! One thread captures: COM on its own apartment, the audio client, and a
//! loop that wakes when Windows has sound for it, or every 100 ms to see
//! whether it should stop.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{implement, IUnknown, Interface, Ref, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, E_FAIL, HANDLE};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, IAgileObject, IAgileObject_Impl, BLOB, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use super::pack::{Packetizer, CHANNELS};
use crate::voice::audio::SAMPLE_RATE;

/// The first Windows build with process loopback: Windows 10 2004.
const FIRST_BUILD: u32 = 19_041;

/// Whether this Windows has process loopback: its build, from the registry,
/// as Windows itself reports it (`winver`). Opens nothing.
#[must_use]
pub fn available() -> bool {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    key.and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|build| build.trim().parse::<u32>().ok())
        .is_some_and(|build| build >= FIRST_BUILD)
}

/// Told when the capture has finished activating the loopback.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(mpsc::Sender<windows::core::Result<IAudioClient>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(
        &self,
        operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = operation.ok().and_then(|operation| {
            let mut activated = HRESULT::default();
            let mut client: Option<IUnknown> = None;
            // SAFETY: both pointers are to locals that outlive the call.
            unsafe { operation.GetActivateResult(&mut activated, &mut client)? };
            activated.ok()?;
            client
                .ok_or_else(|| windows::core::Error::from(E_FAIL))?
                .cast::<IAudioClient>()
        });
        let _ = self.0.send(result);
        Ok(())
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// The audio client capturing everything but Linger, started.
pub struct Loopback {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
}

impl Loopback {
    /// Activate the loopback, leaving out this process and every process it
    /// started, and start it: 48 kHz, two channels, 16 bits, which Windows
    /// converts the computer's mix to. Call it on a thread with COM.
    ///
    /// # Errors
    ///
    /// Windows' own, in words: no loopback before build 19041, no audio
    /// engine running, no output device.
    pub fn open() -> Result<Self, String> {
        let client = activate().map_err(|error| format!("activating: {error}"))?;
        let block = u16::try_from(CHANNELS * 2).unwrap_or(4);
        let format = WAVEFORMATEX {
            wFormatTag: u16::try_from(WAVE_FORMAT_PCM).unwrap_or(1),
            nChannels: u16::try_from(CHANNELS).unwrap_or(2),
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * u32::from(block),
            nBlockAlign: block,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        // SAFETY: COM calls on an interface Windows just handed over, with a
        // format that lives across the call. 100 ms of buffer, in 100 ns units.
        unsafe {
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    1_000_000,
                    0,
                    &raw const format,
                    None,
                )
                .map_err(|error| format!("starting: {error}"))?;
            let capture: IAudioCaptureClient = client
                .GetService()
                .map_err(|error| format!("reading: {error}"))?;
            let event = CreateEventW(None, false, false, PCWSTR::null())
                .map_err(|error| format!("waiting: {error}"))?;
            let loopback = Self {
                client,
                capture,
                event,
            };
            loopback
                .client
                .SetEventHandle(loopback.event)
                .map_err(|error| format!("waiting: {error}"))?;
            loopback
                .client
                .Start()
                .map_err(|error| format!("starting: {error}"))?;
            Ok(loopback)
        }
    }

    /// Wait up to 100 ms for sound, then hand `heard` all there is: when its
    /// first sample was captured, in microseconds on the system's clock, and
    /// the samples, interleaved, silence as zeros.
    ///
    /// # Errors
    ///
    /// When Windows stops giving sound: the device went, or the engine.
    pub fn read(&mut self, heard: &mut impl FnMut(u64, &[i16])) -> Result<(), String> {
        // SAFETY: the event is ours until drop, and each buffer is read
        // within its GetBuffer and ReleaseBuffer, for the length Windows gave.
        unsafe {
            WaitForSingleObject(self.event, 100);
            loop {
                let frames = self
                    .capture
                    .GetNextPacketSize()
                    .map_err(|error| error.to_string())?;
                if frames == 0 {
                    return Ok(());
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut count = 0u32;
                let mut flags = 0u32;
                let mut at = 0u64;
                self.capture
                    .GetBuffer(&mut data, &mut count, &mut flags, None, Some(&raw mut at))
                    .map_err(|error| error.to_string())?;
                let samples = count as usize * CHANNELS;
                // The system's clock, in 100 ns units.
                let micros = at / 10;
                if data.is_null() || flags & AUDCLNT_BUFFERFLAGS_SILENT.0.cast_unsigned() != 0 {
                    heard(micros, &vec![0; samples]);
                } else {
                    heard(
                        micros,
                        std::slice::from_raw_parts(data.cast::<i16>(), samples),
                    );
                }
                self.capture
                    .ReleaseBuffer(count)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        // SAFETY: stopping a client we started, and closing our own event.
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

/// Ask Windows for the loopback, and wait for it.
fn activate() -> windows::core::Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                // Linger, and every process it started: left out.
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let size = u32::try_from(std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>()).unwrap_or(0);
    // Never dropped: windows' PROPVARIANT clears itself on drop, and a
    // cleared blob is freed, which here is `params` on the stack. Freed, it
    // corrupted the heap (CI's Windows runner, 2026-10-27).
    let blob = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size,
                        pBlobData: (&raw mut params).cast(),
                    },
                },
            }),
        },
    });
    let (tx, rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(tx).into();
    // SAFETY: `blob` and the `params` it points at live until the answer
    // has come, below; the handler is kept alive by `handler` as long.
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(std::ptr::from_ref::<PROPVARIANT>(&blob)),
            &handler,
        )?
    };
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| windows::core::Error::from(E_FAIL));
    drop(handler);
    answer?
}

/// The capture, running on its own thread until it's dropped.
pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// How many times in a row reading may fail, each followed by opening the
/// loopback again, before the capture gives up and says so.
const TRIES: u32 = 5;

impl Capture {
    /// Start capturing: each packet goes to `packet`, wire-shaped
    /// (`ScreenSoundHead`, then Opus), stamped on the system's clock; the
    /// page restamps it on the share's own. `ended` is told why, once, if it
    /// stops by itself. Answers once the loopback has started, or why not.
    ///
    /// # Errors
    ///
    /// Why the loopback wouldn't start.
    pub fn start(
        mut packet: impl FnMut(Vec<u8>) + Send + 'static,
        ended: impl FnOnce(String) + Send + 'static,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let (ready, started) = mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name("linger-screen-sound".into())
            .spawn(move || {
                // SAFETY: this thread's own apartment, ended below.
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                run(&stopping, &ready, &mut packet, ended);
                // SAFETY: paired with the call above, on the same thread.
                unsafe { CoUninitialize() };
            })
            .map_err(|error| error.to_string())?;
        let capture = Self {
            stop,
            thread: Some(thread),
        };
        match started.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(capture),
            Ok(Err(why)) => Err(why),
            Err(_) => Err("the sound didn't start".into()),
        }
    }
}

fn run(
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<(), String>>,
    packet: &mut impl FnMut(Vec<u8>),
    ended: impl FnOnce(String),
) {
    let mut packetizer = match Packetizer::new() {
        Ok(packetizer) => packetizer,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let mut loopback = match Loopback::open() {
        Ok(loopback) => loopback,
        Err(why) => {
            let _ = ready.send(Err(why));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut failed = 0;
    let mut heard = |micros: u64, samples: &[i16]| {
        for made in packetizer.push(micros, samples) {
            let mut wire = linger_core::screen::ScreenSoundHead {
                micros: made.micros,
            }
            .write()
            .to_vec();
            wire.extend_from_slice(&made.opus);
            packet(wire);
        }
    };
    while !stop.load(Ordering::Relaxed) {
        match loopback.read(&mut heard) {
            Ok(()) => failed = 0,
            Err(why) => {
                failed += 1;
                if failed >= TRIES {
                    ended(why);
                    return;
                }
                std::thread::sleep(Duration::from_millis(500));
                match Loopback::open() {
                    Ok(again) => loopback = again,
                    Err(why) if failed + 1 >= TRIES => {
                        ended(why);
                        return;
                    }
                    Err(_) => {}
                }
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_loopback_starts_and_reads_for_a_second() {
        // This Windows has the loopback, or the test says why not and stops.
        if !available() {
            eprintln!(
                "skipped: this Windows is older than build {FIRST_BUILD}, with no process loopback"
            );
            return;
        }
        // SAFETY: this thread's own apartment, ended below.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let mut loopback = match Loopback::open() {
            Ok(loopback) => loopback,
            Err(why) => {
                // A machine with no audio engine, or no output device to mix
                // for (CI's Windows runner can be one).
                eprintln!("skipped: no audio engine to capture from here: {why}");
                // SAFETY: paired with the call above.
                unsafe { CoUninitialize() };
                return;
            }
        };
        let until = std::time::Instant::now() + Duration::from_secs(1);
        let (mut reads, mut samples) = (0, 0);
        while std::time::Instant::now() < until {
            loopback
                .read(&mut |_, got: &[i16]| samples += got.len())
                .expect("reading the loopback");
            reads += 1;
        }
        eprintln!("process loopback: {reads} reads, {samples} samples in a second");
        assert!(reads > 0);
        drop(loopback);
        // SAFETY: paired with the call above.
        unsafe { CoUninitialize() };
    }
}
