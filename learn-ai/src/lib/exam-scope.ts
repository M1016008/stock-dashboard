import type { DocumentStructure, StructureNode } from "@/lib/ai/structure";

export interface ScopeInfo {
  nodes: StructureNode[];
  label: string;
}

function flatten(nodes: StructureNode[]): StructureNode[] {
  const out: StructureNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children && n.children.length > 0) {
      out.push(...flatten(n.children));
    }
  }
  return out;
}

export function resolveScope(
  structure: DocumentStructure,
  scopeKey: string | null,
): ScopeInfo {
  if (!scopeKey) {
    return {
      nodes: flatten(structure.nodes).filter(
        (n) => n.summary || n.excerpt,
      ),
      label: structure.title,
    };
  }

  const indices = scopeKey.split("/").filter(Boolean).map(Number);
  let cursor: StructureNode[] = structure.nodes;
  let target: StructureNode | null = null;
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= cursor.length) {
      target = null;
      break;
    }
    target = cursor[i];
    cursor = target.children ?? [];
  }

  if (!target) {
    return {
      nodes: flatten(structure.nodes).filter(
        (n) => n.summary || n.excerpt,
      ),
      label: structure.title,
    };
  }

  const subtree = [target, ...flatten(target.children ?? [])].filter(
    (n) => n.summary || n.excerpt,
  );
  return { nodes: subtree, label: target.title };
}

export function buildScopeText(nodes: StructureNode[]): string {
  return nodes
    .map((n) => {
      const parts = [`# ${n.title}`];
      if (n.summary) parts.push(n.summary);
      if (n.excerpt) parts.push(n.excerpt);
      return parts.join("\n");
    })
    .join("\n\n");
}
