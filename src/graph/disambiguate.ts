import type { EdgeDisambiguator, AmbiguousEdge } from "../ai/decisions.js";
import type { RawEdge } from "./extract.js";
import { reachable } from "./resolve.js";
import type { EdgeV1, Kind, NodeV1 } from "./types.js";

const MAX_EDGE_CANDIDATES = 64;

function allowedKinds(edge: RawEdge): readonly Kind[] | null {
  if (edge.relation === "extends") return ["class", "interface"];
  if (edge.relation === "implements") return ["interface", "trait"];
  if (edge.relation === "calls") return edge.kinds ?? (edge.viaMember ? ["method"] : ["function"]);
  if (edge.relation === "references") return null;
  return [];
}

/**
 * Recover only edges for which deterministic extraction produced a bounded,
 * concrete candidate set but refused to guess. The hook never supplies ids.
 */
export async function disambiguateEdges(
  nodes: readonly NodeV1[],
  rawEdges: readonly RawEdge[],
  resolved: readonly EdgeV1[],
  disambiguator: EdgeDisambiguator,
): Promise<EdgeV1[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byName = new Map<string, NodeV1[]>();
  for (const node of nodes) {
    const list = byName.get(node.name);
    if (list) list.push(node);
    else byName.set(node.name, [node]);
  }
  const existing = new Set(resolved.map((edge) => `${edge.source}\0${edge.relation}\0${edge.target}`));
  const seen = new Set<string>();
  const ambiguities: AmbiguousEdge[] = [];
  const targets = new Map<string, Map<string, NodeV1>>();

  for (const edge of rawEdges) {
    if (!edge.name) continue;
    const kinds = allowedKinds(edge);
    if (kinds?.length === 0) continue;
    const candidates = (byName.get(edge.name) ?? []).filter(
      (candidate) =>
        candidate.id !== edge.source &&
        reachable(edge.file, candidate.path) &&
        (kinds === null || kinds.includes(candidate.kind)),
    );
    if (candidates.length < 2 || candidates.length > MAX_EDGE_CANDIDATES) continue;
    if (candidates.some((candidate) => existing.has(`${edge.source}\0${edge.relation}\0${candidate.id}`))) continue;
    const fingerprint = `${edge.source}\0${edge.relation}\0${edge.name}\0${candidates.map((candidate) => candidate.id).sort().join("\0")}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const source = byId.get(edge.source);
    if (!source) continue;
    const key = `e${ambiguities.length}`;
    const choices = new Map<string, NodeV1>();
    const mapped = candidates
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((candidate, index) => {
        const candidateKey = `c${index}`;
        choices.set(candidateKey, candidate);
        return {
          key: candidateKey,
          id: candidate.id,
          path: candidate.path,
          kind: candidate.kind,
          signature: candidate.signature,
          body: candidate.body_text,
        };
      });
    targets.set(key, choices);
    ambiguities.push({
      key,
      source: { id: source.id, path: source.path, signature: source.signature, body: source.body_text },
      relation: edge.relation,
      name: edge.name,
      candidates: mapped,
    });
  }

  if (ambiguities.length === 0) return [];
  const decisions = await disambiguator.choose({ ambiguities });
  const ambiguityByKey = new Map(ambiguities.map((ambiguity) => [ambiguity.key, ambiguity]));
  const added: EdgeV1[] = [];
  for (const decision of decisions) {
    if (decision.candidateKey === null) continue;
    const ambiguity = ambiguityByKey.get(decision.ambiguityKey);
    const target = targets.get(decision.ambiguityKey)?.get(decision.candidateKey);
    if (!ambiguity || !target) continue;
    const key = `${ambiguity.source.id}\0${ambiguity.relation}\0${target.id}`;
    if (existing.has(key)) continue;
    existing.add(key);
    added.push({
      source: ambiguity.source.id,
      target: target.id,
      relation: ambiguity.relation,
      confidence: "semantic",
    });
  }
  return added;
}
