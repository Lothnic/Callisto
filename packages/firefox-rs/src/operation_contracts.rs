//! One registry defines native tools, compact help and composed-step validation.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::sync::OnceLock;

fn registry() -> &'static Value {
    static REGISTRY: OnceLock<Value> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../extension/operations.json"))
            .expect("valid operation registry")
    })
}

pub fn catalog() -> Value {
    let mut tools = registry()["tools"].clone();
    let mut properties = serde_json::Map::new();
    properties.insert(
        "action".into(),
        json!({"type":"string","enum":registry()["steps"]}),
    );
    let variants: Vec<Value> = registry()["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| {
            let original = contract(op.as_str().unwrap()).unwrap();
            let mut shape = original.clone();
            let fields = shape["properties"].as_object_mut().unwrap();
            // Field types appear once on the step object; variants retain action-
            // specific required fields, allowed fields and locator alternatives.
            for (name, schema) in fields.iter_mut() {
                if let Some(previous) = properties.insert(name.clone(), schema.clone()) {
                    assert_eq!(previous, *schema, "inconsistent composed field {name}");
                }
                *schema = json!({});
            }
            fields.insert("action".into(), json!({"enum":[op]}));
            shape["required"]
                .as_array_mut()
                .unwrap()
                .push(json!("action"));
            shape
        })
        .collect();
    let step_schema =
        json!({"type":"object","properties":properties,"required":["action"],"oneOf":variants});
    for tool in tools.as_array_mut().unwrap() {
        let key = match tool["name"].as_str().unwrap() {
            "callisto_run" => "steps",
            "callisto_batch" => "actions",
            _ => continue,
        };
        tool["inputSchema"]["properties"][key]["items"] = step_schema.clone();
    }
    tools
}
fn contract(op: &str) -> Option<&'static Value> {
    registry()["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == format!("callisto_{op}"))
        .map(|t| &t["inputSchema"])
}

#[derive(Debug)]
pub struct Invalid {
    pub field: String,
    pub expected: String,
}
impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Invalid {}: {}. No browser action dispatched.",
            self.field, self.expected
        )
    }
}
impl std::error::Error for Invalid {}
impl Invalid {
    pub fn details(&self) -> Value {
        json!({"code":"invalid_arguments","field":self.field,"expected":self.expected,"dispatch":"not_dispatched"})
    }
}
fn invalid(path: &str, expected: impl Into<String>) -> anyhow::Error {
    Invalid {
        field: path.into(),
        expected: expected.into(),
    }
    .into()
}

