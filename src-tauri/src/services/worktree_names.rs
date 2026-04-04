use rand::seq::SliceRandom;

const ADJECTIVES: &[&str] = &[
    "swift", "quiet", "bright", "fuzzy", "gentle", "bold", "calm", "eager", "fancy", "grand",
    "happy", "jolly", "keen", "lively", "merry", "noble", "proud", "quick", "rapid", "sharp",
    "smart", "snowy", "sunny", "sweet", "vivid", "warm", "wise", "young", "zesty", "agile",
    "brave", "clever", "daring", "epic", "fair", "golden", "honest", "iconic", "jade", "kindly",
    "loyal", "mighty", "neat", "open", "prime", "royal", "solid", "tidy", "ultra", "vital",
    "amber", "azure", "brisk", "coral", "crisp", "dusty", "elfin", "fiery", "fleet", "frosty",
    "gleam", "gusty", "hazy", "icy", "ivory", "jasper", "lunar", "maple", "misty", "mossy",
    "oaken", "opal", "peach", "plush", "polar", "rosy", "rusty", "sage", "sandy", "silky", "smoky",
    "spry", "stark", "steel", "stony", "stormy", "tawny", "terra", "vast", "velvet", "wild",
    "windy", "woody", "ashen", "cedar", "chalk", "dawn", "dusk", "ember", "frost", "gilt", "hazel",
    "honey", "indigo", "lemon", "lilac", "mint", "onyx", "pearl", "plum", "quartz", "ruby",
    "slate", "stone", "thorn", "topaz", "tulip", "umber", "zinc", "birch",
];

const ANIMALS: &[&str] = &[
    "tiger", "falcon", "otter", "eagle", "wolf", "bear", "lion", "hawk", "fox", "deer", "owl",
    "swan", "crane", "whale", "shark", "raven", "heron", "finch", "robin", "wren", "hound",
    "horse", "moose", "bison", "panda", "koala", "lemur", "sloth", "gecko", "viper", "cobra",
    "python", "salmon", "trout", "bass", "perch", "carp", "tuna", "squid", "crab", "seal",
    "walrus", "orca", "dolphin", "pelican", "parrot", "toucan", "condor", "osprey", "badger",
    "alpaca", "bobcat", "camel", "cheetah", "clam", "corgi", "coyote", "dingo", "dove", "drake",
    "egret", "elk", "ferret", "flamingo", "gannet", "gazelle", "gibbon", "goose", "grouse", "gull",
    "ibis", "iguana", "impala", "jackal", "jaguar", "kite", "lark", "linnet", "llama", "locust",
    "lynx", "macaw", "marten", "mink", "moth", "myna", "newt", "okapi", "oriole", "panther",
    "pigeon", "puffin", "quail", "rabbit", "raccoon", "ram", "shrike", "skunk", "snipe", "spider",
    "stork", "swift", "tern", "thrush", "toad", "turtle", "urchin", "wasp", "weasel", "yak",
    "zebra", "beetle", "mantis", "mole", "pika", "rook", "wombat", "starling",
];

pub fn generate_unique_worktree_name<F>(exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    let mut rng = rand::thread_rng();

    for _ in 0..100 {
        let adjective = ADJECTIVES.choose(&mut rng).copied().unwrap_or("swift");
        let animal = ANIMALS.choose(&mut rng).copied().unwrap_or("falcon");
        let candidate = format!("{adjective}-{animal}");
        if !exists(&candidate) {
            return candidate;
        }
    }

    loop {
        let adjective = ADJECTIVES.choose(&mut rng).copied().unwrap_or("swift");
        let animal = ANIMALS.choose(&mut rng).copied().unwrap_or("falcon");
        let suffix = rand::random::<u16>() % 10_000;
        let candidate = format!("{adjective}-{animal}-{suffix:04}");
        if !exists(&candidate) {
            return candidate;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::generate_unique_worktree_name;

    #[test]
    fn generated_names_follow_the_expected_shape() {
        let value = generate_unique_worktree_name(|_| false);
        let parts = value.split('-').collect::<Vec<_>>();
        assert!(parts.len() == 2 || parts.len() == 3);
        assert!(parts[0]
            .chars()
            .all(|character| character.is_ascii_lowercase()));
        assert!(parts[1]
            .chars()
            .all(|character| character.is_ascii_lowercase()));
    }

    #[test]
    fn generator_retries_until_name_is_available() {
        let taken = ["swift-falcon".to_string(), "fuzzy-tiger".to_string()];
        let value =
            generate_unique_worktree_name(|candidate| taken.iter().any(|item| item == candidate));
        assert!(!taken.iter().any(|item| item == &value));
    }
}
