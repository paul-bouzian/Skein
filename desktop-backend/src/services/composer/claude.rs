use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::conversation::{
    ComposerPromptArgumentMode, ComposerPromptOption, ComposerSkillOption, ThreadComposerCatalog,
};
use crate::error::AppResult;

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
        load_claude_commands_from_root(&root, &mut commands)?;
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
        load_claude_skills_from_root(&root, &mut skills)?;
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
    let skill_names = skills
        .iter()
        .map(|skill| skill.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    ThreadComposerCatalog {
        prompts: commands
            .iter()
            .filter(|command| !skill_names.contains(&command.name.to_ascii_lowercase()))
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
    for skill in &skills {
        slash_map.insert(skill.name.to_ascii_lowercase(), skill);
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
        output.push_str(&render_claude_definition(definition, arguments));
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
        let Some(fallback_name) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::trim)
            .filter(|stem| !stem.is_empty())
        else {
            continue;
        };
        let raw = fs::read_to_string(&path)?;
        let parsed =
            parse_claude_definition_file(&raw, fallback_name, path.to_string_lossy().as_ref());
        commands.insert(parsed.name.to_ascii_lowercase(), parsed);
    }
    Ok(())
}

fn load_claude_skills_from_root(
    root: &Path,
    skills: &mut HashMap<String, ClaudeCommandDefinition>,
) -> AppResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let path = directory.join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let Some(fallback_name) = directory
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let raw = fs::read_to_string(&path)?;
        let parsed =
            parse_claude_definition_file(&raw, fallback_name, path.to_string_lossy().as_ref());
        skills.insert(parsed.name.to_ascii_lowercase(), parsed);
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
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_markdown_files(&path, files)?;
            continue;
        }
        if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
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
    let value = frontmatter_scalar(frontmatter, "arguments")?;
    let trimmed = value.trim();
    let arguments = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        trimmed[1..trimmed.len().saturating_sub(1)]
            .split(',')
            .map(|part| unquote_scalar(part.trim()).to_string())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
    } else {
        trimmed
            .split_whitespace()
            .map(unquote_scalar)
            .filter(|part| !part.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };
    (!arguments.is_empty()).then_some(arguments)
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
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn render_claude_definition(definition: &ClaudeCommandDefinition, arguments: &str) -> String {
    let parsed_arguments = split_shell_arguments(arguments);
    let mut rendered = definition.content.clone();
    rendered = rendered.replace(
        "${CLAUDE_SKILL_DIR}",
        &Path::new(&definition.path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    for (index, value) in parsed_arguments.iter().enumerate().rev() {
        let position = index + 1;
        rendered = rendered.replace(&format!("$ARGUMENTS[{index}]"), value);
        rendered = rendered.replace(&format!("$ARGUMENTS[{position}]"), value);
        rendered = rendered.replace(&format!("${position}"), value);
    }
    rendered = rendered.replace("$ARGUMENTS", arguments);
    for (index, name) in definition.argument_names.iter().enumerate() {
        if let Some(value) = parsed_arguments.get(index) {
            rendered = rendered.replace(&format!("${name}"), value);
        }
    }

    let has_argument_placeholder = definition.content.contains("$ARGUMENTS")
        || (1..=parsed_arguments.len())
            .any(|position| definition.content.contains(&format!("${position}")))
        || definition
            .argument_names
            .iter()
            .any(|name| definition.content.contains(&format!("${name}")));
    if !arguments.is_empty() && !has_argument_placeholder {
        rendered = format!("{}\n\nARGUMENTS: {}", rendered.trim_end(), arguments);
    }
    rendered
}

fn split_shell_arguments(source: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote = None::<char>;
    let mut escaped = false;

    for character in source.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            continue;
        }
        if character.is_whitespace() {
            if !current.is_empty() {
                arguments.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(character);
    }

    if !current.is_empty() {
        arguments.push(current);
    }
    arguments
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
            "Deploy to $1 as $2",
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
}