pub fn normalize(name: &str, args: &Value) -> Result<Value> {
    let op = name.strip_prefix("callisto_").unwrap_or(name);
    let schema = contract(op)
        .ok_or_else(|| invalid("operation", format!("unknown operation {op:?}; use help")))?;
    if !args.is_object() {
        return Err(invalid("args", "expected an object"));
    }
    if args.to_string().len() > 200_000 {
        return Err(invalid("args", "maximum encoded size is 200000 bytes"));
    }
    let mut normalized = args.clone();
    alias_value(op, &mut normalized, "args")?;
    if ["run", "batch"].contains(&op) {
        let key = if op == "run" { "steps" } else { "actions" };
        let max = if op == "run" { 40 } else { 10 };
        let path = format!("args.{key}");
        let steps = normalized[key]
            .as_array_mut()
            .ok_or_else(|| invalid(&path, "expected an array"))?;
        if steps.is_empty() || steps.len() > max {
            return Err(invalid(&path, format!("expected 1–{max} steps")));
        }
        // Validate the entire plan before its first step can reach the browser.
        for (index, step) in steps.iter_mut().enumerate() {
            let path = format!("{path}[{index}]");
            let action = step["action"]
                .as_str()
                .ok_or_else(|| invalid(&format!("{path}.action"), "expected an operation name"))?
                .to_owned();
            let canonical = action
                .strip_suffix("_ref")
                .or_else(|| action.strip_suffix("_role"))
                .unwrap_or(&action);
            if !registry()["steps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|op| op == canonical)
            {
                return Err(invalid(
                    &format!("{path}.action"),
                    format!("supported actions: {}", registry()["steps"]),
                ));
            }
            let mut input = step.clone();
            input.as_object_mut().unwrap().remove("action");
            if canonical == "extract" && input.get("spec").is_some() {
                if input.as_object().unwrap().len() != 1 {
                    return Err(invalid(
                        &path,
                        "use extract fields directly or spec, without mixing them",
                    ));
                }
                input = input["spec"].clone();
            }
            alias_value(canonical, &mut input, &path)?;
            validate(contract(canonical).unwrap(), &input, &path)?;
            input["action"] = json!(canonical);
            *step = input;
        }
    }
    validate(schema, &normalized, "args")?;
    Ok(normalized)
}
fn alias_value(op: &str, input: &mut Value, path: &str) -> Result<()> {
    if op == "fill" {
        if let Some(text) = input.get("text").cloned() {
            if input.get("value").is_some_and(|value| value != &text) {
                return Err(invalid(
                    &format!("{path}.value"),
                    "conflicting value and legacy text; use value",
                ));
            }
            input
                .as_object_mut()
                .ok_or_else(|| invalid(path, "expected an object"))?
                .remove("text");
            input["value"] = text;
        }
    }
    Ok(())
}

// Deliberately supports only the JSON Schema vocabulary used by our registry.
// Tests reject unsupported keywords so contract additions cannot silently weaken validation.
fn validate(schema: &Value, value: &Value, path: &str) -> Result<()> {
    if let Some(kind) = schema["type"].as_str() {
        let valid = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(invalid(path, format!("expected {kind}")));
        }
    }
    if let Some(choices) = schema["enum"].as_array() {
        if !choices.contains(value) {
            return Err(invalid(path, format!("expected one of {}", schema["enum"])));
        }
    }
    for (key, exact) in [("anyOf", false), ("oneOf", true)] {
        if let Some(variants) = schema[key].as_array() {
            let matches = variants
                .iter()
                .filter(|s| validate(s, value, path).is_ok())
                .count();
            if matches == 0 || (exact && matches != 1) {
                return Err(invalid(
                    path,
                    format!(
                        "expected {} matching form: {}",
                        if exact { "exactly one" } else { "a" },
                        schema[key]
                    ),
                ));
            }
        }
    }
    if let Some(object) = value.as_object() {
        for field in schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(field) {
                return Err(invalid(
                    &format!("{path}.{field}"),
                    "required field is missing",
                ));
            }
        }
        for (field, input) in object {
            if let Some(child) = schema["properties"].get(field) {
                validate(child, input, &format!("{path}.{field}"))?;
            } else if schema["additionalProperties"] == false {
                return Err(invalid(
                    &format!("{path}.{field}"),
                    format!(
                        "unknown field; accepted fields: {}",
                        schema["properties"]
                            .as_object()
                            .map(|p| p.keys().cloned().collect::<Vec<_>>().join(", "))
                            .unwrap_or_default()
                    ),
                ));
            } else if schema["additionalProperties"].is_object() {
                validate(
                    &schema["additionalProperties"],
                    input,
                    &format!("{path}.{field}"),
                )?;
            }
        }
        bounds(
            schema,
            object.len() as f64,
            path,
            "minProperties",
            "maxProperties",
        )?;
    }
    if let Some(items) = value.as_array() {
        bounds(schema, items.len() as f64, path, "minItems", "maxItems")?;
        if schema.get("items").is_some() {
            for (i, item) in items.iter().enumerate() {
                validate(&schema["items"], item, &format!("{path}[{i}]"))?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        bounds(
            schema,
            text.chars().count() as f64,
            path,
            "minLength",
            "maxLength",
        )?;
        if let Some(pattern) = schema["pattern"].as_str() {
            if pattern != "^ax-[0-9]+$" {
                bail!("Unsupported registry pattern {pattern}");
            }
            if !text
                .strip_prefix("ax-")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            {
                return Err(invalid(path, "expected a snapshot ref such as ax-123"));
            }
        }
    }
    if let Some(number) = value.as_f64() {
        bounds(schema, number, path, "minimum", "maximum")?;
    }
    Ok(())
}
fn bounds(schema: &Value, actual: f64, path: &str, low: &str, high: &str) -> Result<()> {
    if schema[low].as_f64().is_some_and(|n| actual < n)
        || schema[high].as_f64().is_some_and(|n| actual > n)
    {
        return Err(invalid(
            path,
            format!("{low}={}, {high}={}", schema[low], schema[high]),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_agent_mistakes_are_normalized_or_rejected_before_dispatch() {
        assert_eq!(
            normalize("callisto_fill", &json!({"ref":"ax-1","text":"hello"})).unwrap()["value"],
            "hello"
        );
        let run=normalize("callisto_run",&json!({"steps":[{"action":"fill_ref","ref":"ax-1","text":"hello"},{"action":"select","ref":"ax-2","value":"Title"}]})).unwrap();
        assert_eq!(
            run["steps"][0],
            json!({"action":"fill","ref":"ax-1","value":"hello"})
        );
        for (name, args, field) in [
            (
                "callisto_run",
                json!({"steps":[{"action":"click","ref":"ax-1"},{"action":"fill","ref":"ax-2"}]}),
                "steps[1].value",
            ),
            ("callisto_snapshot", json!({"offset":10800}), "offset"),
            (
                "callisto_fill",
                json!({"ref":"ax-1","value":"a","text":"b"}),
                "value",
            ),
            (
                "callisto_run",
                json!({"steps":[{"action":"wat"}]}),
                "action",
            ),
        ] {
            let error = normalize(name, &args).unwrap_err();
            assert!(error.to_string().contains(field), "{error}");
            assert_eq!(
                error.downcast_ref::<Invalid>().unwrap().details()["dispatch"],
                "not_dispatched"
            );
        }
    }
    #[test]
    fn standalone_and_step_schemas_share_the_same_contract() {
        let catalog = catalog();
        let run = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "callisto_run")
            .unwrap();
        for variant in run["inputSchema"]["properties"]["steps"]["items"]["oneOf"]
            .as_array()
            .unwrap()
        {
            let op = variant["properties"]["action"]["enum"][0].as_str().unwrap();
            let mut original = variant.clone();
            original["properties"]
                .as_object_mut()
                .unwrap()
                .remove("action");
            original["required"]
                .as_array_mut()
                .unwrap()
                .retain(|v| v != "action");
            for (name, schema) in original["properties"].as_object_mut().unwrap() {
                *schema =
                    run["inputSchema"]["properties"]["steps"]["items"]["properties"][name].clone();
            }
            assert_eq!(&original, contract(op).unwrap());
        }
    }
    #[test]
    fn shared_step_types_keep_action_specific_requirements() {
        let catalog = catalog();
        let schema = &catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "callisto_run")
            .unwrap()["inputSchema"]["properties"]["steps"]["items"];
        assert!(validate(
            schema,
            &json!({"action":"fill","ref":"ax-1","value":"hello"}),
            "step"
        )
        .is_ok());
        for invalid in [
            json!({"action":"fill","ref":"ax-1"}),
            json!({"action":"click","ref":"ax-1","value":"ignored"}),
            json!({"action":"wait","ms":"10"}),
            json!({"action":"fill","ref":"ax-1","role":"textbox","name":"Name","value":"x"}),
        ] {
            assert!(validate(schema, &invalid, "step").is_err());
        }
    }

    #[test]
    fn registry_uses_only_validated_schema_keywords() {
        fn walk(schema: &Value) {
            for (key, value) in schema.as_object().unwrap() {
                assert!(
                    [
                        "type",
                        "properties",
                        "required",
                        "additionalProperties",
                        "oneOf",
                        "anyOf",
                        "enum",
                        "items",
                        "minLength",
                        "maxLength",
                        "minimum",
                        "maximum",
                        "minItems",
                        "maxItems",
                        "minProperties",
                        "maxProperties",
                        "pattern",
                        "description",
                        "default"
                    ]
                    .contains(&key.as_str()),
                    "unsupported {key}"
                );
                match key.as_str() {
                    "properties" => {
                        for s in value.as_object().unwrap().values() {
                            walk(s)
                        }
                    }
                    "items" => walk(value),
                    "additionalProperties" if value.is_object() => walk(value),
                    "oneOf" | "anyOf" => {
                        for s in value.as_array().unwrap() {
                            walk(s)
                        }
                    }
                    _ => {}
                }
            }
        }
        for tool in catalog().as_array().unwrap() {
            walk(&tool["inputSchema"]);
        }
    }
}
