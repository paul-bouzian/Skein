use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::conversation::{
    ComposerAppOption, ComposerFileSearchResult, ComposerMentionBindingInput,
    ComposerMentionBindingKind, ComposerPromptArgumentMode, ComposerPromptOption,
    ComposerSkillOption, ThreadComposerCatalog,
};
use crate::error::{AppError, AppResult};

const PROMPT_PREFIX: &str = "/prompts:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptDefinition {
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub argument_mode: ComposerPromptArgumentMode,
    pub argument_names: Vec<String>,
    pub positional_count: usize,
    pub argument_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillBinding {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppBinding {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub slug: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTextElement {
    pub start: usize,
    pub end: usize,
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedComposerText {
    pub visible_text: String,
    pub text: String,
    pub text_elements: Vec<ResolvedTextElement>,
    pub skills: Vec<SkillBinding>,
    pub mentions: Vec<AppBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptInvocation {
    start: usize,
    end: usize,
    name: String,
    raw: String,
    args_source: String,
}

pub fn load_prompt_definitions(environment_path: &str) -> AppResult<Vec<PromptDefinition>> {
    let prompt_root = prompt_root_for_environment(environment_path)?;
    let Some(prompt_root) = prompt_root else {
        return Ok(Vec::new());
    };
    let entries = fs::read_dir(prompt_root)?;
    let mut prompts = Vec::new();

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::trim)
            .filter(|stem| !stem.is_empty())
            .map(ToString::to_string)
        else {
            continue;
        };

        let raw = fs::read_to_string(&path)?;
        let (description, content) = split_prompt_frontmatter(&raw);
        let content = content.trim().to_string();
        let argument_names = prompt_argument_names(&content);
        let positional_count = positional_argument_count(&content);
        let argument_mode = if !argument_names.is_empty() {
            ComposerPromptArgumentMode::Named
        } else if positional_count > 0 || content.contains("$ARGUMENTS") {
            ComposerPromptArgumentMode::Positional
        } else {
            ComposerPromptArgumentMode::None
        };
        let argument_hint = prompt_argument_hint(argument_mode, &argument_names, positional_count);

        prompts.push(PromptDefinition {
            name,
            description,
            content,
            argument_mode,
            argument_names,
            positional_count,
            argument_hint,
        });
    }

    prompts.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(prompts)
}

pub fn build_thread_catalog(
    prompts: &[PromptDefinition],
    skills: &[SkillBinding],
    apps: &[AppBinding],
) -> ThreadComposerCatalog {
    ThreadComposerCatalog {
        prompts: prompts
            .iter()
            .map(|prompt| ComposerPromptOption {
                name: prompt.name.clone(),
                description: prompt.description.clone(),
                argument_mode: prompt.argument_mode,
                argument_names: prompt.argument_names.clone(),
                positional_count: prompt.positional_count,
                argument_hint: prompt.argument_hint.clone(),
            })
            .collect(),
        skills: skills
            .iter()
            .map(|skill| ComposerSkillOption {
                name: skill.name.clone(),
                description: skill.description.clone(),
                path: skill.path.clone(),
            })
            .collect(),
        apps: apps
            .iter()
            .map(|app| ComposerAppOption {
                id: app.id.clone(),
                name: app.name.clone(),
                description: app.description.clone(),
                slug: app.slug.clone(),
                path: app.path.clone(),
            })
            .collect(),
    }
}

pub fn trim_file_search_results(paths: Vec<String>, limit: usize) -> Vec<ComposerFileSearchResult> {
    paths
        .into_iter()
        .take(limit)
        .map(|path| ComposerFileSearchResult { path })
        .collect()
}

pub fn connector_mention_slug(name: &str) -> String {
    let mut normalized = String::new();
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push('-');
        }
    }
    let slug = normalized.trim_matches('-').to_string();
    if slug.is_empty() {
        "app".to_string()
    } else {
        slug
    }
}

