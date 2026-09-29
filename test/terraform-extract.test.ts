import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextDirFor } from "../src/context/node-file.js";
import { buildGraph } from "../src/graph/build.js";
import { extractGeneric, genericLangOf, isWarm, warmGenericGrammars } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const MAIN = `provider "aws" { region = var.region }
locals { env = "dev" }
resource "aws_s3_bucket" "logs" {
  bucket = "logs-\${var.region}"
  tags = { Env = local.env }
}
data "aws_caller_identity" "current" {}
module "network" {
  source = "./network"
  account = data.aws_caller_identity.current.account_id
}
output "bucket" { value = aws_s3_bucket.logs.id }
`;

test("Terraform and HCL extensions are routed to the bundled grammar", () => {
  for (const ext of [".tf", ".tfvars", ".hcl"]) {
    assert.equal(genericLangOf(`main${ext}`)?.name, "terraform");
    assert.ok(supportedExtensions().includes(ext));
  }
  assert.deepEqual(unsupportedExtensions(["tf", ".TFVARS", ".hcl"]), []);
});

test("Terraform blocks become qualified symbols and traversals resolve precisely", async () => {
  await warmGenericGrammars(["terraform"]);
  assert.ok(isWarm("terraform"));
  const variables = extractGeneric("variables.tf", 'variable "region" { type = string }\n', "terraform");
  const main = extractGeneric("main.tf", MAIN, "terraform");
  const all = [...variables.nodes, ...main.nodes];
  const names = main.nodes.slice(1).map((node) => node.name).sort();
  assert.deepEqual(names, [
    "aws_s3_bucket.logs", "data.aws_caller_identity.current", "local.env",
    "module.network", "output.bucket", "provider.aws",
  ]);
  for (const node of main.nodes.slice(1)) {
    assert.equal(node.origin, "generic");
    assert.match(node.span, /^L\d+-L\d+$/);
    assert.ok(node.signature);
  }
  const edges = resolveEdges(all, [...variables.rawEdges, ...main.rawEdges]);
  const references = edges.filter((edge) => edge.relation === "references")
    .map((edge) => `${edge.source}→${edge.target}`);
  assert.ok(references.includes("main.tf#provider.aws→variables.tf#var.region"));
  assert.ok(references.includes("main.tf#aws_s3_bucket.logs→variables.tf#var.region"));
  assert.ok(references.includes("main.tf#aws_s3_bucket.logs→main.tf#local.env"));
  assert.ok(references.includes("main.tf#module.network→main.tf#data.aws_caller_identity.current"));
  assert.ok(references.includes("main.tf#output.bucket→main.tf#aws_s3_bucket.logs"));
  assert.ok(!references.some((edge) => edge.includes("→path.") || edge.includes("→terraform.")));
});

test("Terraform variable values have distinct names from declarations", async () => {
  await warmGenericGrammars(["terraform"]);
  const values = extractGeneric("prod.TFVARS", 'region = "us-east-1"\n', "terraform");
  assert.deepEqual(values.nodes.slice(1).map((node) => node.name), ["input.region"]);
});

test("other HCL top-level blocks remain searchable without Terraform-specific guesses", async () => {
  await warmGenericGrammars(["terraform"]);
  const hcl = extractGeneric("terragrunt.hcl", 'include "root" { path = "../root.hcl" }\n', "terraform");
  assert.deepEqual(hcl.nodes.slice(1).map((node) => node.name), ["include.root"]);
});

test("a normal graph build indexes Terraform files and cross-file references", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-terraform-"));
  writeFileSync(join(root, "main.tf"), MAIN);
  writeFileSync(join(root, "variables.tf"), 'variable "region" { type = string }\n');
  writeFileSync(join(root, "prod.tfvars"), 'region = "us-east-1"\n');
  await buildGraph(root);
  const graph = readGraph(wiringPath(contextDirFor(root)));
  assert.ok(graph?.nodes.some((node) => node.id === "main.tf#aws_s3_bucket.logs"));
  assert.ok(graph?.nodes.some((node) => node.id === "prod.tfvars#input.region"));
  assert.ok(graph?.edges.some((edge) => edge.source === "main.tf#output.bucket" &&
    edge.target === "main.tf#aws_s3_bucket.logs" && edge.relation === "references"));
});
