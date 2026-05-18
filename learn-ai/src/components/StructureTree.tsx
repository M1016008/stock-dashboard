"use client";

import { useState } from "react";
import type { StructureNode } from "@/lib/ai/structure";

interface Props {
  nodes: StructureNode[];
  onSelect: (node: StructureNode, key: string) => void;
  selectedKey: string | null;
  depth?: number;
  pathPrefix?: string;
}

export function StructureTree({
  nodes,
  onSelect,
  selectedKey,
  depth = 0,
  pathPrefix = "",
}: Props) {
  return (
    <ul className={depth === 0 ? "space-y-1" : "ml-4 mt-1 space-y-1"}>
      {nodes.map((node, i) => {
        const key = `${pathPrefix}/${i}`;
        return (
          <TreeNode
            key={key}
            nodeKey={key}
            node={node}
            onSelect={onSelect}
            selectedKey={selectedKey}
            depth={depth}
          />
        );
      })}
    </ul>
  );
}

function TreeNode({
  node,
  nodeKey,
  onSelect,
  selectedKey,
  depth,
}: {
  node: StructureNode;
  nodeKey: string;
  onSelect: (node: StructureNode, key: string) => void;
  selectedKey: string | null;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isSelected = selectedKey === nodeKey;

  return (
    <li>
      <div
        className={`flex items-start gap-1 group rounded-md px-1.5 py-1 ${
          isSelected
            ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`mt-0.5 w-4 text-xs ${
            hasChildren ? "" : "invisible"
          } ${isSelected ? "" : "text-zinc-400"}`}
          aria-label={open ? "閉じる" : "開く"}
        >
          {open ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node, nodeKey)}
          className="flex-1 text-left text-sm leading-snug"
        >
          <span className="font-medium">{node.title}</span>
          {node.summary && (
            <span
              className={`block text-xs mt-0.5 ${
                isSelected
                  ? "text-zinc-200 dark:text-zinc-600"
                  : "text-zinc-500"
              }`}
            >
              {node.summary}
            </span>
          )}
        </button>
      </div>
      {hasChildren && open && (
        <StructureTree
          nodes={node.children!}
          onSelect={onSelect}
          selectedKey={selectedKey}
          depth={depth + 1}
          pathPrefix={nodeKey}
        />
      )}
    </li>
  );
}
