use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::conversation::{
    ComposerPromptArgumentMode, ComposerPromptOption, ComposerSkillOption, ThreadComposerCatalog,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCommandDefinition {
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub path: String,
    pub argument_names: Vec<String>,
    pub argument_hint: Option<String>,
    pub user_invocable: bool,
}

pub fn load_claude_command_definitions(
    environment_path: &str,
) -> AppResult<Vec<ClaudeCommandDefinition>> {
    let mut commands = HashMap::<String, ClaudeCommandDefinition>::new();
    for root in claude_command_roots(environment_path) {
        if let Err(error) = load_claude_commands_from_root(&root, &mut commands) {
            tracing::warn!(
                path = %root.display(),
                %error,
                "skipping unreadable Claude command root"
            );
        }
    }
    let mut commands = commands
        .into_values()
        .filter(|command| command.user_invocable)
        .collect::<Vec<_>>();
    commands.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(commands)
}

pub fn load_claude_skill_definitions(
    environment_path: &str,
) -> AppResult<Vec<ClaudeCommandDefinition>> {
    let mut skills = HashMap::<String, ClaudeCommandDefinition>::new();
    for root in claude_skill_roots(environment_path) {
        if let Err(error) = load_claude_skills_from_root(&root, &mut skills) {
            tracing::warn!(
                path = %root.display(),
                %error,
                "skipping unreadable Claude skill root"
            );
        }
    }
    let mut skills = skills
        .into_values()
        .filter(|skill| skill.user_invocable)
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

pub fn build_claude_thread_catalog(
    commands: &[ClaudeCommandDefinition],
    skills: &[ClaudeCommandDefinition],
) -> ThreadComposerCatalog {
    ThreadComposerCatalog {
        prompts: commands
            .iter()
            .map(|command| ComposerPromptOption {
                name: command.name.clone(),
                description: command.description.clone(),
                argument_mode: ComposerPromptArgumentMode::Positional,
                argument_names: command.argument_names.clone(),
                positional_count: 0,
                argument_hint: command.argument_hint.clone(),
            })
            .collect(),
        skills: skills
            .iter()
            .map(|skill| ComposerSkillOption {
                name: skill.name.clone(),
                description: skill
                    .description
                    .clone()
                    .unwrap_or_else(|| "Claude Code skill".to_string()),
                path: skill.path.clone(),
            })
            .collect(),
        apps: Vec::new(),
    }
}

pub fn resolve_claude_composer_text(
    environment_path: &str,
    visible_text: &str,
) -> AppResult<String> {
    if !visible_text.contains('/') && !visible_text.contains('$') {
        return Ok(visible_text.to_string());
    }

    let commands = load_claude_command_definitions(environment_path)?;
    let skills = load_claude_skill_definitions(environment_path)?;
    if commands.is_empty() && skills.is_empty() {
        return Ok(visible_text.to_string());
    }

    let mut slash_map = HashMap::<String, &ClaudeCommandDefinition>::new();
    for command in &commands {
        slash_map.insert(command.name.to_ascii_lowercase(), command);
    }
    let skill_map = skills
        .iter()
        .map(|skill| (skill.name.to_ascii_lowercase(), skill))
        .collect::<HashMap<_, _>>();

    let mut output = String::new();
    let mut cursor = 0usize;
    while cursor < visible_text.len() {
        let Some(relative_index) = visible_text[cursor..].find(['/', '$']) else {
            output.push_str(&visible_text[cursor..]);
            break;
        };
        let start = cursor + relative_index;
        output.push_str(&visible_text[cursor..start]);
        let trigger = visible_text[start..].chars().next().unwrap_or_default();
        if let Some(previous) = visible_text[..start].chars().next_back() {
            if is_identifier_char(previous) {
                output.push(trigger);
                cursor = start + trigger.len_utf8();
                continue;
            }
        }

        let name_start = start + trigger.len_utf8();
        let mut name_end = name_start;
        while name_end < visible_text.len() {
            let Some(candidate) = visible_text[name_end..].chars().next() else {
                break;
            };
            if !is_name_char(candidate) {
                break;
            }
            name_end += candidate.len_utf8();
        }
        if name_end == name_start {
            output.push(trigger);
            cursor = name_start;
            continue;
        }

        let name = &visible_text[name_start..name_end];
        let normalized = name.to_ascii_lowercase();
        let definition = if trigger == '/' {
            slash_map.get(&normalized).copied()
        } else {
            skill_map.get(&normalized).copied()
        };
        let Some(definition) = definition else {
            output.push_str(&visible_text[start..name_end]);
            cursor = name_end;
            continue;
        };

        let (arguments, end) = if trigger == '/' {
            let line_end = visible_text[name_end..]
                .find('\n')
                .map(|offset| name_end + offset)
                .unwrap_or(visible_text.len());
            (visible_text[name_end..line_end].trim(), line_end)
        } else {
            ("", name_end)
        };
        output.push_str(&render_claude_definition(definition, arguments)?);
        cursor = end;
    }

    Ok(output)
}

fn claude_command_roots(environment_path: &str) -> Vec<PathBuf> {
    claude_roots(environment_path, "commands")
}

fn claude_skill_roots(environment_path: &str) -> Vec<PathBuf> {
    claude_roots(environment_path, "skills")
}

fn claude_roots(environment_path: &str, directory_name: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let project_root = Path::new(environment_path)
        .join(".claude")
        .join(directory_name);
    if project_root.is_dir() {
        roots.push(project_root);
    }
    if let Some(home_dir) = home_dir() {
        let user_root = home_dir.join(".claude").join(directory_name);
        if user_root.is_dir() {
            roots.push(user_root);
        }
    }
    roots
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn load_claude_commands_from_root(
    root: &Path,
    commands: &mut HashMap<String, ClaudeCommandDefinition>,
) -> AppResult<()> {
    for path in markdown_files_recursively(root)? {
        let Some(fallback_name) = valid_claude_fallback_name(
            &path,
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::trim),
            "command",
        ) else {
            continue;
        };
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable Claude command file"
                );
                continue;
            }
        };
        let parsed =
            parse_claude_definition_file(&raw, fallback_name, path.to_string_lossy().as_ref());
        commands
            .entry(parsed.name.to_ascii_lowercase())
            .or_insert(parsed);
    }
    Ok(())
}

