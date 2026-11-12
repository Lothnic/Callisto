// Ref allocation + remap. Refs are stable by page-side DOM identity: the same
// element gets the same `ax-N` for the life of the page, so refs survive clicks
// and state changes without re-allocation. Mirrors packages/mini/src/ax-refs.ts.
use anyhow::{bail, Result};
use std::collections::{HashMap, HashSet};

use crate::prune::{is_interactive, PrunedNode};

#[derive(Debug, Clone)]
pub struct RefInfo {
    pub ref_: String,
    pub node_id: i64,
    pub role: String,
    pub name: String,
    pub frame_id: String,
}

#[derive(Default)]
pub struct RefRegistry {
    by_node: HashMap<i64, RefInfo>,
    by_ref: HashMap<String, RefInfo>,
    current: HashSet<String>,
    next: usize,
}

impl RefRegistry {
    pub fn new() -> Self {
        Self {
            next: 1,
            ..Default::default()
        }
    }

    /// Drop document-local references without reusing their identifiers.
    pub fn reset(&mut self) {
        self.by_node.clear();
        self.by_ref.clear();
        self.current.clear();
    }

    /// Stable ref for a DOM node — allocated once, reused thereafter.
    fn intern(&mut self, node_id: i64, role: &str, name: &str, frame_id: &str) -> String {
        if let Some(existing) = self.by_node.get_mut(&node_id) {
            existing.role = role.to_string();
            existing.name = name.to_string();
            return existing.ref_.clone();
        }
        let ref_ = format!("ax-{}", self.next);
        self.next += 1;
        let info = RefInfo {
            ref_: ref_.clone(),
            node_id,
            role: role.to_string(),
            name: name.to_string(),
            frame_id: frame_id.to_string(),
        };
        self.by_node.insert(node_id, info.clone());
        self.by_ref.insert(ref_.clone(), info);
        ref_
    }

    /// Walk a pruned forest and stamp `ref` onto every interactive, DOM-backed
    /// node. Mutates in place.
    pub fn annotate(&mut self, forest: &mut [PrunedNode]) {
        self.current.clear();
        for node in forest.iter_mut() {
            self.visit(node);
        }
    }

    fn visit(&mut self, node: &mut PrunedNode) {
        if is_interactive(&node.role) {
            if let Some(node_id) = node.node_id {
                let ref_ = self.intern(node_id, &node.role, &node.name, &node.frame_id);
                self.current.insert(ref_.clone());
                node.ref_ = Some(ref_);
            }
        }
        for child in node.children.iter_mut() {
            self.visit(child);
        }
    }

    pub fn get(&self, ref_: &str) -> Option<&RefInfo> {
        self.by_ref.get(ref_)
    }

    /// Find a live ref by role and/or accessible name. Errors on ambiguity.
    pub fn find(
        &self,
        role: Option<&str>,
        name: Option<&str>,
        exact: bool,
    ) -> Result<Option<&RefInfo>> {
        let role = role.map(|value| value.to_lowercase());
        let candidates: Vec<&RefInfo> = self
            .by_ref
            .values()
            .filter(|info| self.current.contains(&info.ref_))
            .filter(|info| match &role {
                Some(role) => info.role.to_lowercase() == *role,
                None => true,
            })
            .filter(|info| matches_name(&info.name, name, exact))
            .collect();
        if candidates.len() > 1 {
            bail!(
                "locator matched {} elements; refine the role or name",
                candidates.len()
            );
        }
        Ok(candidates.into_iter().next())
    }

    /// Heuristic remap for a stale ref: another live ref with same role+name.
    pub fn remap(&self, ref_: &str) -> Option<&RefInfo> {
        let stale = self.by_ref.get(ref_)?;
        self.by_ref
            .values()
            .find(|info| info.ref_ != ref_ && info.role == stale.role && info.name == stale.name)
    }
}

fn matches_name(actual: &str, expected: Option<&str>, exact: bool) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let a = actual.trim();
    let e = expected.trim();
    if exact {
        return a == e;
    }
    if a == e {
        return true;
    }
    a.to_lowercase().contains(&e.to_lowercase())
}
