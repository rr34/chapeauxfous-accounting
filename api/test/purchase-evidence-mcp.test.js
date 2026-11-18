import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_DATABASE = "accounting_test";

const { createAccountingMcpServer } = await import("../src/mcp.js");

const jobId = "4f876031-4622-4a28-8874-c86b286442a3";
const artifactId = "f47d345c-6c6f-4d9e-98e9-da6210cc1340";

function job(status, { matchedCount = 0, itemCount = 0 } = {}) {
  return {
    objectType: "accounting.purchase_evidence_job", id: jobId,
    sourceRef: `accounting://purchase-evidence-jobs/${jobId}`,
    displayName: `Ask Accountant · 2 selected · ${status}`, status,
    suspenseAccount: {
      objectType: "accounting.account", id: 279, sourceRef: "accounting://accounts/279",
      displayName: "Personal Assets:Zero:Ask Accountant", objectRole: "designated_suspense_account",
      currencyId: 1, currencyCode: "USD", scale: 2,
    },
    targetCount: 2, matchedCount, unmatchedCount: 2 - matchedCount, itemCount,
    canonicalArtifactId: status === "preview_ready" || status === "committed" ? artifactId : null,
    createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:05:00.000Z",
    committedAt: status === "committed" ? "2026-11-17T12:05:00.000Z" : null,
    copiedPrompt: `Process accounting://purchase-evidence-jobs/${jobId}`,
  };
}

test("purchase evidence MCP preserves exact targets, previews tax allocation, and requires confirmation", async () => {
  let boundArtifact = null;
  let removedArtifact = null;
  let submittedRecords = null;
  const canonicalRecord = {
    target_line_item_id: 325,
    sources: [{ kind: "email", source_ref: "email://messages/abc", source_record_id: "114-1",
      display_name: "Amazon order 114-1" }],
    merchant: "Amazon", purchase_date: "2026-09-30", charge_amount_decimal: "4.53",
    tax_amount_decimal: "0.33",
    items: [{ source_item_id: "item-1", description: "USB cable", quantity_decimal: "1",
      pre_tax_amount_decimal: "4.20" }],
  };
  const server = createAccountingMcpServer({
    personId: 7, pool: {}, artifactRoot: "/tmp/not-used", services: {
      async listPurchaseEvidenceJobObjectsPage() { return { objects: [job("ready")], nextCursor: null }; },
      async startPurchaseEvidenceJob() {
        return { job: job("processing"), targets: [{
          objectType: "accounting.line_item", id: 325, sourceRef: "accounting://line-items/325",
          displayName: "2026-09-30 · AMAZON RETAIL · 4.53 USD", objectRole: "purchase_evidence_target",
          lineItemId: 325, transactionId: 700, transactionDate: "2026-09-30",
          description: "AMAZON RETAIL", amountUnits: "453", amountDecimal: "4.53",
          absoluteChargeDecimal: "4.53", currencyCode: "USD", scale: 2,
          counterpartAccounts: ["Fifth Third x0360"],
        }] };
      },
      async readCompleteArtifact() {
        return { bytes: Buffer.from(`${JSON.stringify(canonicalRecord)}\n`),
          artifact: { media_type: "application/x-ndjson" } };
      },
      async bindArtifactToImportJob(input) { boundArtifact = input; },
      async removeArtifactUpload(input) { removedArtifact = input; },
      async submitPurchaseEvidencePreview(input) {
        submittedRecords = input.records;
        return job("preview_ready", { matchedCount: 1, itemCount: 1 });
      },
      async commitPurchaseEvidenceJob() {
        return { job: job("committed", { matchedCount: 1, itemCount: 1 }), changed: true,
          matchedChargeCount: 1, createdLineCount: 0, resultingItemCount: 1 };
      },
      async restartPurchaseEvidenceJob() {
        return { job: job("ready"), removedCanonicalArtifactId: artifactId };
      },
    },
  });
  const client = new Client({ name: "purchase-evidence-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const resolved = await client.callTool({ name: "list_purchase_evidence_job_objects",
      arguments: { purchase_evidence_job_id: jobId } });
    assert.equal(resolved.structuredContent.objects[0].id, jobId);

    const started = await client.callTool({ name: "start_purchase_evidence_job",
      arguments: { purchase_evidence_job_id: jobId } });
    assert.equal(started.structuredContent.targets[0].objectRole, "purchase_evidence_target");
    assert.equal(started.structuredContent.job.suspenseAccount.objectRole, "designated_suspense_account");
    assert.equal(started.structuredContent.artifactUpload.transportId, "purchase_evidence_job");

    const previewed = await client.callTool({ name: "submit_purchase_evidence_job_artifact",
      arguments: { purchase_evidence_job_id: jobId, artifact_id: artifactId } });
    assert.deepEqual(submittedRecords, [canonicalRecord]);
    assert.equal(boundArtifact.importJobId, jobId);
    assert.equal(previewed.structuredContent.status, "ready");
    assert.deepEqual(previewed.structuredContent.nextAction.onApproval, {
      tool: "commit_purchase_evidence_job", arguments: { purchase_evidence_job_id: jobId },
    });
    assert.match(previewed.structuredContent.nextAction.instruction, /1 matched receipt charge.*1 tax-inclusive item split/);

    const committed = await client.callTool({ name: "commit_purchase_evidence_job",
      arguments: { purchase_evidence_job_id: jobId } });
    assert.equal(committed.structuredContent.job.status, "committed");
    assert.match(committed.structuredContent.completionNote, /appear in the suspense register/);

    const restarted = await client.callTool({ name: "restart_purchase_evidence_job",
      arguments: { purchase_evidence_job_id: jobId } });
    assert.equal(restarted.structuredContent.job.status, "ready");
    assert.equal(removedArtifact.artifactId, artifactId);
  } finally {
    await client.close();
    await server.close();
  }
});
