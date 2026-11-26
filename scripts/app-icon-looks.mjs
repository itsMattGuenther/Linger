// The app icon's looks (#961): the door with its light on, which every
// platform shows, and five more a person can pick on a phone, in Settings ›
// Appearance › App icon (SPEC §4.15). One list for the icon script
// (scripts/app-icons.mjs) and its test, which checks the Rust, Kotlin, Swift,
// manifest and page lists agree with it.
//
// - `id` is what the page and Rust say.
// - `ios` is the asset catalog's icon set; the first is the app's own icon.
// - `android` is the launcher icon's resource name; `alias` is the Android
//   manifest's launcher entry that shows it (one turned on at a time).
export const LOOKS = [
  { id: "door", name: "The door", ios: "AppIcon", android: "ic_launcher", alias: "IconDoor" },
  { id: "after-dark", name: "After dark", ios: "AppIcon-AfterDark", android: "ic_launcher_after_dark", alias: "IconAfterDark" },
  { id: "porch-light", name: "Porch light", ios: "AppIcon-PorchLight", android: "ic_launcher_porch_light", alias: "IconPorchLight" },
  { id: "daylight", name: "Daylight", ios: "AppIcon-Daylight", android: "ic_launcher_daylight", alias: "IconDaylight" },
  { id: "dusk", name: "Dusk", ios: "AppIcon-Dusk", android: "ic_launcher_dusk", alias: "IconDusk" },
  { id: "original", name: "The original", ios: "AppIcon-Original", android: "ic_launcher_original", alias: "IconOriginal" },
];
