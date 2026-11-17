import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import PersonAvatar from "./PersonAvatar";

/** Inline chip rendered for a mention node — avatar + name. */
export default function MentionChip({ node }: NodeViewProps) {
  const label = node.attrs.label as string;
  const email = node.attrs.email as string | null;
  return (
    <NodeViewWrapper as="span" className="inline-flex items-baseline align-baseline mx-px">
      <span
        data-mention
        title={email ?? undefined}
        className="inline-flex items-center gap-1 rounded-md border border-default/70 bg-text-primary/4 px-1 py-px text-[0.85em] font-medium leading-tight text-primary/80 whitespace-nowrap"
      >
        <PersonAvatar email={email} displayName={label} size={13} />
        {label}
      </span>
    </NodeViewWrapper>
  );
}
