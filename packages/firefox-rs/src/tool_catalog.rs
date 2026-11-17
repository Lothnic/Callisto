//! A small per-client interface over the existing, fully validated tool handlers.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    Compact,
    Full,
}
impl Profile {
    pub fn from_env() -> Result<Self> {
        match std::env::var("CALLISTO_TOOL_PROFILE").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("compact") => Ok(Self::Compact),
            Ok("full") => Ok(Self::Full),
            _ => bail!("CALLISTO_TOOL_PROFILE must be compact or full"),
        }
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
        "description":"Control Firefox/Zen through its shared tab. Pass operation fields in args. Start with status or pair. Navigate: {op:'navigate',args:{url:'https://example.com'}}. Observe: {op:'snapshot',args:{max_chars:6000}}. Act: {op:'run',args:{steps:[{action:'click_ref',ref:'ax-1'}],snapshot:false}}. Get any operation's parameters with {op:'help',args:{op:'run'}}. Use run for dependent actions and extract for rows. Existing sharing, permissions, input mode and cancellation apply. Inspect after uncertain errors before retrying.",
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
