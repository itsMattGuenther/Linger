#[test]
fn window_icon_has_enough_pixels_for_high_density_desktops() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let icon = context.default_window_icon().expect("packaged window icon");
    assert!(icon.width() >= 256 && icon.height() >= 256);
}

#[test]
fn displayed_product_name_is_capitalized_without_changing_app_identity() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let config = context.config();
    assert_eq!(config.product_name.as_deref(), Some("Linger"));
    assert_eq!(config.app.windows[0].title, "Linger");
    assert_eq!(config.identifier, "com.linger.desktop");
    // Tauri derives this from productName by default. Preserve the original
    // lowercase name's identity so capitalization is still an MSI upgrade.
    // Packaging-only fields are stripped from the generated runtime context.
    let packaging: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("packaging config");
    assert_eq!(
        packaging["bundle"]["windows"]["wix"]["upgradeCode"].as_str(),
        Some("465ad9d4-963e-58d4-ac8c-2730a192a3e0")
    );
}
