//! Phone notifications, the iPhone's side (#889, #830, SPEC §4.15, PROTOCOL §5
//! "Phone notifications").
//!
//! - **Permission:** iOS's own question, asked once, when somebody turns
//!   notifications on. Alerts and sounds, never a badge (hard rule 3). The
//!   page waits for the answer here rather than for an event.
//! - **Address:** the device token Apple gives this copy of the app, asked
//!   for on the main thread and answered to the app's delegate, which gets two
//!   methods for it at the start (`install`).
//! - **Keys:** made with Security.framework, kept in one Keychain entry in the
//!   App Group's access group (`share_window::ios::Keychain`), which the
//!   notification extension (`gen/apple/NotificationService`) reads to open
//!   each notification. Readable from the phone's first unlock, so a locked
//!   phone's notifications open, and kept to this phone, out of backups.
//! - **Taps:** Linger is the notification center's delegate. A tapped
//!   notification's conversation is kept for the page (`opened`), which is
//!   told it's there (`linger:push-opened`) or asks when it starts. While
//!   Linger is on screen nothing shows: the app shows what arrives itself.
//!
//! Every `unsafe` is here, each with what makes it sound.

use std::ffi::CStr;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{
    AnyClass, AnyObject, Bool, Imp, NSObject, NSObjectProtocol, ProtocolObject, Sel,
};
use objc2::{define_class, msg_send, sel, AllocAnyThread, MainThreadMarker};
use objc2_foundation::{NSData, NSError, NSString};
use objc2_ui_kit::UIApplication;
use objc2_user_notifications::{
    UNAuthorizationOptions, UNNotification, UNNotificationPresentationOptions,
    UNNotificationResponse, UNNotificationSettings, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use rand::RngCore;
use security_framework::key::{GenerateKeyOptions, KeyType, SecKey};
use tauri::{AppHandle, Manager};

use super::kept::{self, Book, Entry, Keys};
use super::{PushAddress, PushKeys, PushOpened, NOT_HERE};
use crate::share_window::ios::Keychain;
use crate::share_window::Store;

/// The Keychain entry the keys are kept in, which the extension reads.
const KEYS: Keychain = Keychain::new(kept::SERVICE, kept::ACCOUNT);

/// How long to wait for Apple's push service to hand over the address, as
/// long as Android waits for Google's.
const ADDRESS_WAIT: Duration = Duration::from_secs(20);
/// How long to wait for somebody to answer iOS's question: long enough to
/// read it, and no answer reads as no, as the page reads it on Android.
const ASK_WAIT: Duration = Duration::from_secs(120);

const NO_ADDRESS: &str = "Apple's push service didn't answer. Try again in a minute.";
const REFUSED: &str = "This iPhone couldn't sign up for notifications. Try again in a minute.";
const NO_KEYS: &str = "This iPhone couldn't make its notification keys. Try again.";

/// What the page is told when a tapped notification opened Linger: it asks
/// which conversation (`push_opened`). Android's MainActivity sends the same.
const OPENED_SCRIPT: &str = "window.dispatchEvent(new Event('linger:push-opened'))";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The conversation the last tapped notification is about, until the page takes it.
static OPENED: Mutex<Option<PushOpened>> = Mutex::new(None);
/// Everybody waiting for Apple's answer to "register": each gets the same.
static WAITING: Mutex<Vec<Sender<Result<String, String>>>> = Mutex::new(Vec::new());
/// The keys' table, read, changed and written back holding this, so two
/// servers' keys made at once can't write over each other, with any
/// removal still owed (`kept::Book`). The extension only reads it.
static BOOK: Mutex<Book> = Mutex::new(Book::new());

/// The Keychain entry as `kept` reads it: no entry is no keys, and an entry
/// that couldn't be read is never mistaken for none.
impl Entry for Keychain {
    fn read(&self) -> Result<Option<Vec<u8>>, ()> {
        self.read_found()
    }
    fn write(&self, bytes: &[u8]) -> bool {
        Store::write(self, bytes)
    }
}

/// At the start, on the main thread (the app's setup): taps come here, and
/// Apple's answer about the address has somewhere to go. Before the app
/// finishes starting, as Apple asks, so a tap that started Linger is heard.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("linger: notifications weren't set up on the main thread");
        return;
    };
    let taps = Taps::new();
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*taps)));
    // The center doesn't keep its delegate; this one is for the app's life.
    std::mem::forget(taps);
    answers_to_the_delegate(mtm);
}

