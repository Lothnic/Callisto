// Serialize a pruned, ref-annotated forest to compact indented text — the
// string the model actually reads. Format: `[ref] role "name" {state} =value`.
// Pure. Mirrors packages/mini/src/ax-format.ts.
use crate::prune::{is_interactive, PrunedNode};

const URGENT: &[&str] = &["alert", "status"];
const CONTEXT: &[&str] = &[
    "main",
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
    "region",
    "form",
    "search",
    "article",
    "heading",
    "list",
    "listitem",
    "table",
    "row",
    "cell",
    "columnheader",
    "rowheader",
    "tablist",
    "menu",
    "menubar",
    "img",
    "figure",
    "blockquote",
];

fn line(node: &PrunedNode, depth: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(ref_) = &node.ref_ {
        parts.push(format!("[{ref_}]"));
    }
    parts.push(node.role.clone());
    if !node.name.trim().is_empty() {
        parts.push(format!("\"{}\"", node.name.trim()));
    }
    if !node.state.is_empty() {
        parts.push(format!("{{{}}}", node.state.join(",")));
    }
    if let Some(value) = &node.value {
        if !value.is_empty() {
            parts.push(format!("={value}"));
        }
    }
    format!("{}{}", "  ".repeat(depth), parts.join(" "))
}

fn rank(node: &PrunedNode) -> u8 {
    if is_interactive(&node.role) || node.ref_.is_some() {
        return 0;
    }
    if URGENT.contains(&node.role.as_str()) {
        return 1;
    }
    if CONTEXT.contains(&node.role.as_str()) {
        return 2;
    }
    if node.role == "StaticText" || node.role == "text" {
        return 3;
    }
    4
}

fn ordered(nodes: &[PrunedNode]) -> Vec<&PrunedNode> {
    let mut indexed: Vec<(usize, &PrunedNode)> = nodes.iter().enumerate().collect();
    indexed.sort_by_key(|(index, node)| (rank(node), *index));
    indexed.into_iter().map(|(_, node)| node).collect()
}

pub fn format_tree(forest: &[PrunedNode]) -> String {
    let mut out: Vec<String> = Vec::new();
    for root in ordered(forest) {
        walk(root, 0, &mut out);
    }
    out.join("\n")
}

fn walk(node: &PrunedNode, depth: usize, out: &mut Vec<String>) {
    out.push(line(node, depth));
    for child in ordered(&node.children) {
        walk(child, depth + 1, out);
    }
}
