// Pruning: raw DOM-derived forest -> pruned forest. Pure, no BiDi. Drops
// noise, hoists wrapper children, collapses redundancy. Mirrors
// packages/mini/src/ax-prune.ts, adapted to an index-based arena.
use crate::snapshot::RawNode;

#[derive(Debug, Clone)]
pub struct PrunedNode {
    pub role: String,
    pub name: String,
    pub description: Option<String>,
    pub value: Option<String>,
    pub state: Vec<String>,
    /// Stable DOM identity (the page-side WeakMap id). `None` for text nodes.
    pub node_id: Option<i64>,
    pub frame_id: String,
    pub ref_: Option<String>,
    pub children: Vec<PrunedNode>,
}

// Roles hoisted away (children pulled up to parent). The wrapper-collapse
// mechanism. RootWebArea/WebArea included: we never want the frame root itself.
const TRANSPARENT: &[&str] = &[
    "RootWebArea",
    "WebArea",
    "none",
    "presentation",
    "generic",
    "GenericContainer",
    "InlineTextBox",
    "LineBreak",
    "paragraph",
    "LayoutTable",
    "LayoutTableRow",
    "LayoutTableCell",
];

// Roles the agent can act on — always kept, always get a ref.
const INTERACTIVE: &[&str] = &[
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "scrollbar",
    "dialog",
    "alertdialog",
];

// Structural / landmark roles — kept for context, not reffed.
const STRUCTURAL: &[&str] = &[
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
    "dialog",
    "alertdialog",
    "alert",
    "status",
    "tablist",
    "menu",
    "menubar",
    "img",
    "figure",
    "blockquote",
];

pub fn is_interactive(role: &str) -> bool {
    INTERACTIVE.contains(&role)
}

fn is_transparent(role: &str) -> bool {
    TRANSPARENT.contains(&role)
}

fn is_structural(role: &str) -> bool {
    STRUCTURAL.contains(&role)
}

enum Fate {
    Keep,
    Hoist,
}

/// Decide a node's fate. `ancestor_name` is the nearest kept ancestor's name,
/// used to drop StaticText that merely echoes its labelled container.
fn classify(node: &RawNode, ancestor_name: &str) -> Fate {
    if node.state.iter().any(|state| state == "ignored") {
        return Fate::Hoist;
    }
    if is_transparent(&node.role) {
        return Fate::Hoist;
    }
    if is_interactive(&node.role) {
        return Fate::Keep;
    }

    if node.role == "StaticText" || node.role == "text" {
        let name = node.name.trim();
        if name.is_empty() {
            return Fate::Hoist;
        }
        if name == ancestor_name.trim() {
            return Fate::Hoist;
        }
        return Fate::Keep;
    }

    if node.role == "group" {
        return if node.name.trim().is_empty() {
            Fate::Hoist
        } else {
            Fate::Keep
        };
    }
    if is_structural(&node.role) {
        return Fate::Keep;
    }

    // Unknown role: keep if it carries a name, else hoist.
    if node.name.trim().is_empty() {
        Fate::Hoist
    } else {
        Fate::Keep
    }
}

fn to_pruned(node: &RawNode) -> PrunedNode {
    let mut name = node.name.clone();
    if (node.role == "StaticText" || node.role == "text") && name.chars().count() > 250 {
        name = name.chars().take(250).collect::<String>() + "... [truncated]";
    }
    PrunedNode {
        role: node.role.clone(),
        name,
        description: if node.description.is_empty() {
            None
        } else {
            Some(node.description.clone())
        },
        value: if node.value.is_empty() {
            None
        } else {
            Some(node.value.clone())
        },
        state: node.state.clone(),
        node_id: if node.id >= 0 { Some(node.id) } else { None },
        frame_id: node.frame_id.clone(),
        ref_: None,
        children: Vec::new(),
    }
}

/// Prune a forest. `nodes` is the flat arena; parent links define the tree.
/// Returns the kept top-level nodes with hoisted descendants attached.
pub fn prune_forest(nodes: &[RawNode]) -> Vec<PrunedNode> {
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut roots: Vec<usize> = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        if node.parent >= 0 && (node.parent as usize) < nodes.len() {
            children[node.parent as usize].push(index);
        } else {
            roots.push(index);
        }
    }
    walk(&roots, nodes, &children, "")
}

fn walk(
    ids: &[usize],
    nodes: &[RawNode],
    children: &[Vec<usize>],
    ancestor_name: &str,
) -> Vec<PrunedNode> {
    let mut out: Vec<PrunedNode> = Vec::new();
    for &index in ids {
        let node = &nodes[index];
        match classify(node, ancestor_name) {
            Fate::Hoist => {
                out.extend(walk(&children[index], nodes, children, ancestor_name));
            }
            Fate::Keep => {
                let mut pruned = to_pruned(node);
                let child_ancestor = if node.name.is_empty() {
                    ancestor_name
                } else {
                    &node.name
                };
                pruned.children = walk(&children[index], nodes, children, child_ancestor);
                out.push(collapse(pruned));
            }
        }
    }
    out
}

/// Collapse a kept node that has exactly one kept child of the same frame and
/// no name of its own — the child is more specific, so promote it.
fn collapse(node: PrunedNode) -> PrunedNode {
    if node.name.trim().is_empty()
        && node.children.len() == 1
        && !is_interactive(&node.role)
        && node.children[0].frame_id == node.frame_id
    {
        return node.children.into_iter().next().unwrap();
    }
    node
}
