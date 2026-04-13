mod app_identity;
mod commands;
mod domain;
mod error;
mod infrastructure;
#[cfg(target_os = "macos")]
mod menu;
mod runtime;
mod services;
mod state;

use tauri::{Manager, RunEvent};
use tracing::warn;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    runtime::codex_paths::sync_process_path_from_login_shell();

    tracing_subscriber::fmt()
        .with_target(false)
        .compact()
        .init();

    #[cfg(target_os = "macos")]
    let builder = tauri::Builder::default()
        .on_menu_event(menu::handle_menu_event)
        .enable_macos_default_menu(false)
        .menu(menu::build_menu);

    #[cfg(not(target_os = "macos"))]
    let builder = tauri::Builder::default();

    let app = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Err(error) = app_identity::best_effort_rename_installed_bundle() {
                warn!("failed to rename installed Skein bundle during startup: {error}");
            }

            let app_state = state::AppState::new(app.handle())?;
            #[cfg(target_os = "macos")]
            if let Err(error) = menu::sync_settings_menu_shortcut(
                app.handle(),
                &app_state.workspace.current_settings()?,
            ) {
                warn!("failed to sync settings menu shortcut during startup: {error}");
            }
            app.manage(app_state);
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(runtime::supervisor::RUNTIME_IDLE_REAPER_INTERVAL).await;
                    let Some(state) = app_handle.try_state::<state::AppState>() else {
                        continue;
                    };
                    if let Err(error) = state
                        .runtime
                        .evict_idle_runtimes(runtime::supervisor::RUNTIME_IDLE_TIMEOUT)
                        .await
                    {
                        warn!("failed to evict idle runtimes: {error}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::conversation::open_thread_conversation,
            commands::conversation::save_thread_composer_draft,
            commands::conversation::refresh_thread_conversation,
            commands::conversation::get_thread_composer_catalog,
            commands::conversation::search_thread_files,
            commands::conversation::send_thread_message,
            commands::conversation::interrupt_thread_turn,
            commands::conversation::respond_to_approval_request,
            commands::conversation::respond_to_user_input_request,
            commands::conversation::submit_plan_decision,
            commands::git_review::get_git_review_snapshot,
            commands::git_review::get_git_file_diff,
            commands::git_review::stage_git_file,
            commands::git_review::stage_git_all,
            commands::git_review::unstage_git_file,
            commands::git_review::unstage_git_all,
            commands::git_review::revert_git_file,
            commands::git_review::revert_git_all,
            commands::git_review::commit_git,
            commands::git_review::fetch_git,
            commands::git_review::pull_git,
            commands::git_review::push_git,
            commands::git_review::generate_git_commit_message,
            commands::system::get_bootstrap_status,
            commands::system::get_project_icon,
            commands::system::read_image_as_data_url,
            commands::system::restart_app,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::voice::get_environment_voice_status,
            commands::voice::transcribe_environment_voice,
            commands::workspace::get_workspace_snapshot,
            commands::workspace::get_shortcut_defaults,
            commands::workspace::update_global_settings,
            commands::workspace::add_project,
            commands::workspace::rename_project,
            commands::workspace::update_project_settings,
            commands::workspace::reorder_projects,
            commands::workspace::reorder_worktree_environments,
            commands::workspace::set_project_sidebar_collapsed,
            commands::workspace::ensure_project_can_be_removed,
            commands::workspace::remove_project,
            commands::workspace::create_managed_worktree,
            commands::workspace::delete_worktree_environment,
            commands::workspace::create_thread,
            commands::workspace::rename_thread,
            commands::workspace::archive_thread,
            commands::workspace::start_environment_runtime,
            commands::workspace::stop_environment_runtime,
            commands::workspace::touch_environment_runtime,
            commands::workspace::get_environment_codex_rate_limits,
            commands::workspace::open_environment,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<state::AppState>() {
                state.terminal.shutdown_all();
            }
        }
    });
}
