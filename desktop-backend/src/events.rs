use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::warn;

#[derive(Debug, Clone)]
pub struct EmittedEvent {
    pub name: String,
    pub payload: Value,
}

trait EventTransport: Send + Sync {
    fn emit(&self, event_name: &str, payload: Value) -> Result<(), String>;
}

#[derive(Clone)]
pub struct EventSink(Arc<dyn EventTransport>);

impl std::fmt::Debug for EventSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("EventSink(..)")
    }
}

impl EventSink {
    pub fn noop() -> Self {
        Self(Arc::new(NoopEventTransport))
    }

    pub fn channel(tx: mpsc::UnboundedSender<EmittedEvent>) -> Self {
        Self(Arc::new(ChannelEventTransport { tx }))
    }

    pub fn emit<T: Serialize>(&self, event_name: &str, payload: T) {
        let serialized = match serde_json::to_value(payload) {
            Ok(payload) => payload,
            Err(error) => {
                warn!("failed to serialize event payload for {event_name}: {error}");
                return;
            }
        };

        if let Err(error) = self.0.emit(event_name, serialized) {
            warn!("failed to emit {event_name}: {error}");
        }
    }
}

struct ChannelEventTransport {
    tx: mpsc::UnboundedSender<EmittedEvent>,
}

impl EventTransport for ChannelEventTransport {
    fn emit(&self, event_name: &str, payload: Value) -> Result<(), String> {
        self.tx
            .send(EmittedEvent {
                name: event_name.to_string(),
                payload,
            })
            .map_err(|error| error.to_string())
    }
}

struct NoopEventTransport;

impl EventTransport for NoopEventTransport {
    fn emit(&self, _event_name: &str, _payload: Value) -> Result<(), String> {
        Ok(())
    }
}
