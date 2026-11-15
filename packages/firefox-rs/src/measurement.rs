//! Counts content size and runtime work without recording content or guessing tokens.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Default, Serialize)]
pub struct Totals {
    pub calls: u64,
    pub failures: u64,
    pub elapsed_ms: u128,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub observation_chars: u64,
}
#[derive(Default, Serialize)]
pub struct Metrics {
    pub total: Totals,
    pub by_tool: BTreeMap<String, Totals>,
}
#[derive(Serialize)]
pub struct Sample {
    pub elapsed_ms: u128,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub observation_chars: u64,
    pub snapshot_diff: bool,
    pub snapshot_truncated: bool,
    pub failed: bool,
}
impl Metrics {
    pub fn record(
        &mut self,
        tool: &str,
        args: &Value,
        result: Option<&Value>,
        elapsed_ms: u128,
    ) -> Sample {
        let snapshot = result.and_then(|r| r.get("snapshot").or_else(|| r.get("text").map(|_| r)));
        let observation_chars = snapshot
            .and_then(|s| s["text"].as_str())
            .map(|s| s.chars().count() as u64)
            .unwrap_or(0);
        let sample = Sample {
            elapsed_ms,
            request_bytes: args.to_string().len() as u64,
            response_bytes: result.map(|r| r.to_string().len() as u64).unwrap_or(0),
            observation_chars,
            snapshot_diff: snapshot.is_some_and(|s| s["diff"] == true),
            snapshot_truncated: snapshot
                .is_some_and(|s| s["truncated"] == true || s["capture_truncated"] == true),
            failed: result.is_none(),
        };
        for total in [
            &mut self.total,
            self.by_tool.entry(tool.into()).or_default(),
        ] {
            total.calls += 1;
            total.failures += u64::from(sample.failed);
            total.elapsed_ms += sample.elapsed_ms;
            total.request_bytes += sample.request_bytes;
            total.response_bytes += sample.response_bytes;
            total.observation_chars += sample.observation_chars;
        }
        sample
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sizes_are_utf8_bytes_and_characters_without_content() {
        let mut metrics = Metrics::default();
        let sample = metrics.record(
            "callisto_snapshot",
            &json!({}),
            Some(&json!({"text":"秘密🚀","diff":true})),
            5,
        );
        assert_eq!(sample.observation_chars, 3);
        assert!(sample.response_bytes > 3);
        let serialized = serde_json::to_string(&metrics).unwrap();
        assert!(!serialized.contains("秘密"));
        assert!(!serialized.contains("token"));
    }
}
