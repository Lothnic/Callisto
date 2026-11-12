// Keyboard translation for WebDriver BiDi.
//
// BiDi has no virtual-keycode channel: `input.performActions` key sources take
// the WebDriver key *value*, which is a single grapheme — printable characters
// are themselves, control keys use the private-use WebDriver codes below.
use anyhow::{bail, Result};

pub const ENTER: &str = "\u{E007}";
pub const TAB: &str = "\u{E004}";
pub const ESCAPE: &str = "\u{E00C}";
pub const BACKSPACE: &str = "\u{E003}";
pub const DELETE: &str = "\u{E017}";
pub const ARROW_LEFT: &str = "\u{E012}";
pub const ARROW_UP: &str = "\u{E013}";
pub const ARROW_RIGHT: &str = "\u{E014}";
pub const ARROW_DOWN: &str = "\u{E015}";
pub const HOME: &str = "\u{E011}";
pub const END: &str = "\u{E010}";
pub const PAGE_UP: &str = "\u{E00E}";
pub const PAGE_DOWN: &str = "\u{E00F}";
pub const INSERT: &str = "\u{E016}";
pub const SPACE: &str = "\u{E00D}";
pub const SHIFT: &str = "\u{E008}";
pub const CONTROL: &str = "\u{E009}";
pub const ALT: &str = "\u{E00A}";
pub const META: &str = "\u{E03D}";

/// WebDriver key value for a named key, or `None` for unknown names.
pub fn named(name: &str) -> Option<&'static str> {
    Some(match name {
        "Enter" => ENTER,
        "Tab" => TAB,
        "Escape" => ESCAPE,
        "Backspace" => BACKSPACE,
        "Delete" => DELETE,
        "ArrowLeft" => ARROW_LEFT,
        "ArrowUp" => ARROW_UP,
        "ArrowRight" => ARROW_RIGHT,
        "ArrowDown" => ARROW_DOWN,
        "Home" => HOME,
        "End" => END,
        "PageUp" => PAGE_UP,
        "PageDown" => PAGE_DOWN,
        "Insert" => INSERT,
        "Space" => SPACE,
        "Shift" => SHIFT,
        "Control" => CONTROL,
        "Alt" => ALT,
        "Meta" => META,
        "F1" => "\u{E031}",
        "F2" => "\u{E032}",
        "F3" => "\u{E033}",
        "F4" => "\u{E034}",
        "F5" => "\u{E035}",
        "F6" => "\u{E036}",
        "F7" => "\u{E037}",
        "F8" => "\u{E038}",
        "F9" => "\u{E039}",
        "F10" => "\u{E03A}",
        "F11" => "\u{E03B}",
        "F12" => "\u{E03C}",
        _ => return None,
    })
}

fn alias(part: &str) -> &str {
    match part {
        "Ctrl" => "Control",
        "Cmd" | "Command" => "Meta",
        "Esc" => "Escape",
        " " => "Space",
        other => other,
    }
}

/// Split a chord such as `Control+A` into modifier key values and the main key
/// value. Printable single-character keys pass through unchanged.
pub fn parse_chord(key: &str) -> Result<(Vec<&'static str>, String)> {
    let parts: Vec<&str> = key.split('+').map(alias).collect();
    let Some((main, modifiers)) = parts.split_last() else {
        bail!("press: invalid key {key}");
    };
    let mut modifier_values = Vec::new();
    for part in modifiers {
        let value = match *part {
            "Alt" => ALT,
            "Control" => CONTROL,
            "Meta" => META,
            "Shift" => SHIFT,
            other => bail!("press: unsupported modifier {other}"),
        };
        modifier_values.push(value);
    }
    let main_value = if main.chars().count() == 1 {
        main.to_string()
    } else if let Some(value) = named(main) {
        value.to_string()
    } else {
        bail!("press: unsupported key {main}; use type for text")
    };
    Ok((modifier_values, main_value))
}

/// Split text into BiDi key values (one grapheme per action).
pub fn text_keys(text: &str) -> Vec<String> {
    text.chars().map(|c| c.to_string()).collect()
}