pub fn resolve_composer_text(
    visible_text: &str,
    prompts: &[PromptDefinition],
    skills: &[SkillBinding],
    apps: &[AppBinding],
    explicit_mention_bindings: &[ComposerMentionBindingInput],
) -> AppResult<ResolvedComposerText> {
    let prompt_map = prompts
        .iter()
        .map(|prompt| (prompt.name.as_str(), prompt))
        .collect::<HashMap<_, _>>();
    let invocations = parse_prompt_invocations(visible_text);

    let mut text = String::new();
    let mut text_elements = Vec::new();
    let mut ignored_ranges = Vec::new();
    let mut last_index = 0usize;

    for invocation in &invocations {
        text.push_str(&visible_text[last_index..invocation.start]);
        last_index = invocation.end;
        let Some(prompt) = prompt_map.get(invocation.name.as_str()) else {
            text.push_str(&invocation.raw);
            continue;
        };

        let expanded = expand_prompt(prompt, invocation)?;
        let start = text.len();
        text.push_str(&expanded);
        let end = text.len();
        ignored_ranges.push(invocation.start..invocation.end);
        text_elements.push(ResolvedTextElement {
            start,
            end,
            placeholder: Some(invocation.raw.clone()),
        });
    }
    text.push_str(&visible_text[last_index..]);

    let (skills, mentions) = resolve_dollar_mentions(
        visible_text,
        skills,
        apps,
        explicit_mention_bindings,
        &ignored_ranges,
    );

    Ok(ResolvedComposerText {
        visible_text: visible_text.to_string(),
        text,
        text_elements,
        skills,
        mentions,
    })
}

fn prompt_root_for_environment(environment_path: &str) -> AppResult<Option<PathBuf>> {
    let environment_prompt_root = Path::new(environment_path).join(".codex").join("prompts");
    if environment_prompt_root.is_dir() {
        return Ok(Some(environment_prompt_root));
    }

    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        let home_prompt_root = PathBuf::from(codex_home).join("prompts");
        if home_prompt_root.is_dir() {
            return Ok(Some(home_prompt_root));
        }
    }

    let Some(home_dir) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    let default_prompt_root = home_dir.join(".codex").join("prompts");
    Ok(default_prompt_root.is_dir().then_some(default_prompt_root))
}

fn split_prompt_frontmatter(raw: &str) -> (Option<String>, String) {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---\n") {
        return (None, normalized);
    }

    let remainder = &normalized[4..];
    let Some(frontmatter_end) = remainder.find("\n---\n") else {
        return (None, normalized);
    };
    let frontmatter = &remainder[..frontmatter_end];
    let body = remainder[frontmatter_end + 5..].to_string();
    let description = frontmatter.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix("description:")?.trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|quoted| quoted.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|quoted| quoted.strip_suffix('\''))
            })
            .unwrap_or(value);
        (!unquoted.is_empty()).then_some(unquoted.to_string())
    });
    (description, body)
}

fn prompt_argument_names(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        if index > 0 && bytes[index - 1] == b'$' {
            index += 1;
            continue;
        }
        let next_index = index + 1;
        if next_index >= bytes.len() || !bytes[next_index].is_ascii_uppercase() {
            index += 1;
            continue;
        }
        let mut end = next_index + 1;
        while end < bytes.len()
            && (bytes[end].is_ascii_uppercase()
                || bytes[end].is_ascii_digit()
                || bytes[end] == b'_')
        {
            end += 1;
        }
        let candidate = &content[next_index..end];
        if candidate != "ARGUMENTS" && seen.insert(candidate.to_string()) {
            names.push(candidate.to_string());
        }
        index = end;
    }

    names
}

fn positional_argument_count(content: &str) -> usize {
    let bytes = content.as_bytes();
    let mut index = 0usize;
    let mut max_index = 0usize;

    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        if index + 1 >= bytes.len() {
            break;
        }
        if bytes[index + 1] == b'$' {
            index += 2;
            continue;
        }
        if !bytes[index + 1].is_ascii_digit() || bytes[index + 1] == b'0' {
            index += 1;
            continue;
        }
        let mut end = index + 2;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if let Ok(parsed) = content[index + 1..end].parse::<usize>() {
            max_index = max_index.max(parsed);
        }
        index = end;
    }

    max_index
}

