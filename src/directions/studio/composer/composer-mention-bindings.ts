import type {
  ComposerDraftMentionBinding,
  ComposerMentionBindingInput,
} from "../../../lib/types";
import type { ComposerAutocompleteItem } from "./composer-model";
export type { ComposerDraftMentionBinding } from "../../../lib/types";

export function rebaseComposerMentionBindings(
  previousText: string,
  nextText: string,
  bindings: ComposerDraftMentionBinding[],
): ComposerDraftMentionBinding[] {
  if (bindings.length === 0) {
    return [];
  }

  const prefixLength = commonPrefixLength(previousText, nextText);
  const suffixLength = commonSuffixLength(previousText, nextText, prefixLength);
  const previousEditEnd = previousText.length - suffixLength;
  const nextEditEnd = nextText.length - suffixLength;
  const delta = nextEditEnd - previousEditEnd;

  return bindings
    .flatMap((binding) => {
      if (binding.end <= prefixLength) {
        return [binding];
      }
      if (binding.start >= previousEditEnd) {
        return [
          {
            ...binding,
            start: binding.start + delta,
            end: binding.end + delta,
          },
        ];
      }
      if (binding.start < prefixLength && binding.end >= previousEditEnd) {
        return [
          {
            ...binding,
            end: binding.end + delta,
          },
        ];
      }
      return [];
    })
    .filter((binding) => isValidMentionBinding(nextText, binding))
    .sort((left, right) => left.start - right.start);
}

export function addComposerMentionBinding(
  bindings: ComposerDraftMentionBinding[],
  item: ComposerAutocompleteItem,
  tokenStart: number,
): ComposerDraftMentionBinding[] {
  if (!item.mentionBinding) {
    return bindings;
  }

  const nextBinding = {
    ...item.mentionBinding,
    start: tokenStart,
    end: tokenStart + item.insertText.length,
  };

  return [
    ...bindings.filter(
      (binding) => binding.start !== nextBinding.start || binding.end !== nextBinding.end,
    ),
    nextBinding,
  ].sort((left, right) => left.start - right.start);
}

export function prepareComposerMentionBindingsForSend(
  text: string,
  bindings: ComposerDraftMentionBinding[],
): ComposerMentionBindingInput[] {
  return bindings
    .filter((binding) => isValidMentionBinding(text, binding))
    .sort((left, right) => left.start - right.start)
    .map(({ mention, kind, path }) => ({
      mention,
      kind,
      path,
    }));
}

export function sameComposerMentionBindings(
  left: ComposerDraftMentionBinding[],
  right: ComposerDraftMentionBinding[],
) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((binding, index) => sameComposerMentionBinding(binding, right[index])))
  );
}

function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number) {
  let length = 0;
  while (
    left.length - length - 1 >= prefixLength &&
    right.length - length - 1 >= prefixLength &&
    left[left.length - length - 1] === right[right.length - length - 1]
  ) {
    length += 1;
  }
  return length;
}

function isValidMentionBinding(text: string, binding: ComposerDraftMentionBinding) {
  if (
    text.slice(binding.start, binding.end).toLowerCase() !==
    `$${binding.mention}`.toLowerCase()
  ) {
    return false;
  }

  const previousCharacter = binding.start > 0 ? text[binding.start - 1] ?? "" : "";
  if (previousCharacter && /[A-Za-z0-9_:/-]/.test(previousCharacter)) {
    return false;
  }

  const nextCharacter = text[binding.end] ?? "";
  if (nextCharacter && /[A-Za-z0-9_:-]/.test(nextCharacter)) {
    return false;
  }

  return true;
}

function sameComposerMentionBinding(
  left: ComposerDraftMentionBinding,
  right: ComposerDraftMentionBinding | undefined,
) {
  return (
    right !== undefined &&
    left.mention === right.mention &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.start === right.start &&
    left.end === right.end
  );
}
