/** Terraform/HCL symbols and traversals over the bundled tree-sitter grammar.
 *
 * HCL's grammar exposes all declarations as generic `block` nodes rather than
 * language-specific definitions. Keep the naming rules here so a resource and
 * its references use the same qualified name, even across .tf files.
 */
import { contentHash } from "../util/id.js";
import type { ExtractResult, RawEdge } from "./extract.js";
import type { TsNode } from "./generic.js";
import type { Kind, NodeV1 } from "./types.js";

function children(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const child = node.namedChild?.(i);
    if (child) out.push(child);
  }
  return out;
}

function label(node: TsNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type !== "string_lit") return null;
  try { return JSON.parse(node.text) as string; }
  catch { return null; } // Invalid/dynamic labels must not mint guessed symbols.
}

function blockName(block: TsNode): { name: string; kind: Kind } | null {
  const header = children(block).filter((child) => child.type === "identifier" || child.type === "string_lit");
  const keyword = header.shift()?.text;
  const labels = header.map(label);
  if (labels.some((part) => !part)) return null;
  const [first, second] = labels;
  if (keyword === "resource" && first && second) return { name: `${first}.${second}`, kind: "variable" };
  if (keyword === "data" && first && second) return { name: `data.${first}.${second}`, kind: "variable" };
  if (keyword === "variable" && first) return { name: `var.${first}`, kind: "variable" };
  if (keyword === "output" && first) return { name: `output.${first}`, kind: "variable" };
  if (keyword === "module" && first) return { name: `module.${first}`, kind: "module" };
  if (keyword === "provider" && first) return { name: `provider.${first}`, kind: "module" };
  // Other HCL consumers (for example Terragrunt) define their own block names.
  // Preserve top-level blocks as searchable symbols without guessing semantics.
  if (keyword && !["resource", "data", "variable", "output", "module", "provider", "locals"].includes(keyword))
    return { name: [keyword, ...labels].join("."), kind: "module" };
  return null;
}

function traversal(node: TsNode): string | null {
  if (node.type !== "expression") return null;
  const parts = children(node);
  if (parts[0]?.type !== "variable_expr") return null;
  const root = children(parts[0]).find((child) => child.type === "identifier")?.text;
  const attrs = parts.slice(1).filter((child) => child.type === "get_attr")
    .map((child) => children(child).find((part) => part.type === "identifier")?.text);
  if (!root || attrs.some((part) => !part)) return null;
  if ((root === "var" || root === "local" || root === "module") && attrs[0]) return `${root}.${attrs[0]}`;
  if (root === "data" && attrs[0] && attrs[1]) return `data.${attrs[0]}.${attrs[1]}`;
  // Terraform's built-in namespaces are not definitions in the source graph.
  if (["path", "terraform", "count", "each", "self"].includes(root)) return null;
  return attrs[0] ? `${root}.${attrs[0]}` : null;
}

export function extractTerraform(root: TsNode, rel: string, source: string, file: NodeV1): ExtractResult {
  const nodes: NodeV1[] = [file];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const lines = source.split("\n");
  const definitions: Array<{ id: string; node: TsNode }> = [];
  const define = (name: string, kind: Kind, node: TsNode): void => {
    const base = `${rel}#${name}`;
    let id = base, suffix = 2;
    while (minted.has(id)) id = `${base}~${suffix++}`;
    minted.add(id);
    const signature = (lines[node.startPosition.row] ?? "").trim().replace(/\s*\{\s*$/, "");
    nodes.push({
      id, name, kind, path: rel,
      span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
      signature: signature || null, exported: true, origin: "generic",
      body_hash: contentHash(source.slice(node.startIndex, node.endIndex)),
      body_text: source.slice(node.startIndex, node.endIndex).replace(/\s+/g, " ").slice(0, 5000),
      summary_state: "pending", summary: null, crux: null,
    });
    definitions.push({ id, node });
  };

  const body = children(root).find((child) => child.type === "body");
  for (const node of body ? children(body) : []) {
    if (node.type === "block") {
      const header = children(node);
      if (header[0]?.text === "locals") {
        const localBody = header.find((child) => child.type === "body");
        for (const attr of localBody ? children(localBody) : []) {
          if (attr.type !== "attribute") continue;
          const name = children(attr).find((child) => child.type === "identifier")?.text;
          if (name) define(`local.${name}`, "variable", attr);
        }
      } else {
        const descriptor = blockName(node);
        if (descriptor) define(descriptor.name, descriptor.kind, node);
      }
    } else if (node.type === "attribute" && /\.tfvars$/i.test(rel)) {
      const name = children(node).find((child) => child.type === "identifier")?.text;
      if (name) define(`input.${name}`, "variable", node);
    }
  }

  for (const definition of definitions) {
    const visit = (node: TsNode): void => {
      const name = traversal(node);
      if (name) rawEdges.push({ source: definition.id, relation: "references", file: rel, name });
      for (const child of children(node)) visit(child);
    };
    visit(definition.node);
  }
  return { nodes, rawEdges };
}