fn valid_claude_fallback_name<'a>(
    path: &Path,
    candidate: Option<&'a str>,
    definition_type: &str,
) -> Option<&'a str> {
    let name = candidate.filter(|name| !name.is_empty())?;
    if is_valid_claude_definition_name(name) {
        return Some(name);
    }
    tracing::warn!(
        path = %path.display(),
        name,
        definition_type,
        "skipping Claude definition with invalid fallback name"
    );
    None
}

fn load_claude_skills_from_root(
    root: &Path,
    skills: &mut HashMap<String, ClaudeCommandDefinition>,
) -> AppResult<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(
                path = %root.display(),
                %error,
                "skipping unreadable Claude skill root"
            );
            return Ok(());
        }
    };
    let mut directories = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(
                    path = %root.display(),
                    %error,
                    "skipping unreadable Claude skill directory entry"
                );
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(
                    path = %entry.path().display(),
                    %error,
                    "skipping unreadable Claude skill directory entry"
                );
                continue;
            }
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let directory = entry.path();
        if is_regular_file(&directory.join("SKILL.md")) {
            directories.push(directory);
        }
    }
    directories.sort();
    for directory in directories {
        let path = directory.join("SKILL.md");
        let Some(fallback_name) = valid_claude_fallback_name(
            &directory,
            directory
                .file_name()
                .and_then(|stem| stem.to_str())
                .map(str::trim),
            "skill",
        ) else {
            continue;
        };
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable Claude skill file"
                );
                continue;
            }
        };
        let parsed =
            parse_claude_definition_file(&raw, fallback_name, path.to_string_lossy().as_ref());
        skills
            .entry(parsed.name.to_ascii_lowercase())
            .or_insert(parsed);
    }
    Ok(())
}

