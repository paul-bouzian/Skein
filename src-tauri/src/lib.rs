mod commands;
mod domain;
mod error;
mod infrastructure;
mod runtime;
mod services;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_target(false).compact().init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let app_state = state::AppState::new(app.handle())?;
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::conversation::open_thread_conversation,
            commands::conversation::refresh_thread_conversation,
            commands::conversation::send_thread_message,
            commands::conversation::interrupt_thread_turn,
            commands::conversation::respond_to_approval_request,
            commands::conversation::respond_to_user_input_request,
            commands::conversation::submit_plan_decision,
            commands::system::get_bootstrap_status,
            commands::system::get_project_icon,
            commands::workspace::get_workspace_snapshot,
            commands::workspace::update_global_settings,
            commands::workspace::add_project,
            commands::workspace::rename_project,
            commands::workspace::remove_project,
            commands::workspace::create_worktree_environment,
            commands::workspace::create_thread,
            commands::workspace::rename_thread,
            commands::workspace::archive_thread,
            commands::workspace::start_environment_runtime,
            commands::workspace::stop_environment_runtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
