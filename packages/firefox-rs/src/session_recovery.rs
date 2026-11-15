//! Preserve input intent in the surviving stdio proxy, without replaying commands.
use serde_json::{json, Value};

#[derive(Default)]
pub struct Policy {
    trusted_requested: bool,
    choice_required: bool,
}
impl Policy {
    pub fn disconnected(&mut self) {
        self.choice_required |= self.trusted_requested;
    }
    pub fn request(&mut self, message: &Value) -> Option<Value> {
        if message["method"] != "tools/call" {
            return None;
        }
        let name = message["params"]["name"].as_str().unwrap_or("");
        let args = &message["params"]["arguments"];
        if name == "callisto_input" && args["action"] == "enable" {
            self.trusted_requested = true;
        }
        let input = matches!(
            name,
            "callisto_click"
                | "callisto_fill"
                | "callisto_press"
                | "callisto_submit"
                | "callisto_run"
                | "callisto_batch"
                | "callisto_extract"
        ) || (name == "callisto_page"
            && matches!(args["action"].as_str(), Some("hover" | "check" | "select")));
        if self.choice_required && input {
            return Some(
                json!({"jsonrpc":"2.0","id":message["id"],"result":{"isError":true,"content":[{"type":"text","text":"Trusted input needs re-enabling after relay restart. Share the intended tab, then call callisto_input enable with its explicit endpoint, or explicitly disable trusted input. This action was not dispatched."}]}}),
            );
        }
        None
    }
    pub fn response(&mut self, request: &Value, response: &mut Value) {
        let name = request["params"]["name"].as_str().unwrap_or("");
        let action = request["params"]["arguments"]["action"]
            .as_str()
            .unwrap_or("");
        let success = response.get("error").is_none() && response["result"]["isError"] != true;
        if name == "callisto_input" && success && matches!(action, "enable" | "disable") {
            self.trusted_requested = action == "enable";
            self.choice_required = false;
        }
        if !self.choice_required || !success {
            return;
        }
        if matches!(name, "callisto_status" | "callisto_capabilities")
            || (name == "callisto_input" && action == "status")
        {
            if let Some(text) = response["result"]["content"][0]["text"].as_str() {
                if let Ok(mut value) = serde_json::from_str::<Value>(text) {
                    let state = json!({"mode":"trusted-recovery-required","inputRecoveryRequired":true,"transportConnected":false,"leaseBound":false,"fallback":false});
                    if name == "callisto_input" {
                        value = state;
                    } else {
                        value["input"] = state;
                    }
                    response["result"]["content"][0]["text"] = json!(value.to_string());
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(name: &str, action: &str) -> Value {
        json!({"id":7,"method":"tools/call","params":{"name":name,"arguments":{"action":action}}})
    }
    #[test]
    fn restart_does_not_downgrade_or_replay_input() {
        let mut policy = Policy::default();
        let enable = request("callisto_input", "enable");
        policy.request(&enable);
        policy.disconnected();
        assert!(policy.request(&request("callisto_fill", "")).is_some());
        assert!(policy.request(&request("callisto_snapshot", "")).is_none());
        let mut failed = json!({"result":{"isError":true}});
        policy.response(&enable, &mut failed);
        assert!(policy.request(&request("callisto_click", "")).is_some());
        let mut ok = json!({"result":{"content":[{"type":"text","text":"{}"}]}});
        policy.response(&request("callisto_status", ""), &mut ok);
        assert!(ok.to_string().contains("trusted-recovery-required"));
        policy.response(
            &request("callisto_input", "disable"),
            &mut json!({"result":{}}),
        );
        assert!(policy.request(&request("callisto_click", "")).is_none());
    }
}
