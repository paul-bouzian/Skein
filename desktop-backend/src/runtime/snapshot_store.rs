use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;

use crate::domain::conversation::ThreadConversationSnapshot;
use crate::infrastructure::database::AppDatabase;

static SNAPSHOT_STORE: OnceLock<SnapshotStore> = OnceLock::new();

struct SnapshotStore {
    database: AppDatabase,
    queue: Arc<SnapshotQueue>,
}

struct SnapshotQueue {
    pending: Mutex<HashMap<String, ThreadConversationSnapshot>>,
    available: Condvar,
}

pub fn install(database: AppDatabase) {
    let _ = SNAPSHOT_STORE.get_or_init(|| {
        let queue = Arc::new(SnapshotQueue {
            pending: Mutex::new(HashMap::new()),
            available: Condvar::new(),
        });
        let worker_queue = Arc::clone(&queue);
        let worker_database = database.clone();
        thread::Builder::new()
            .name("skein-snapshot-store".to_string())
            .spawn(move || loop {
                let snapshots = {
                    let mut pending = match worker_queue.pending.lock() {
                        Ok(pending) => pending,
                        Err(error) => {
                            tracing::warn!(
                                ?error,
                                "conversation snapshot persistence queue poisoned"
                            );
                            return;
                        }
                    };
                    while pending.is_empty() {
                        pending = match worker_queue.available.wait(pending) {
                            Ok(pending) => pending,
                            Err(error) => {
                                tracing::warn!(
                                    ?error,
                                    "conversation snapshot persistence queue poisoned"
                                );
                                return;
                            }
                        };
                    }
                    pending
                        .drain()
                        .map(|(_, snapshot)| snapshot)
                        .collect::<Vec<_>>()
                };

                for snapshot in snapshots {
                    if let Err(error) = worker_database.save_conversation_snapshot(&snapshot) {
                        tracing::warn!(
                            thread_id = %snapshot.thread_id,
                            ?error,
                            "failed to persist conversation snapshot"
                        );
                    }
                }
            })
            .expect("conversation snapshot persistence worker should start");
        SnapshotStore { database, queue }
    });
}

fn store() -> Option<&'static SnapshotStore> {
    SNAPSHOT_STORE.get()
}

pub fn save(snapshot: &ThreadConversationSnapshot) {
    let Some(store) = store() else {
        return;
    };
    let mut pending = match store.queue.pending.lock() {
        Ok(pending) => pending,
        Err(error) => {
            tracing::warn!(
                thread_id = %snapshot.thread_id,
                ?error,
                "failed to enqueue conversation snapshot persistence"
            );
            return;
        }
    };
    pending.insert(snapshot.thread_id.clone(), snapshot.clone());
    store.queue.available.notify_one();
}

pub fn load(thread_id: &str) -> Option<ThreadConversationSnapshot> {
    let store = store()?;
    match store.database.load_conversation_snapshot(thread_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(
                thread_id,
                ?error,
                "failed to load persisted conversation snapshot"
            );
            None
        }
    }
}
