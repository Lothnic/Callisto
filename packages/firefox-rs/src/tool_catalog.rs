//! A small per-client interface over the existing, fully validated tool handlers.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    Compact,
    Full,
}
impl Profile {
    pub fn for_client(client: Option<&str>) -> Result<Self> {
        Self::select(
            std::env::var("CALLISTO_TOOL_PROFILE").ok().as_deref(),
            client,
        )
    }
    fn select(setting: Option<&str>, client: Option<&str>) -> Result<Self> {
        match setting {
            None | Some("auto") => Ok(
                if client.is_some_and(|name| name.to_ascii_lowercase().contains("opencode")) {
                    Self::Full
                } else {
                    Self::Compact
                },
            ),
            Some("compact") => Ok(Self::Compact),
            Some("full" | "native") => Ok(Self::Full),
            _ => bail!("CALLISTO_TOOL_PROFILE must be auto, compact, native or full"),
        }
    }
}

pub fn instructions(profile: Profile) -> &'static str {
    if profile == Profile::Full {
        "Callisto controls Firefox/Zen through the extension's tab lease. Compose named tools in the host's Code Mode when available. Inspect once, perform dependent actions with run, and extract only needed fields. Standalone and run actions share fields: fill uses value; targets use ref or exact role and name. Prefer bounded wait_for conditions over polling and submit over synthetic Enter. Action feedback identifies the document and navigation state; snapshot supports focus, scoped diff and pagination. Never repeat an uncertain write: inspect first. Tool selection does not grant browser permissions."
    } else {
        "Call callisto with {op,args}. Use run for dependent actions and extract for typed rows. Run steps use the same names and fields as standalone operations: {action:'fill',ref:'ax-123',value:'text'}. Prefer wait_for over polling. Use help for one operation's contract, not the full catalog. Observe with focused snapshots or scoped diff. Never repeat an uncertain write: inspect first. Existing tab sharing and permissions apply."
    }
}

pub fn advertised(full: &Value, profile: Profile) -> Value {
    if profile == Profile::Full {
        return full.clone();
    }
    let mut operations = vec![json!("help")];
    operations.extend(full.as_array().unwrap().iter().map(|tool| {
        json!(tool["name"]
            .as_str()
            .unwrap()
            .strip_prefix("callisto_")
            .unwrap())
    }));
    json!([{
        "name":"callisto",
        "description":"Control Firefox/Zen through its shared tab. Pass operation fields in args. Start with status or pair. Navigate: {op:'navigate',args:{url:'https://example.com'}}. Observe: {op:'snapshot',args:{max_chars:6000}}. Act: {op:'run',args:{steps:[{action:'click',ref:'ax-1'}],snapshot:false}}. Get any operation's parameters with {op:'help',args:{op:'run'}}. Use run for dependent actions and extract for rows. Existing sharing, permissions, input mode and cancellation apply. Inspect after uncertain errors before retrying.",
        "inputSchema":{
            "type":"object",
            "properties":{
                "op":{"type":"string","enum":operations},
                "args":{"type":"object"}
            },
            "required":["op"],
            "additionalProperties":false
        }
    }])
}

pub enum Dispatch {
    Help(Value),
    Forward { name: String, arguments: Value },
}

pub fn dispatch(full: &Value, envelope: &Value) -> Result<Dispatch> {
    let object = envelope
        .as_object()
        .ok_or_else(|| anyhow!("callisto expects an object with op and optional args"))?;
    if object.keys().any(|key| key != "op" && key != "args") {
        bail!("Pass operation fields inside args. Example: {{op:'navigate',args:{{url:'https://example.com'}}}}");
    }
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("op is required; use op=help to list operations"))?;
    let arguments = object.get("args").cloned().unwrap_or(json!({}));
    if !arguments.is_object() {
        bail!("args must be an object");
    }
    if op == "help" {
        if arguments.as_object().unwrap().keys().any(|key| key != "op") {
            bail!("help accepts only args.op");
        }
        if let Some(requested) = arguments.get("op") {
            let requested = requested
                .as_str()
                .ok_or_else(|| anyhow!("help args.op must be a string"))?;
            let tool = lookup(full, requested)?;
            return Ok(Dispatch::Help(json!({
                "op":requested,
                "description":tool["description"].as_str().unwrap_or("").replace("callisto_", ""),
                "args_schema":tool["inputSchema"]
            })));
        }
        return Ok(Dispatch::Help(json!({
            "operations":full.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().trim_start_matches("callisto_")).collect::<Vec<_>>(),
            "usage":"Call {op:'help',args:{op:'operation'}} for one contract; execute it with {op:'operation',args:{...}}. run composes dependent page actions. Help never reads browser content."
        })));
    }
    let tool = lookup(full, op)?;
    Ok(Dispatch::Forward {
        name: tool["name"].as_str().unwrap().to_owned(),
        arguments,
    })
}