/// Give the app's delegate (tao's `AppDelegate`) the two methods Apple
/// answers "register" with. UIKit can note which methods its delegate has
/// when it's set, so the delegate is set again afterwards, held meanwhile,
/// the way push libraries that add these at run time do.
fn answers_to_the_delegate(mtm: MainThreadMarker) {
    let app = UIApplication::sharedApplication(mtm);
    // SAFETY: `delegate` takes no arguments and answers an object or nil.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![&*app, delegate] };
    let Some(delegate) = delegate else {
        eprintln!("linger: no app delegate to hear Apple's push address");
        return;
    };
    let class: *const AnyClass = delegate.class();
    let methods: [(Sel, Imp); 2] = [
        (
            sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:),
            // SAFETY: an `Imp` is any C function the runtime calls with the
            // receiver and selector first; these take what the types string
            // below says: two objects.
            unsafe { std::mem::transmute::<Registered, Imp>(registered) },
        ),
        (
            sel!(application:didFailToRegisterForRemoteNotificationsWithError:),
            // SAFETY: as above.
            unsafe { std::mem::transmute::<Refused, Imp>(refused) },
        ),
    ];
    // Returns nothing; takes self, the selector, and two objects.
    let types: &CStr = c"v@:@@";
    for (name, imp) in methods {
        // SAFETY: the delegate's class is a registered class, and the
        // function matches `types`. Adding fails only if the class already
        // has the method, which tao's doesn't.
        let added =
            unsafe { objc2::ffi::class_addMethod(class.cast_mut(), name, imp, types.as_ptr()) };
        if !added.as_bool() {
            eprintln!("linger: the app delegate already answers {name}");
        }
    }
    // SAFETY: the same delegate, held by `delegate` across both calls, so
    // clearing it can't let it go.
    unsafe {
        let _: () = msg_send![&*app, setDelegate: None::<&AnyObject>];
        let _: () = msg_send![&*app, setDelegate: &*delegate];
    }
}

/// The two methods' shapes: the delegate, the selector, the application and
/// what Apple answered.
type Registered = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut NSData);
type Refused = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut NSError);

/// Apple's address for this copy of the app.
unsafe extern "C-unwind" fn registered(
    _delegate: *mut AnyObject,
    _cmd: Sel,
    _app: *mut AnyObject,
    token: *mut NSData,
) {
    // SAFETY: UIKit hands over the token, alive for the call, or nil.
    let token = unsafe { token.as_ref() }.map(|token| kept::hex(&token.to_vec()));
    answer(
        token
            .filter(|token| !token.is_empty())
            .ok_or_else(|| NO_ADDRESS.to_string()),
    );
}

/// Apple said no: no `aps-environment` in the app's signature, or no
/// network.
unsafe extern "C-unwind" fn refused(
    _delegate: *mut AnyObject,
    _cmd: Sel,
    _app: *mut AnyObject,
    error: *mut NSError,
) {
    // SAFETY: UIKit hands over the error, alive for the call, or nil.
    if let Some(error) = unsafe { error.as_ref() } {
        eprintln!(
            "linger: Apple's push service said no: {}",
            error.localizedDescription()
        );
    }
    answer(Err(REFUSED.to_string()));
}

fn answer(result: Result<String, String>) {
    let waiting = std::mem::take(&mut *WAITING.lock().unwrap_or_else(PoisonError::into_inner));
    for tell in waiting {
        let _ = tell.send(result.clone());
    }
}

/// iOS's answer to whether Linger may notify, as `UNAuthorizationStatus`.
fn status() -> Option<isize> {
    let (tell, told) = mpsc::channel();
    let settings = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the center hands over the settings, alive for the call.
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = tell.send(status.0);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&settings);
    told.recv_timeout(Duration::from_secs(10)).ok()
}

/// `push_permission` on an iPhone: whether iOS lets Linger notify, and, with
/// `ask`, iOS's question, once, waited for here, so the page gets the answer
/// rather than an event (`lib/push.ts`, `permitted`).
pub fn permission(ask: bool) -> String {
    let now = kept::permission(status());
    if !ask || now != "ask" {
        return now.to_string();
    }
    let (tell, told) = mpsc::channel();
    let answered = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tell.send(granted.as_bool());
    });
    // Alerts and sounds. Never a badge (hard rule 3).
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &answered,
        );
    match told.recv_timeout(ASK_WAIT) {
        Ok(true) => "granted",
        _ => "denied",
    }
    .to_string()
}