fn markdown_files_recursively(root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_markdown_files(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_markdown_files(root: &Path, files: &mut Vec<PathBuf>) -> AppResult<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(
                path = %root.display(),
                %error,
                "skipping unreadable Claude command directory"
            );
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(
                    path = %root.display(),
                    %error,
                    "skipping unreadable Claude command directory entry"
                );
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable Claude command path"
                );
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_markdown_files(&path, files)?;
            continue;
        }
        if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn parse_claude_definition_file(
    raw: &str,
    fallback_name: &str,
    path: &str,
) -> ClaudeCommandDefinition {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let (frontmatter, content) = split_frontmatter_block(&normalized);
    let name = frontmatter
        .as_deref()
        .and_then(|source| frontmatter_scalar(source, "name"))
        .filter(|value| is_valid_claude_definition_name(value))
        .unwrap_or_else(|| fallback_name.to_string());
    let description = frontmatter
        .as_deref()
        .and_then(|source| frontmatter_scalar(source, "description"))
        .or_else(|| first_markdown_paragraph(&content));
    let argument_names = frontmatter
        .as_deref()
        .and_then(frontmatter_arguments)
        .unwrap_or_default();
    let argument_hint = frontmatter
        .as_deref()
        .and_then(|source| frontmatter_scalar(source, "argument-hint"))
        .or_else(|| {
            (!argument_names.is_empty()).then(|| {
                argument_names
                    .iter()
                    .map(|name| format!("<{name}>"))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        });
    let user_invocable = frontmatter
        .as_deref()
        .and_then(|source| frontmatter_scalar(source, "user-invocable"))
        .map(|value| !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true);

    ClaudeCommandDefinition {
        name,
        description,
        content: content.trim().to_string(),
        path: path.to_string(),
        argument_names,
        argument_hint,
        user_invocable,
    }
}

fn split_frontmatter_block(raw: &str) -> (Option<String>, String) {
    if !raw.starts_with("---\n") {
        return (None, raw.to_string());
    }
    let remainder = &raw[4..];
    let Some(frontmatter_end) = remainder.find("\n---\n") else {
        return (None, raw.to_string());
    };
    (
        Some(remainder[..frontmatter_end].to_string()),
        remainder[frontmatter_end + 5..].to_string(),
    )
}

fn frontmatter_scalar(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    frontmatter.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(&prefix)?.trim();
        let unquoted = unquote_scalar(value).trim();
        (!unquoted.is_empty()).then_some(unquoted.to_string())
    })
}

fn frontmatter_arguments(frontmatter: &str) -> Option<Vec<String>> {
    let arguments = frontmatter_scalar(frontmatter, "arguments")
        .map(|value| parse_frontmatter_argument_scalar(&value))
        .or_else(|| frontmatter_sequence(frontmatter, "arguments"))?;
    (!arguments.is_empty()).then_some(arguments)
}

fn parse_frontmatter_argument_scalar(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        return trimmed[1..trimmed.len().saturating_sub(1)]
            .split(',')
            .map(|part| unquote_scalar(part.trim()).to_string())
            .filter(|part| !part.is_empty())
            .collect();
    }
    trimmed
        .split_whitespace()
        .map(unquote_scalar)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn frontmatter_sequence(frontmatter: &str, key: &str) -> Option<Vec<String>> {
    let header = format!("{key}:");
    let mut in_sequence = false;
    let mut values = Vec::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if !in_sequence {
            if trimmed == header {
                in_sequence = true;
            }
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            break;
        }
        let Some(value) = trimmed.strip_prefix("- ") else {
            continue;
        };
        let value = unquote_scalar(value.trim()).trim();
        if !value.is_empty() {
            values.push(value.to_string());
        }
    }
    (!values.is_empty()).then_some(values)
}

fn unquote_scalar(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|quoted| quoted.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|quoted| quoted.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn first_markdown_paragraph(content: &str) -> Option<String> {
    content
        .split("\n\n")
        .map(str::trim)
        .find(|paragraph| !paragraph.is_empty() && !paragraph.starts_with('#'))
        .map(|paragraph| {
            paragraph
                .lines()
                .map(str::trim)
                .collect::<Vec<_>>()
                .join(" ")
        })
}

fn is_valid_claude_definition_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(is_name_char)
}

