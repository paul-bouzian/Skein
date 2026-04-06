import { renderTextWithExternalLinks } from "./conversation-links";

type ConversationLinkedTextTag = "div" | "p" | "pre" | "span";

type ConversationLinkedTextProps = {
  text: string;
  className?: string;
  as?: ConversationLinkedTextTag;
};

export function ConversationLinkedText({
  text,
  className,
  as = "span",
}: ConversationLinkedTextProps) {
  const Component = as;

  return (
    <Component className={className}>
      {renderTextWithExternalLinks(text, `${as}-linked-text`)}
    </Component>
  );
}