fn prompt_argument_hint(
    argument_mode: ComposerPromptArgumentMode,
    argument_names: &[String],
    positional_count: usize,
) -> Option<String> {
    match argument_mode {
        ComposerPromptArgumentMode::None => None,
        ComposerPromptArgumentMode::Named => Some(
            argument_names
                .iter()
                .map(|name| format!("{name}=\"\""))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        ComposerPromptArgumentMode::Positional => {
            let count = positional_count.max(1);
            Some(
                std::iter::repeat_n("\"\"".to_string(), count)
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        }
    }
}

fn parse_prompt_invocations(text: &str) -> Vec<PromptInvocation> {
    let mut invocations = Vec::new();
    let mut search_index = 0usize;

    while let Some(relative_index) = text[search_index..].find(PROMPT_PREFIX) {
        let start = search_index + relative_index;
        if let Some(previous) = text[..start].chars().next_back() {
            if is_identifier_char(previous) {
                search_index = start + 1;
                continue;
            }
        }

        let name_start = start + PROMPT_PREFIX.len();
        let mut cursor = name_start;
        while cursor < text.len() {
            let Some(character) = text[cursor..].chars().next() else {
                break;
            };
            if !is_prompt_name_char(character) {
                break;
            }
            cursor += character.len_utf8();
        }
        if cursor == name_start || !text[cursor..].starts_with('(') {
            search_index = start + 1;
            continue;
        }

        let args_start = cursor + 1;
        let mut index = args_start;
        let mut in_quote = None::<char>;
        let mut escaped = false;
        let mut end = None;

        while index < text.len() {
            let character = text[index..].chars().next().unwrap_or_default();
            let character_len = character.len_utf8();
            if escaped {
                escaped = false;
                index += character_len;
                continue;
            }
            if character == '\\' {
                escaped = true;
                index += character_len;
                continue;
            }
            if let Some(quote) = in_quote {
                if character == quote {
                    in_quote = None;
                }
                index += character_len;
                continue;
            }
            if character == '"' || character == '\'' {
                in_quote = Some(character);
                index += character_len;
                continue;
            }
            if character == ')' {
                end = Some(index + character_len);
                break;
            }
            index += character_len;
        }

        let Some(end) = end else {
            search_index = start + 1;
            continue;
        };
        invocations.push(PromptInvocation {
            start,
            end,
            name: text[name_start..cursor].to_string(),
            raw: text[start..end].to_string(),
            args_source: text[args_start..end - 1].to_string(),
        });
        search_index = end;
    }

    invocations
}

fn expand_prompt(prompt: &PromptDefinition, invocation: &PromptInvocation) -> AppResult<String> {
    match prompt.argument_mode {
        ComposerPromptArgumentMode::None => {
            if !invocation.args_source.trim().is_empty() {
                return Err(AppError::Validation(format!(
                    "Prompt `{}` does not accept arguments.",
                    prompt.name
                )));
            }
            Ok(prompt.content.clone())
        }
        ComposerPromptArgumentMode::Named => {
            let values = parse_named_arguments(&invocation.args_source).map_err(|message| {
                AppError::Validation(format!("Could not parse {}: {message}", invocation.raw))
            })?;
            let missing = prompt
                .argument_names
                .iter()
                .filter(|name| !values.contains_key(*name))
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                return Err(AppError::Validation(format!(
                    "Missing required args for {}: {}.",
                    invocation.raw,
                    missing.join(", ")
                )));
            }
            Ok(expand_named_placeholders(&prompt.content, &values))
        }
        ComposerPromptArgumentMode::Positional => {
            let arguments =
                parse_positional_arguments(&invocation.args_source).map_err(|message| {
                    AppError::Validation(format!("Could not parse {}: {message}", invocation.raw))
                })?;
            if prompt.positional_count > arguments.len() {
                return Err(AppError::Validation(format!(
                    "Missing required positional args for {}.",
                    invocation.raw
                )));
            }
            Ok(expand_positional_placeholders(&prompt.content, &arguments))
        }
    }
}

fn parse_named_arguments(source: &str) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    for argument in split_arguments(source)? {
        if argument.is_empty() {
            continue;
        }
        let Some((key, value)) = argument.split_once('=') else {
            return Err(format!(
                "expected key=value but found `{argument}`. Wrap values with commas in quotes."
            ));
        };
        let key = key.trim();
        if key.is_empty() {
            return Err(format!("expected a name before `=` in `{argument}`"));
        }
        values.insert(key.to_string(), decode_argument_value(value.trim())?);
    }
    Ok(values)
}

