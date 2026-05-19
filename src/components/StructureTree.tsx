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
    <ul
      className={
        depth === 0
          ? "space-y-2"
          : "ml-5 mt-2 space-y-2 border-l border-slate-200 pl-3"
      }
    >
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
    <li className="relative">
      <div
        className={`group flex items-start gap-2 rounded-xl border px-3 py-2 transition ${
          isSelected
            ? "border-teal-300 bg-teal-50 text-slate-950 shadow-sm"
            : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full text-xs ${
            hasChildren ? "" : "invisible"
          } ${isSelected ? "bg-white text-teal-700" : "bg-slate-100 text-slate-400"}`}
          aria-label={open ? "閉じる" : "開く"}
        >
          {open ? "−" : "+"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node, nodeKey)}
          className="flex-1 text-left text-sm leading-snug"
        >
          <span className="font-semibold">{node.title}</span>
          {node.summary && (
            <span
              className={`mt-1 block text-xs leading-5 ${
                isSelected ? "text-teal-800" : "text-slate-500"
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