fn lookup<'a>(full: &'a Value, op: &str) -> Result<&'a Value> {
    let name = format!("callisto_{op}");
    full.as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == name)
        .ok_or_else(|| anyhow!("Unknown operation {op:?}; use op=help to list operations"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{session_recovery, tools};

    #[test]
    fn host_selection_is_per_client_and_explicit_settings_win() {
        assert_eq!(
            Profile::select(None, Some("OpenCode/1.0")).unwrap(),
            Profile::Full
        );
        assert_eq!(
            Profile::select(None, Some("codex")).unwrap(),
            Profile::Compact
        );
        assert_eq!(
            Profile::select(Some("compact"), Some("opencode")).unwrap(),
            Profile::Compact
        );
        assert_eq!(
            Profile::select(Some("native"), Some("codex")).unwrap(),
            Profile::Full
        );
        assert!(Profile::select(Some("invalid"), None).is_err());
    }

    #[test]
    fn compact_catalog_is_bounded_and_full_catalog_is_unchanged() {
        let full = tools();
        let compact = advertised(&full, Profile::Compact);
        assert_eq!(compact.as_array().unwrap().len(), 1);
        assert_eq!(compact[0]["name"], "callisto");
        assert!(compact.to_string().len() < 1800);
        assert!(compact.to_string().len() * 8 < full.to_string().len());
        assert_eq!(advertised(&full, Profile::Full), full);
    }

    #[test]
    fn every_advertised_operation_resolves_to_its_original_contract() {
        let full = tools();
        for tool in full.as_array().unwrap() {
            let op = tool["name"]
                .as_str()
                .unwrap()
                .strip_prefix("callisto_")
                .unwrap();
            let Dispatch::Help(help) =
                dispatch(&full, &json!({"op":"help","args":{"op":op}})).unwrap()
            else {
                panic!("expected contract")
            };
            assert_eq!(help["args_schema"], tool["inputSchema"]);
            let args = json!({"fixture":"unchanged"});
            let Dispatch::Forward { name, arguments } =
                dispatch(&full, &json!({"op":op,"args":args})).unwrap()
            else {
                panic!("expected native dispatch")
            };
            assert_eq!(name, tool["name"].as_str().unwrap());
            assert_eq!(arguments, args);
        }
    }

    #[test]
    fn discovery_does_not_dump_every_schema_and_rejects_invalid_envelopes() {
        let full = tools();
        let Dispatch::Help(index) = dispatch(&full, &json!({"op":"help"})).unwrap() else {
            panic!("expected index")
        };
        assert!(index.to_string().len() < 1000);
        assert!(!index.to_string().contains("inputSchema"));
        for args in [
            json!(null),
            json!({}),
            json!({"op":"run","args":[]}),
            json!({"op":"navigate","url":"https://example.com"}),
            json!({"op":"callisto_status"}),
            json!({"op":"help","args":{"op":3}}),
            json!({"op":"help","args":{"op":"unknown"}}),
        ] {
            assert!(
                dispatch(&full, &args).is_err(),
                "accepted invalid envelope {args}"
            );
        }
    }

    #[test]
    fn canonical_dispatch_keeps_the_trusted_recovery_guard() {
        let mut policy = session_recovery::Policy::default();
        let request = |op: &str, args: Value| {
            let Dispatch::Forward { name, arguments } =
                dispatch(&tools(), &json!({"op":op,"args":args})).unwrap()
            else {
                panic!("expected forward")
            };
            json!({"id":42,"method":"tools/call","params":{"name":name,"arguments":arguments}})
        };
        policy.request(&request(
            "input",
            json!({"action":"enable","endpoint":"ws://127.0.0.1:1234"}),
        ));
        policy.disconnected();
        let reply = policy
            .request(&request(
                "run",
                json!({"steps":[{"action":"click_ref","ref":"ax-1"}]}),
            ))
            .unwrap();
        assert_eq!(reply["result"]["isError"], true);
        assert!(reply.to_string().contains("not dispatched"));
        assert!(policy.request(&request("status", json!({}))).is_none());
    }
}