fn parse_positional_arguments(source: &str) -> Result<Vec<String>, String> {
    split_arguments(source)?
        .into_iter()
        .filter(|argument| !argument.is_empty())
        .map(|argument| decode_argument_value(argument.trim()))
        .collect()
}

fn split_arguments(source: &str) -> Result<Vec<String>, String> {
    if source.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut in_quote = None::<char>;
    let mut escaped = false;

    for character in source.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            current.push(character);
            continue;
        }
        if let Some(quote) = in_quote {
            current.push(character);
            if character == quote {
                in_quote = None;
            }
            continue;
        }
        if character == '"' || character == '\'' {
            in_quote = Some(character);
            current.push(character);
            continue;
        }
        if character == ',' {
            arguments.push(current.trim().to_string());
            current.clear();
            continue;
        }
        current.push(character);
    }

    if in_quote.is_some() {
        return Err("unterminated quoted argument".to_string());
    }
    if escaped {
        return Err("trailing escape in argument list".to_string());
    }
    arguments.push(current.trim().to_string());
    Ok(arguments)
}

fn decode_argument_value(value: &str) -> Result<String, String> {
    let Some(first) = value.chars().next() else {
        return Ok(String::new());
    };
    let Some(last) = value.chars().next_back() else {
        return Ok(String::new());
    };
    if (first == '"' || first == '\'') && first == last && value.len() >= 2 {
        let inner = &value[first.len_utf8()..value.len() - last.len_utf8()];
        let mut decoded = String::new();
        let mut escaped = false;
        for character in inner.chars() {
            if escaped {
                decoded.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else {
                decoded.push(character);
            }
        }
        if escaped {
            return Err("trailing escape in quoted argument".to_string());
        }
        return Ok(decoded);
    }
    Ok(value.to_string())
}

fn expand_named_placeholders(content: &str, values: &HashMap<String, String>) -> String {
    let mut output = String::new();
    let mut index = 0usize;

    while index < content.len() {
        let Some(character) = content[index..].chars().next() else {
            break;
        };
        if character != '$' {
            output.push(character);
            index += character.len_utf8();
            continue;
        }
        let next = index + character.len_utf8();
        let Some(next_character) = content[next..].chars().next() else {
            output.push('$');
            break;
        };
        if next_character == '$' {
            output.push('$');
            index = next + next_character.len_utf8();
            continue;
        }
        if !next_character.is_ascii_uppercase() {
            output.push('$');
            index += character.len_utf8();
            continue;
        }
        let mut end = next + next_character.len_utf8();
        while end < content.len() {
            let Some(candidate) = content[end..].chars().next() else {
                break;
            };
            if !(candidate.is_ascii_uppercase() || candidate.is_ascii_digit() || candidate == '_') {
                break;
            }
            end += candidate.len_utf8();
        }
        let key = &content[next..end];
        if let Some(value) = values.get(key) {
            output.push_str(value);
        } else {
            output.push_str(&content[index..end]);
        }
        index = end;
    }

    output
}

fn expand_positional_placeholders(content: &str, arguments: &[String]) -> String {
    let mut output = String::new();
    let mut index = 0usize;

    while index < content.len() {
        let Some(character) = content[index..].chars().next() else {
            break;
        };
        if character != '$' {
            output.push(character);
            index += character.len_utf8();
            continue;
        }

        let next_index = index + character.len_utf8();
        let Some(next_character) = content[next_index..].chars().next() else {
            output.push('$');
            break;
        };
        if next_character == '$' {
            output.push('$');
            index = next_index + next_character.len_utf8();
            continue;
        }
        if content[next_index..].starts_with("ARGUMENTS") {
            output.push_str(&arguments.join(" "));
            index = next_index + "ARGUMENTS".len();
            continue;
        }
        if next_character.is_ascii_digit() && next_character != '0' {
            let mut end = next_index + next_character.len_utf8();
            while end < content.len() {
                let Some(candidate) = content[end..].chars().next() else {
                    break;
                };
                if !candidate.is_ascii_digit() {
                    break;
                }
                end += candidate.len_utf8();
            }
            if let Ok(number) = content[next_index..end].parse::<usize>() {
                if let Some(argument) = arguments.get(number.saturating_sub(1)) {
                    output.push_str(argument);
                }
            }
            index = end;
            continue;
        }

        output.push('$');
        index += character.len_utf8();
    }

    output
}

fn resolve_dollar_mentions(
    text: &str,
    skills: &[SkillBinding],
    apps: &[AppBinding],
    explicit_bindings: &[ComposerMentionBindingInput],
    ignored_ranges: &[std::ops::Range<usize>],
) -> (Vec<SkillBinding>, Vec<AppBinding>) {
    let skill_map = skills
        .iter()
        .map(|skill| (skill.name.to_ascii_lowercase(), skill))
        .collect::<HashMap<_, _>>();
    let mut app_map = HashMap::<String, &AppBinding>::new();
    let mut duplicates = HashSet::new();
    for app in apps {
        let key = app.slug.to_ascii_lowercase();
        if app_map.insert(key.clone(), app).is_some() {
            duplicates.insert(key);
        }
    }

    let mut explicit_by_name = HashMap::<String, VecDeque<&ComposerMentionBindingInput>>::new();
    for binding in explicit_bindings {
        explicit_by_name
            .entry(binding.mention.to_ascii_lowercase())
            .or_default()
            .push_back(binding);
    }

    let mut seen_skill_paths = HashSet::new();
    let mut resolved_skills = Vec::new();
    let mut seen_app_paths = HashSet::new();
    let mut resolved_apps = Vec::new();

    for token in collect_dollar_tokens(text, ignored_ranges) {
        let normalized = token.to_ascii_lowercase();
        if let Some(binding) = explicit_by_name
            .get_mut(&normalized)
            .and_then(VecDeque::pop_front)
        {
            match binding.kind {
                ComposerMentionBindingKind::Skill => {
                    let explicit_skill = skills
                        .iter()
                        .find(|skill| {
                            skill.path == binding.path
                                || skill.name.eq_ignore_ascii_case(&binding.mention)
                        })
                        .cloned();
                    if let Some(skill) = explicit_skill {
                        if seen_skill_paths.insert(skill.path.clone()) {
                            resolved_skills.push(skill);
                        }
                        continue;
                    }
                }
                ComposerMentionBindingKind::App => {
                    let explicit_app = apps
                        .iter()
                        .find(|app| {
                            app.path == binding.path
                                || app.slug.eq_ignore_ascii_case(&binding.mention)
                        })
                        .cloned();
                    if let Some(app) = explicit_app {
                        if seen_app_paths.insert(app.path.clone()) {
                            resolved_apps.push(app);
                        }
                        continue;
                    }
                }
            }
        }

        let inferred_skill = skill_map.get(&normalized).copied();
        let inferred_app = if duplicates.contains(&normalized) {
            None
        } else {
            app_map.get(&normalized).copied()
        };

        match (inferred_skill, inferred_app) {
            (Some(skill), None) => {
                if seen_skill_paths.insert(skill.path.clone()) {
                    resolved_skills.push(skill.clone());
                }
            }
            (None, Some(app)) => {
                if seen_app_paths.insert(app.path.clone()) {
                    resolved_apps.push(app.clone());
                }
            }
            _ => {}
        }
    }

    (resolved_skills, resolved_apps)
}

fn collect_dollar_tokens(text: &str, ignored_ranges: &[std::ops::Range<usize>]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut index = 0usize;

    while index < text.len() {
        let Some(character) = text[index..].chars().next() else {
            break;
        };
        if character != '$' {
            index += character.len_utf8();
            continue;
        }
        if ignored_ranges.iter().any(|range| range.contains(&index)) {
            index += character.len_utf8();
            continue;
        }
        if let Some(previous) = text[..index].chars().next_back() {
            if is_identifier_char(previous) {
                index += character.len_utf8();
                continue;
            }
        }

        let start = index + character.len_utf8();
        let mut end = start;
        while end < text.len() {
            let Some(candidate) = text[end..].chars().next() else {
                break;
            };
            if !is_mention_char(candidate) {
                break;
            }
            end += candidate.len_utf8();
        }
        if end > start {
            tokens.push(text[start..end].to_string());
        }
        index = end.max(start);
    }

    tokens
}

fn is_prompt_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
}

