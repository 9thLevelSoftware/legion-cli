use std::collections::BTreeSet;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ABI: &str = "legion-validator/v1";
pub const HEADER_BYTES: usize = 16 * 1024;
pub const COMPONENT_BYTES: usize = 16 * 1024 * 1024;
pub const INPUT_BYTES: usize = 8 * 1024 * 1024;
pub const OUTPUT_BYTES: usize = 1024 * 1024;
pub const NATIVE_BYTES: usize = 2 * 1024 * 1024 * 1024;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub fuel: u64,
    pub wasm_stack_bytes: usize,
    pub instances: usize,
    pub memories: usize,
    pub memory_bytes: usize,
    pub tables: usize,
    pub table_elements: usize,
    pub deadline_ms: u64,
    pub output_bytes: usize,
    pub native_budget_bytes: usize,
}

pub const LIMITS: Limits = Limits {
    fuel: 20_000_000, wasm_stack_bytes: 1_048_576, instances: 32,
    memories: 4, memory_bytes: 67_108_864, tables: 16, table_elements: 100_000,
    deadline_ms: 20_000, output_bytes: OUTPUT_BYTES, native_budget_bytes: NATIVE_BYTES,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: String,
    pub abi: String,
    pub module_sha256: String,
    pub input_sha256: String,
    pub component_bytes: usize,
    pub input_bytes: usize,
    pub limits: Limits,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum File {
    Missing { path: String },
    File { path: String, mode: String, sha256: String, encoding: String, content: String },
}

impl File {
    fn path(&self) -> &str {
        match self { Self::Missing { path } | Self::File { path, .. } => path }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selector {
    kind: String,
    qualified_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Unit {
    unit_id: String,
    path: String,
    #[serde(default, deserialize_with = "present")]
    selector: Option<Selector>,
    syntax_digest: String,
    #[serde(rename = "syntaxProjection")]
    _syntax_projection: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub abi: String,
    pub project_check_id: String,
    pub extension_check_id: String,
    pub acceptance_ids: Vec<String>,
    pub unit_ids: Vec<String>,
    pub configuration: Value,
    pub files: Vec<File>,
    pub units: Vec<Unit>,
}

fn present<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    T::deserialize(decoder).map(Some)
}

pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn path(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 4096 && !value.starts_with('/')
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || matches!(c, '\\' | ':' | '*' | '?' | '['))
        && value.split('/').all(|part| {
            let normalized = part.to_lowercase();
            !part.is_empty() && !part.ends_with(['.', ' '])
                && !matches!(normalized.as_str(), "." | ".." | ".git")
                && !part.rsplit_once('~').is_some_and(|(base, suffix)| {
                    !base.is_empty() && base.encode_utf16().count() <= 6 && !base.contains(['.', '~'])
                        && !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
                })
        })
}

fn unique(values: &[String], valid: impl Fn(&str) -> bool) -> bool {
    values.len() <= 256 && values.iter().all(|v| valid(v))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

pub fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid UTF-8 JSON")?;
    let value = legion_strict_json::parse(text, false, 32).map_err(|_| "Invalid, duplicate-key or deep JSON")?;
    serde_json::from_value(value).map_err(|_| "JSON contract mismatch".into())
}

impl Request {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != "legion-cli-component-request/v1" || self.abi != ABI
            || !sha(&self.module_sha256) || !sha(&self.input_sha256)
            || !(1..=COMPONENT_BYTES).contains(&self.component_bytes)
            || !(1..=INPUT_BYTES).contains(&self.input_bytes) || self.limits != LIMITS {
            return Err("Component request or fixed limits mismatch".into());
        }
        Ok(())
    }
}

impl Input {
    pub fn validate(&self) -> Result<(), String> {
        if self.abi != ABI || !id(&self.project_check_id) || !id(&self.extension_check_id)
            || !self.configuration.is_object()
            || !unique(&self.unit_ids, id)
            || !unique(&self.acceptance_ids, |v| !v.is_empty() && v.encode_utf16().count() <= 256 && !v.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
            || self.files.len() > 256 || self.units.len() > 256 {
            return Err("Component input metadata mismatch".into());
        }
        let mut seen = BTreeSet::new();
        for file in &self.files {
            if !path(file.path()) || !seen.insert(file.path().to_lowercase()) {
                return Err("Invalid or duplicate input path".into());
            }
            if let File::File { mode, sha256, encoding, content, .. } = file {
                let valid_mode = matches!(mode.as_str(), "100644" | "100755") || mode.strip_prefix("native:").is_some_and(|n| (3..=6).contains(&n.len()) && n.bytes().all(|b| (b'0'..=b'7').contains(&b)));
                if !valid_mode || !sha(sha256) { return Err("Invalid input file descriptor".into()); }
                let actual = match encoding.as_str() {
                    "utf8" => hash(content.as_bytes()),
                    "base64" => hash(&STANDARD.decode(content).map_err(|_| "Invalid base64 input file")?),
                    _ => return Err("Invalid input encoding".into()),
                };
                if &actual != sha256 { return Err("Input file digest mismatch".into()); }
            }
        }
        let mut seen = BTreeSet::new();
        for unit in &self.units {
            if !id(&unit.unit_id) || !seen.insert(&unit.unit_id) || !path(&unit.path) || !sha(&unit.syntax_digest)
                || !self.unit_ids.contains(&unit.unit_id) {
                return Err("Invalid unit input descriptor".into());
            }
            if let Some(selector) = &unit.selector {
                if !matches!(selector.kind.as_str(), "function" | "class" | "method" | "type" | "interface" | "variable")
                    || selector.qualified_name.is_empty() || selector.qualified_name.encode_utf16().count() > 1024 {
                    return Err("Invalid knowledge selector".into());
                }
            }
        }
        if self.units.len() != self.unit_ids.len() { return Err("Unit input set mismatch".into()); }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    schema_version: String,
    check_id: String,
    status: String,
    observations: Vec<Observation>,
    #[serde(default, deserialize_with = "present")]
    recommendations: Option<Vec<Recommendation>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    id: String,
    status: String,
    code: String,
    #[serde(default, deserialize_with = "present")]
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recommendation {
    title: String,
    #[serde(default, deserialize_with = "present")]
    priority: Option<String>,
    #[serde(rename = "type", default, deserialize_with = "present")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "present")]
    detail: Option<String>,
}

impl Output {
    pub fn validate(&self, expected: &str) -> Result<(), String> {
        if self.schema_version != "legion-cli-validator-output/v1" || self.check_id != expected
            || !id(&self.check_id) || !matches!(self.status.as_str(), "passed" | "failed") || self.observations.len() > 256 {
            return Err("Validator output identity/status mismatch".into());
        }
        let mut seen = BTreeSet::new();
        for observation in &self.observations {
            if !id(&observation.id) || !seen.insert(&observation.id) || !id(&observation.code)
                || !matches!(observation.status.as_str(), "passed" | "failed" | "error")
                || (self.status == "passed" && observation.status != "passed")
                || observation.detail.as_ref().is_some_and(|v| v.len() > 4096) {
                return Err("Invalid validator observation".into());
            }
        }
        if let Some(recommendations) = &self.recommendations {
            if recommendations.len() > 32 { return Err("Too many validator recommendations".into()); }
            for recommendation in recommendations {
                if recommendation.title.is_empty() || recommendation.title.encode_utf16().count() > 256
                    || recommendation.priority.as_ref().is_some_and(|v| !matches!(v.as_str(), "P0" | "P1" | "P2"))
                    || recommendation.kind.as_ref().is_some_and(|v| !matches!(v.as_str(), "feature" | "fix" | "bug"))
                    || recommendation.detail.as_ref().is_some_and(|v| v.len() > 4096) {
                    return Err("Invalid validator recommendation".into());
                }
            }
        }
        Ok(())
    }
}