fn render_claude_definition(
    definition: &ClaudeCommandDefinition,
    arguments: &str,
) -> AppResult<String> {
    let parsed_arguments = split_shell_arguments(arguments)?;
    let argument_text = parsed_arguments.join(" ");
    let mut rendered = definition.content.clone();
    rendered = rendered.replace(
        "${CLAUDE_SKILL_DIR}",
        &Path::new(&definition.path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    for (index, value) in parsed_arguments.iter().enumerate().rev() {
        rendered = rendered.replace(&format!("$ARGUMENTS[{index}]"), value);
        rendered = rendered.replace(&format!("${index}"), value);
    }
    rendered = rendered.replace("$ARGUMENTS", &argument_text);
    let mut named_arguments = definition
        .argument_names
        .iter()
        .enumerate()
        .collect::<Vec<_>>();
    named_arguments.sort_by_key(|(_, name)| std::cmp::Reverse(name.len()));
    for (index, name) in named_arguments {
        if let Some(value) = parsed_arguments.get(index) {
            rendered = rendered.replace(&format!("${name}"), value);
        }
    }

    let has_argument_placeholder = definition.content.contains("$ARGUMENTS")
        || (0..parsed_arguments.len()).any(|position| {
            definition
                .content
                .contains(&format!("$ARGUMENTS[{position}]"))
                || definition.content.contains(&format!("${position}"))
        })
        || definition
            .argument_names
            .iter()
            .any(|name| definition.content.contains(&format!("${name}")));
    if !argument_text.is_empty() && !has_argument_placeholder {
        rendered = format!("{}\n\nARGUMENTS: {}", rendered.trim_end(), argument_text);
    }
    Ok(rendered)
}

fn split_shell_arguments(source: &str) -> AppResult<Vec<String>> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote = None::<char>;
    let mut escaped = false;
    let mut argument_started = false;

    for character in source.chars() {
        if character.is_control() && character != '\t' {
            return Err(AppError::Validation(
                "Claude command arguments cannot contain control characters.".to_string(),
            ));
        }
        if escaped {
            current.push(character);
            escaped = false;
            argument_started = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if active_quote == '\'' {
                if character == active_quote {
                    quote = None;
                } else {
                    current.push(character);
                    argument_started = true;
                }
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
                argument_started = true;
            }
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            argument_started = true;
            continue;
        }
        if character.is_whitespace() {
            if argument_started {
                arguments.push(std::mem::take(&mut current));
                argument_started = false;
            }
            continue;
        }
        current.push(character);
        argument_started = true;
    }

    if escaped {
        return Err(AppError::Validation(
            "Claude command arguments cannot end with an escape character.".to_string(),
        ));
    }
    if quote.is_some() {
        return Err(AppError::Validation(
            "Claude command arguments must close quoted values.".to_string(),
        ));
    }
    if argument_started {
        arguments.push(current);
    }
    Ok(arguments)
}

fn is_identifier_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':' | '/')
}