fn is_identifier_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':' | '/')
}

fn is_mention_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(name: &str, content: &str) -> PromptDefinition {
        let argument_names = prompt_argument_names(content);
        let positional_count = positional_argument_count(content);
        let argument_mode = if !argument_names.is_empty() {
            ComposerPromptArgumentMode::Named
        } else if positional_count > 0 || content.contains("$ARGUMENTS") {
            ComposerPromptArgumentMode::Positional
        } else {
            ComposerPromptArgumentMode::None
        };
        PromptDefinition {
            name: name.to_string(),
            description: None,
            content: content.to_string(),
            argument_mode,
            argument_names,
            positional_count,
            argument_hint: None,
        }
    }

    #[test]
    fn resolves_named_and_positional_prompts_inline() {
        let prompts = vec![
            prompt("review", "Review $PATH with focus on $FOCUS."),
            prompt("debug", "Investigate $ARGUMENTS"),
        ];

        let resolved = resolve_composer_text(
            "Check /prompts:review(PATH=\"src/lib.rs\", FOCUS=\"perf\") then /prompts:debug(\"the crash\")",
            &prompts,
            &[],
            &[],
            &[],
        )
        .expect("prompts should resolve");

        assert_eq!(
            resolved.text,
            "Check Review src/lib.rs with focus on perf. then Investigate the crash"
        );
        assert_eq!(resolved.text_elements.len(), 2);
        assert_eq!(
            resolved.text_elements[0].placeholder.as_deref(),
            Some("/prompts:review(PATH=\"src/lib.rs\", FOCUS=\"perf\")")
        );
    }

    #[test]
    fn unknown_prompts_remain_literal() {
        let resolved = resolve_composer_text(
            "Hello /prompts:unknown()",
            &[prompt("review", "Review")],
            &[],
            &[],
            &[],
        )
        .expect("unknown prompt should not fail");

        assert_eq!(resolved.text, "Hello /prompts:unknown()");
        assert!(resolved.text_elements.is_empty());
    }

    #[test]
    fn unknown_prompts_do_not_hide_skill_or_app_mentions() {
        let resolved = resolve_composer_text(
            "Run /prompts:unknown($loom-standards, $github)",
            &[],
            &[SkillBinding {
                name: "loom-standards".to_string(),
                description: "Standards".to_string(),
                path: "/tmp/skill".to_string(),
            }],
            &[AppBinding {
                id: "app-1".to_string(),
                name: "GitHub".to_string(),
                description: Some("Connector".to_string()),
                slug: "github".to_string(),
                path: "app://app-1".to_string(),
            }],
            &[],
        )
        .expect("unknown prompts should remain literal while mentions still resolve");

        assert_eq!(
            resolved.text,
            "Run /prompts:unknown($loom-standards, $github)"
        );
        assert_eq!(resolved.skills.len(), 1);
        assert_eq!(resolved.mentions.len(), 1);
    }

    #[test]
    fn invalid_prompt_arguments_fail_fast() {
        let error = resolve_composer_text(
            "/prompts:review(PATH=\"src/lib.rs\")",
            &[prompt("review", "Review $PATH and $FOCUS")],
            &[],
            &[],
            &[],
        )
        .expect_err("missing named argument should fail");

        assert!(error.to_string().contains("Missing required args"));
    }

    #[test]
    fn invalid_positional_prompt_arguments_fail_fast() {
        let error = resolve_composer_text(
            "/prompts:review(\"src/lib.rs\")",
            &[prompt("review", "Review $1 with focus on $2")],
            &[],
            &[],
            &[],
        )
        .expect_err("missing positional argument should fail");

        assert!(error
            .to_string()
            .contains("Missing required positional args"));
    }

    #[test]
    fn resolves_unique_skills_and_apps_without_duplicates() {
        let resolved = resolve_composer_text(
            "Run $loom-standards and $github then $loom-standards again.",
            &[],
            &[SkillBinding {
                name: "loom-standards".to_string(),
                description: "Standards".to_string(),
                path: "/tmp/skill".to_string(),
            }],
            &[AppBinding {
                id: "app-1".to_string(),
                name: "GitHub".to_string(),
                description: Some("Connector".to_string()),
                slug: "github".to_string(),
                path: "app://app-1".to_string(),
            }],
            &[],
        )
        .expect("mentions should resolve");

        assert_eq!(resolved.skills.len(), 1);
        assert_eq!(resolved.mentions.len(), 1);
        assert_eq!(resolved.skills[0].path, "/tmp/skill");
        assert_eq!(resolved.mentions[0].path, "app://app-1");
    }

    #[test]
    fn explicit_bindings_disambiguate_colliding_skill_and_app_tokens() {
        let github_skill = SkillBinding {
            name: "github".to_string(),
            description: "Skill".to_string(),
            path: "/tmp/skills/github/SKILL.md".to_string(),
        };
        let github_app = AppBinding {
            id: "app-1".to_string(),
            name: "GitHub".to_string(),
            description: Some("Connector".to_string()),
            slug: "github".to_string(),
            path: "app://github".to_string(),
        };

        let resolved = resolve_composer_text(
            "Use $github and then $github again.",
            &[],
            std::slice::from_ref(&github_skill),
            std::slice::from_ref(&github_app),
            &[
                ComposerMentionBindingInput {
                    mention: "github".to_string(),
                    kind: ComposerMentionBindingKind::App,
                    path: github_app.path.clone(),
                },
                ComposerMentionBindingInput {
                    mention: "github".to_string(),
                    kind: ComposerMentionBindingKind::Skill,
                    path: github_skill.path.clone(),
                },
            ],
        )
        .expect("explicit mention bindings should disambiguate collisions");

        assert_eq!(resolved.mentions, vec![github_app]);
        assert_eq!(resolved.skills, vec![github_skill]);
    }

    #[test]
    fn ambiguous_manual_collisions_do_not_resolve_twice() {
        let resolved = resolve_composer_text(
            "Use $github",
            &[],
            &[SkillBinding {
                name: "github".to_string(),
                description: "Skill".to_string(),
                path: "/tmp/skills/github/SKILL.md".to_string(),
            }],
            &[AppBinding {
                id: "app-1".to_string(),
                name: "GitHub".to_string(),
                description: Some("Connector".to_string()),
                slug: "github".to_string(),
                path: "app://github".to_string(),
            }],
            &[],
        )
        .expect("ambiguous manual mention should remain text only");

        assert!(resolved.skills.is_empty());
        assert!(resolved.mentions.is_empty());
    }

    #[test]
    fn split_prompt_frontmatter_extracts_description() {
        let (description, content) =
            split_prompt_frontmatter("---\ndescription: Test prompt\n---\n\nBody");

        assert_eq!(description.as_deref(), Some("Test prompt"));
        assert_eq!(content.trim(), "Body");
    }

    #[test]
    fn split_prompt_frontmatter_normalizes_crlf_files() {
        let (description, content) =
            split_prompt_frontmatter("---\r\ndescription: Test prompt\r\n---\r\n\r\nBody\r\n");

        assert_eq!(description.as_deref(), Some("Test prompt"));
        assert_eq!(content, "\nBody\n");
    }

    #[test]
    fn expands_double_dollar_sequences_as_literal_dollars() {
        let prompts = vec![
            prompt("named", "Use $$HOME and $PATH"),
            prompt("positional", "Echo $$1 then $1"),
        ];

        let resolved = resolve_composer_text(
            "/prompts:named(PATH=\"src/lib.rs\") /prompts:positional(\"value\")",
            &prompts,
            &[],
            &[],
            &[],
        )
        .expect("escaped dollars should be preserved literally");

        assert_eq!(resolved.text, "Use $HOME and src/lib.rs Echo $1 then value");
    }
}
