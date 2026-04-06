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
    runtime::codex_paths::sync_process_path_from_login_shell();

    tracing_subscriber::fmt()
        .with_target(false)
        .compact()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            commands::voice::get_environment_voice_status,
            commands::voice::transcribe_environment_voice,
            commands::workspace::get_workspace_snapshot,
            commands::workspace::update_global_settings,
            commands::workspace::add_project,
            commands::workspace::rename_project,
            commands::workspace::update_project_settings,
            commands::workspace::remove_project,
            commands::workspace::create_managed_worktree,
            commands::workspace::delete_worktree_environment,
            commands::workspace::create_thread,
            commands::workspace::rename_thread,
            commands::workspace::archive_thread,
            commands::workspace::start_environment_runtime,
            commands::workspace::stop_environment_runtime,
            commands::workspace::get_environment_codex_rate_limits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