fn is_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_claude_name(prefix: &str) -> String {
        let id = uuid::Uuid::now_v7().simple().to_string();
        format!("{prefix}-{}", &id[..12])
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("skein-composer-{}", uuid::Uuid::now_v7()));
            fs::create_dir_all(&path).expect("temp dir should be created");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn loads_claude_commands_and_skills_from_project_configuration() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("deploy");
        let skill_name = unique_claude_name("review");
        let command_root = test_dir.path.join(".claude").join("commands");
        let skill_root = test_dir
            .path
            .join(".claude")
            .join("skills")
            .join(&skill_name);
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::create_dir_all(&skill_root).expect("skill root should be created");
        fs::write(
            command_root.join(format!("{command_name}.md")),
            "---\ndescription: Deploy target\nargument-hint: <target>\n---\nDeploy $ARGUMENTS",
        )
        .expect("command should be written");
        fs::write(
            skill_root.join("SKILL.md"),
            format!(
                "---\nname: {skill_name}\ndescription: Review a path\narguments: [path]\n---\nReview $path"
            ),
        )
        .expect("skill should be written");

        let commands =
            load_claude_command_definitions(&test_dir.path.to_string_lossy()).expect("commands");
        let skills =
            load_claude_skill_definitions(&test_dir.path.to_string_lossy()).expect("skills");
        let catalog = build_claude_thread_catalog(&commands, &skills);

        assert!(catalog.prompts.iter().any(|prompt| {
            prompt.name == command_name && prompt.argument_hint.as_deref() == Some("<target>")
        }));
        assert!(catalog.skills.iter().any(|skill| skill.name == skill_name));
    }

    #[test]
    fn resolves_claude_slash_commands_and_dollar_skill_mentions() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("deploy");
        let skill_name = unique_claude_name("review");
        let command_root = test_dir.path.join(".claude").join("commands");
        let skill_root = test_dir
            .path
            .join(".claude")
            .join("skills")
            .join(&skill_name);
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::create_dir_all(&skill_root).expect("skill root should be created");
        fs::write(
            command_root.join(format!("{command_name}.md")),
            "Deploy to $0 as $1",
        )
        .expect("command should be written");
        fs::write(
            skill_root.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: Review\n---\nReview the current task"),
        )
        .expect("skill should be written");

        let visible = format!("Run /{command_name} production canary\nUse ${skill_name} too");
        let resolved =
            resolve_claude_composer_text(&test_dir.path.to_string_lossy(), &visible).expect("text");

        assert!(resolved.contains("Deploy to production as canary"));
        assert!(resolved.contains("Use Review the current task too"));
    }

    #[test]
    fn parses_multiline_claude_argument_frontmatter() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("fix");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(
            command_root.join(format!("{command_name}.md")),
            format!(
                "---\nname: {command_name}\narguments:\n  - issue\n  - path\n---\nFix $issue in $path"
            ),
        )
        .expect("command should be written");

        let commands =
            load_claude_command_definitions(&test_dir.path.to_string_lossy()).expect("commands");
        let resolved = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{command_name} BUG-123 src/lib.rs"),
        )
        .expect("command should resolve");

        assert!(commands.iter().any(|command| {
            command.name == command_name
                && command.argument_names == ["issue".to_string(), "path".to_string()]
                && command.argument_hint.as_deref() == Some("<issue> <path>")
        }));
        assert_eq!(resolved, "Fix BUG-123 in src/lib.rs");
    }

    #[test]
    fn first_seen_claude_definitions_win_name_collisions() {
        let project_root = TestDir::new();
        let user_root = TestDir::new();
        let command_name = unique_claude_name("deploy");
        let mut commands = HashMap::new();
        fs::write(
            project_root.path.join(format!("{command_name}.md")),
            "Project command",
        )
        .expect("project command should be written");
        fs::write(
            user_root.path.join(format!("{command_name}.md")),
            "User command",
        )
        .expect("user command should be written");

        load_claude_commands_from_root(&project_root.path, &mut commands)
            .expect("project command root should load");
        load_claude_commands_from_root(&user_root.path, &mut commands)
            .expect("user command root should load");

        assert_eq!(
            commands
                .get(&command_name)
                .map(|command| command.content.as_str()),
            Some("Project command")
        );
    }

    #[test]
    fn skips_claude_definitions_with_invalid_fallback_names() {
        let test_dir = TestDir::new();
        let command_root = test_dir.path.join(".claude").join("commands");
        let invalid_skill_root = test_dir.path.join(".claude").join("skills").join("fix bug");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::create_dir_all(&invalid_skill_root).expect("skill root should be created");
        fs::write(command_root.join("fix bug.md"), "Bad command")
            .expect("command should be written");
        fs::write(invalid_skill_root.join("SKILL.md"), "Bad skill")
            .expect("skill should be written");

        let mut commands = HashMap::new();
        let mut skills = HashMap::new();
        load_claude_commands_from_root(&command_root, &mut commands).expect("commands");
        load_claude_skills_from_root(&test_dir.path.join(".claude").join("skills"), &mut skills)
            .expect("skills");

        assert!(commands.is_empty());
        assert!(skills.is_empty());
    }

    #[test]
    fn same_root_claude_skill_collisions_are_sorted_by_directory() {
        let test_dir = TestDir::new();
        let skill_name = unique_claude_name("shared");
        let first_skill = test_dir.path.join(".claude").join("skills").join("alpha");
        let second_skill = test_dir.path.join(".claude").join("skills").join("zeta");
        fs::create_dir_all(&first_skill).expect("first skill root should be created");
        fs::create_dir_all(&second_skill).expect("second skill root should be created");
        fs::write(
            first_skill.join("SKILL.md"),
            format!("---\nname: {skill_name}\n---\nFirst skill"),
        )
        .expect("first skill should be written");
        fs::write(
            second_skill.join("SKILL.md"),
            format!("---\nname: {skill_name}\n---\nSecond skill"),
        )
        .expect("second skill should be written");

        let mut skills = HashMap::new();
        load_claude_skills_from_root(&test_dir.path.join(".claude").join("skills"), &mut skills)
            .expect("skills");

        assert_eq!(skills.len(), 1);
        assert_eq!(
            skills.get(&skill_name).map(|skill| skill.content.as_str()),
            Some("First skill")
        );
    }

    #[test]
    fn replaces_longer_claude_named_arguments_before_prefixes() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("paths");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(
            command_root.join(format!("{command_name}.md")),
            "---\narguments: [path, path_suffix]\n---\nMove $path to $path_suffix",
        )
        .expect("command should be written");

        let resolved = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{command_name} src dst"),
        )
        .expect("command should resolve");

        assert_eq!(resolved, "Move src to dst");
    }

    #[test]
    fn keeps_claude_skills_exclusive_to_dollar_mentions() {
        let test_dir = TestDir::new();
        let shared_name = unique_claude_name("shared");
        let command_root = test_dir.path.join(".claude").join("commands");
        let skill_root = test_dir
            .path
            .join(".claude")
            .join("skills")
            .join(&shared_name);
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::create_dir_all(&skill_root).expect("skill root should be created");
        fs::write(
            command_root.join(format!("{shared_name}.md")),
            "Command content",
        )
        .expect("command should be written");
        fs::write(
            skill_root.join("SKILL.md"),
            format!("---\nname: {shared_name}\n---\nSkill content"),
        )
        .expect("skill should be written");

        let commands =
            load_claude_command_definitions(&test_dir.path.to_string_lossy()).expect("commands");
        let skills =
            load_claude_skill_definitions(&test_dir.path.to_string_lossy()).expect("skills");
        let catalog = build_claude_thread_catalog(&commands, &skills);
        let slash = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{shared_name}"),
        )
        .expect("slash command should resolve");
        let dollar = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("${shared_name}"),
        )
        .expect("dollar skill should resolve");

        assert!(catalog
            .prompts
            .iter()
            .any(|prompt| prompt.name == shared_name));
        assert!(catalog.skills.iter().any(|skill| skill.name == shared_name));
        assert_eq!(slash, "Command content");
        assert_eq!(dollar, "Skill content");
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_claude_command_directories() {
        use std::os::unix::fs::symlink;

        let test_dir = TestDir::new();
        let outside_dir = TestDir::new();
        let command_name = unique_claude_name("outside");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(
            outside_dir.path.join(format!("{command_name}.md")),
            "Outside command",
        )
        .expect("outside command should be written");
        symlink(&outside_dir.path, command_root.join("linked"))
            .expect("symlinked command directory should be created");

        let commands =
            load_claude_command_definitions(&test_dir.path.to_string_lossy()).expect("commands");

        assert!(!commands.iter().any(|command| command.name == command_name));
    }

    #[test]
    fn preserves_single_quoted_backslashes_in_claude_arguments() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("path");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(command_root.join(format!("{command_name}.md")), "Path: $0")
            .expect("command should be written");

        let resolved = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{command_name} 'C:\\tmp\\foo'"),
        )
        .expect("argument should resolve");

        assert_eq!(resolved, "Path: C:\\tmp\\foo");
    }

    #[test]
    fn preserves_empty_quoted_claude_arguments() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("deploy");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(
            command_root.join(format!("{command_name}.md")),
            "First:$0 Second:$1 Third:$2",
        )
        .expect("command should be written");

        let resolved = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{command_name} \"\" value ''"),
        )
        .expect("argument should resolve");

        assert_eq!(resolved, "First: Second:value Third:");
    }

    #[test]
    fn rejects_malformed_claude_command_arguments() {
        let test_dir = TestDir::new();
        let command_name = unique_claude_name("deploy");
        let command_root = test_dir.path.join(".claude").join("commands");
        fs::create_dir_all(&command_root).expect("command root should be created");
        fs::write(command_root.join(format!("{command_name}.md")), "Deploy $0")
            .expect("command should be written");

        let error = resolve_claude_composer_text(
            &test_dir.path.to_string_lossy(),
            &format!("/{command_name} \"unterminated"),
        )
        .expect_err("unterminated quote should be rejected");

        assert!(error
            .to_string()
            .contains("Claude command arguments must close quoted values"));
    }
}
