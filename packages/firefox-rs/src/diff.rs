// Compact snapshot diffs for repeated perception turns. Diffs are keyed by
// stable ax-N refs, so unchanged context disappears and critical new/changed
// interactive nodes stay upfront. Mirrors packages/mini/src/ax-diff.ts.
use std::collections::HashMap;

struct RefLine {
    ref_: String,
    line: String,
}

fn display_line(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let ref_ = &rest[..end];
            if is_ref(ref_) {
                let after = &rest[end + 1..];
                if let Some(text) = after.strip_prefix(' ') {
                    return format!("{ref_} {text}");
                }
            }
        }
    }
    trimmed.to_string()
}

fn is_ref(value: &str) -> bool {
    match value.strip_prefix("ax-") {
        Some(digits) => !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

fn ref_lines(text: &str) -> Vec<RefLine> {
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Some(open) = line.find('[') else {
            continue;
        };
        let rest = &line[open + 1..];
        let Some(end) = rest.find(']') else {
            continue;
        };
        let ref_ = &rest[..end];
        if !is_ref(ref_) {
            continue;
        }
        out.push(RefLine {
            ref_: ref_.to_string(),
            line: line.to_string(),
        });
    }
    out
}

fn tag(label: &str, line: &str) -> String {
    format!("{:<9} {}", label, display_line(line))
}

pub fn format_diff(previous: Option<&str>, current: &str) -> String {
    let Some(previous) = previous else {
        return current.to_string();
    };

    let prev = ref_lines(previous);
    let next = ref_lines(current);
    let prev_by_ref: HashMap<&str, &str> = prev
        .iter()
        .map(|item| (item.ref_.as_str(), item.line.as_str()))
        .collect();
    let next_by_ref: HashMap<&str, ()> = next.iter().map(|item| (item.ref_.as_str(), ())).collect();

    let mut out: Vec<String> = Vec::new();
    for item in &next {
        match prev_by_ref.get(item.ref_.as_str()) {
            None => out.push(tag("[new]", &item.line)),
            Some(old) if *old != item.line => out.push(tag("[changed]", &item.line)),
            Some(_) => {}
        }
    }
    for item in &prev {
        if !next_by_ref.contains_key(item.ref_.as_str()) {
            out.push(tag("[removed]", &item.line));
        }
    }

    if out.is_empty() {
        "[unchanged]".to_string()
    } else {
        out.join("\n")
    }
}