/// `push_address` on an iPhone: Apple's device token for this copy of the
/// app, for the page to have the relay seal. Asked for at every start, as
/// Apple asks, since it can change.
pub fn address() -> Result<PushAddress, String> {
    let app = APP.get().ok_or_else(|| NOT_HERE.to_string())?;
    let (tell, told) = mpsc::channel();
    WAITING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(tell);
    // UIKit's, so the main thread's.
    app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            UIApplication::sharedApplication(mtm).registerForRemoteNotifications();
        }
    })
    .map_err(|_| NOT_HERE.to_string())?;
    match told.recv_timeout(ADDRESS_WAIT) {
        Ok(Ok(token)) => Ok(PushAddress {
            service: kept::service(cfg!(debug_assertions)).to_string(),
            address: token,
        }),
        Ok(Err(words)) => Err(words),
        Err(_) => Err(NO_ADDRESS.to_string()),
    }
}

/// `push_keys` on an iPhone: what `server` encrypts this phone's
/// notifications to, made the first time and kept where the extension reads
/// them. The private key never leaves the phone.
pub fn keys(server: &str) -> Result<PushKeys, String> {
    BOOK.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .keys(&KEYS, server, make)
        .map(|keys| keys.handed_over())
        .ok_or_else(|| NO_KEYS.to_string())
}

/// A new P-256 key pair, made by Security.framework and never stored by it,
/// and a new secret.
fn make() -> Option<Keys> {
    let mut options = GenerateKeyOptions::default();
    options.set_key_type(KeyType::ec()).set_size_in_bits(256);
    let key = SecKey::generate(options.to_dictionary()).ok()?;
    // Never empty, which core-foundation 0.9 can't read (#844): 04, X, Y
    // and the scalar.
    let whole = key
        .external_representation()
        .filter(|whole| whole.len() == 97)?;
    let mut auth = [0u8; 16];
    rand::rng().fill_bytes(&mut auth);
    Keys::from_x963(whole.bytes(), &auth)
}

/// `push_forget` on an iPhone: forget `server`'s keys, so nothing it sends
/// can be opened here. One that can't be saved yet is owed, and saved with
/// the next change (`kept::Book`). The address stays: Apple asks apps not to
/// give it up, and no server holds it once each has forgotten this phone.
pub fn forget(server: &str) {
    let saved = BOOK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .forget(&KEYS, server);
    if !saved {
        eprintln!(
            "linger: a server's notification keys couldn't be forgotten yet; the next change will"
        );
    }
}

/// `push_opened` on an iPhone: the conversation the last tapped notification
/// is about, once.
pub fn opened() -> Option<PushOpened> {
    OPENED.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// A notification tapped: keep its conversation, and tell the page.
fn tapped(response: &UNNotificationResponse) {
    let info = response.notification().request().content().userInfo();
    let field = |name: &str| {
        info.objectForKey(&NSString::from_str(name))
            .and_then(|value| value.downcast::<NSString>().ok())
            .map(|value| value.to_string())
    };
    let Some(target) = kept::opened(
        field(kept::TAP_SERVER),
        field(kept::TAP_ROOM),
        field(kept::TAP_MESSAGE),
    ) else {
        return;
    };
    *OPENED.lock().unwrap_or_else(PoisonError::into_inner) = Some(target);
    if let Some(app) = APP.get() {
        for window in app.webview_windows().values() {
            let _ = window.eval(OPENED_SCRIPT);
        }
    }
}

define_class!(
    /// The notification center's delegate: taps, and nothing shown while
    /// Linger is on screen.
    #[unsafe(super(NSObject))]
    #[name = "LingerNotificationTaps"]
    struct Taps;

    unsafe impl NSObjectProtocol for Taps {}

    unsafe impl UNUserNotificationCenterDelegate for Taps {
        // On screen, the app shows what arrives itself: a notification then
        // would say it twice.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            done.call((UNNotificationPresentationOptions::empty(),));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            done: &DynBlock<dyn Fn()>,
        ) {
            tapped(response);
            done.call(());
        }
    }
);

impl Taps {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's `init`, on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}
