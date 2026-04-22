mod app_identity;
mod commands;
mod domain;
mod error;
mod events;
mod infrastructure;
mod runtime;
mod serde_helpers;
mod services;
mod sidecar;
mod state;

pub fn run_sidecar() {
    sidecar::run();
}
