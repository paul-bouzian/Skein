export type ShortcutDefinition = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  mod: boolean;
};

const MODIFIER_ORDER = ["mod", "cmd", "ctrl", "alt", "shift"] as const;
const MODIFIER_LABELS_MAC: Record<(typeof MODIFIER_ORDER)[number], string> = {
  mod: "⌘",
  cmd: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const MODIFIER_LABELS_OTHER: Record<(typeof MODIFIER_ORDER)[number], string> = {
  mod: "Ctrl",
  cmd: "Meta",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

const MODIFIER_TOKENS = new Set([
  "mod",
  "cmd",
  "meta",
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
]);

const KEY_LABELS: Record<string, string> = {
  plus: "+",
  comma: ",",
  period: ".",
  slash: "/",
  backquote: "`",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};
const ELECTRON_ACCELERATOR_KEYS: Record<string, string> = {
  plus: "Plus",
  comma: ",",
  period: ".",
  slash: "/",
  backquote: "`",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return /mac/i.test(
    nav.userAgentData?.platform ?? navigator.platform ?? "",
  );
}

export function parseShortcut(
  value: string | null | undefined,
): ShortcutDefinition | null {
  if (!value) {
    return null;
  }
  const tokens = value
    .trim()
    .split("+")
    .map((token) => token.trim().toLowerCase());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return null;
  }

  let key: string | null = null;
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let mod = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        meta = true;
        break;
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "mod":
        mod = true;
        break;
      default:
        if (key != null) {
          return null;
        }
        key = normalizeKeyToken(token);
    }
  }

  if (!key || MODIFIER_TOKENS.has(key)) {
    return null;
  }

  const hasPrimaryModifier = meta || ctrl || alt || mod;
  if (!hasPrimaryModifier && !(shift && key === "tab")) {
    return null;
  }

  return { key, meta, ctrl, alt, shift, mod };
}

export function formatShortcut(value: string | null | undefined): string {
  if (!value) {
    return "Not set";
  }
  const parsed = parseShortcut(value);
  if (!parsed) {
    return value;
  }
  const mac = isMacPlatform();
  const labels = mac ? MODIFIER_LABELS_MAC : MODIFIER_LABELS_OTHER;
  const parts = MODIFIER_ORDER.flatMap((modifier) => {
    if (modifier === "mod" && parsed.mod) {
      return labels.mod;
    }
    if (modifier === "cmd" && parsed.meta) {
      return labels.cmd;
    }
    if (modifier === "ctrl" && parsed.ctrl) {
      return labels.ctrl;
    }
    if (modifier === "alt" && parsed.alt) {
      return labels.alt;
    }
    if (modifier === "shift" && parsed.shift) {
      return labels.shift;
    }
    return [];
  });
  const uniqueParts = parts.filter((part, index) => parts.indexOf(part) === index);
  const keyLabel =
    KEY_LABELS[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return mac
    ? [...uniqueParts, keyLabel].join("")
    : [...uniqueParts, keyLabel].join("+");
}

export function toElectronAccelerator(
  value: string | null | undefined,
): string | undefined {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return undefined;
  }

  const modifiers = [
    parsed.mod ? "CommandOrControl" : null,
    parsed.meta ? "Command" : null,
    parsed.ctrl ? "Control" : null,
    parsed.alt ? "Alt" : null,
    parsed.shift ? "Shift" : null,
  ].filter((modifier): modifier is string => Boolean(modifier));
  const key =
    ELECTRON_ACCELERATOR_KEYS[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : null);
  if (!key) {
    return undefined;
  }

  return [...modifiers, key].join("+");
}

export function buildShortcutValue(event: KeyboardEvent): string | null {
  const key = normalizeKeyboardEventKey(event);
  if (!key) {
    return null;
  }
  const hasPrimaryModifier = event.metaKey || event.ctrlKey || event.altKey;
  if (!hasPrimaryModifier && !(event.shiftKey && key === "tab")) {
    return null;
  }

  const mac = isMacPlatform();
  const modifiers: string[] = [];
  if ((mac && event.metaKey) || (!mac && event.ctrlKey)) {
    modifiers.push("mod");
  }
  if (!mac && event.metaKey) {
    modifiers.push("cmd");
  }
  if (mac && event.ctrlKey) {
    modifiers.push("ctrl");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }

  const normalizedModifiers = modifiers.filter(
    (modifier, index) => modifiers.indexOf(modifier) === index,
  );
  return [...normalizedModifiers, key].join("+");
}

export function matchesShortcut(
  event: KeyboardEvent,
  value: string | null | undefined,
): boolean {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return false;
  }
  const key = normalizeKeyboardEventKey(event);
  if (!key || key !== parsed.key) {
    return false;
  }
  const mac = isMacPlatform();
  const expectedMeta = parsed.meta || (parsed.mod && mac);
  const expectedCtrl = parsed.ctrl || (parsed.mod && !mac);

  return (
    expectedMeta === event.metaKey &&
    expectedCtrl === event.ctrlKey &&
    parsed.alt === event.altKey &&
    parsed.shift === event.shiftKey
  );
}

export function shortcutSignature(
  value: string | null | undefined,
): string | null {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return null;
  }
  const mac = isMacPlatform();
  return [
    parsed.key,
    parsed.meta || (parsed.mod && mac),
    parsed.ctrl || (parsed.mod && !mac),
    parsed.alt,
    parsed.shift,
  ].join(":");
}

function normalizeKeyboardEventKey(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (MODIFIER_TOKENS.has(key)) {
    return null;
  }
  return normalizeKeyToken(key);
}

function normalizeKeyToken(token: string): string {
  switch (token) {
    case "+":
    case "plus":
      return "plus";
    case "{":
      return "[";
    case "}":
      return "]";
    case ",":
    case "comma":
      return "comma";
    case ".":
    case "period":
      return "period";
    case "/":
    case "slash":
      return "slash";
    case "`":
    case "backquote":
      return "backquote";
    case "esc":
    case "escape":
      return "escape";
    case "return":
    case "enter":
      return "enter";
    case " ":
    case "space":
      return "space";
    case "up":
    case "arrowup":
      return "arrowup";
    case "down":
    case "arrowdown":
      return "arrowdown";
    case "left":
    case "arrowleft":
      return "arrowleft";
    case "right":
    case "arrowright":
      return "arrowright";
    default:
      return token;
  }
}
