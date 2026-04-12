use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_identity::{
    APP_NAME, MENU_CHECK_FOR_UPDATES_EVENT_NAME, MENU_OPEN_SETTINGS_EVENT_NAME,
};
use crate::domain::settings::GlobalSettings;

#[cfg(target_os = "macos")]
use crate::domain::shortcuts::shortcut_to_menu_accelerator;

pub(crate) fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let check_for_updates_item =
        MenuItemBuilder::with_id("check_for_updates", "Check for Updates…").build(handle)?;
    let settings_shortcut = shortcut_to_menu_accelerator(
        GlobalSettings::default()
            .shortcuts
            .binding_for("openSettings")
            .unwrap_or("mod+comma"),
    )
    .unwrap_or_else(|| "Cmd+,".to_string());
    let settings_item = MenuItemBuilder::with_id("open_settings", "Settings…")
        .accelerator(settings_shortcut)
        .build(handle)?;
    let close_window_item =
        MenuItemBuilder::with_id("close_window", "Close Window").build(handle)?;

    let app_menu = Submenu::with_items(
        handle,
        APP_NAME,
        true,
        &[
            &check_for_updates_item,
            &settings_item,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &close_window_item,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &edit_menu, &window_menu])
}

pub(crate) fn sync_settings_menu_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    settings: &GlobalSettings,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(item) = menu.get("open_settings") else {
        return Ok(());
    };
    let Some(item) = item.as_menuitem() else {
        return Ok(());
    };
    item.set_accelerator(
        settings
            .shortcuts
            .binding_for("openSettings")
            .and_then(shortcut_to_menu_accelerator),
    )
}

pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "check_for_updates" => emit_menu_event(app, MENU_CHECK_FOR_UPDATES_EVENT_NAME),
        "open_settings" => emit_menu_event(app, MENU_OPEN_SETTINGS_EVENT_NAME),
        "close_window" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        _ => {}
    }
}

fn emit_menu_event<R: Runtime>(app: &AppHandle<R>, event: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(event, ());
    } else {
        let _ = app.emit(event, ());
    }
}
