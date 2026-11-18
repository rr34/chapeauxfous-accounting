import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadEvidenceFile, uploadStatementPdf } from "./api";
import { unitsToDecimal } from "./money";
import type { Account, BalanceAssertion, StatementImportJob } from "./types";

function fullPaths(accounts: Account[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const resolve = (account: Account): string => {
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    return parent ? `${resolve(parent)}:${account.name}` : account.name;
  };
  return new Map(accounts.map((account) => [account.id, resolve(account)]));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "The operation failed.";
}

export default function StatementWorkspace({ accounts, assertions, token, initialAccountId, onAccountSelected, onChanged }: {
  accounts: Account[];
  assertions: BalanceAssertion[];
  token: string;
  initialAccountId: number | null;
  onAccountSelected: (accountId: number) => void;
  onChanged: () => Promise<void>;
}) {
  const paths = useMemo(() => fullPaths(accounts), [accounts]);
  const postable = accounts.filter((account) => !account.placeholder && !account.archivedAt);
  const [accountId, setAccountId] = useState(initialAccountId == null ? "" : String(initialAccountId));
  const [designationId, setDesignationId] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [transactionText, setTransactionText] = useState("");
  const [statementJobs, setStatementJobs] = useState<StatementImportJob[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [handoffCopied, setHandoffCopied] = useState<"statement" | "transactions" | "">("");
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceFileInput = useRef<HTMLInputElement | null>(null);
  const account = postable.find((candidate) => candidate.id === Number(accountId));
  const suspense = postable.find((candidate) => candidate.suspense
    && candidate.currencyId === account?.currencyId && candidate.id !== account?.id);
  const sameCurrencyBuckets = postable.filter((candidate) => candidate.currencyId === account?.currencyId
    && candidate.id !== account?.id);
  const latestAssertion = assertions.filter((assertion) => assertion.accountId === account?.id)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const activeStatementJob = statementJobs.find((job) => job.status !== "committed") ?? null;
  const evidenceSignificance = activeStatementJob == null ? [] : [
    activeStatementJob.evidenceFile.startDate == null && activeStatementJob.evidenceFile.startAmountUnits == null
      ? null : `Start ${activeStatementJob.evidenceFile.startDate ?? "date not found"}${
        activeStatementJob.evidenceFile.startAmountUnits == null || activeStatementJob.evidenceFile.scale == null
          ? "" : ` · ${unitsToDecimal(activeStatementJob.evidenceFile.startAmountUnits,
            activeStatementJob.evidenceFile.scale)} ${activeStatementJob.evidenceFile.currencyCode ?? ""}`}`,
    activeStatementJob.evidenceFile.endDate == null && activeStatementJob.evidenceFile.endAmountUnits == null
      ? null : `End ${activeStatementJob.evidenceFile.endDate ?? "date not found"}${
        activeStatementJob.evidenceFile.endAmountUnits == null || activeStatementJob.evidenceFile.scale == null
          ? "" : ` · ${unitsToDecimal(activeStatementJob.evidenceFile.endAmountUnits,
            activeStatementJob.evidenceFile.scale)} ${activeStatementJob.evidenceFile.currencyCode ?? ""}`}`,
  ].filter((value): value is string => value != null);

  useEffect(() => {
    if (initialAccountId != null) setAccountId(String(initialAccountId));
  }, [initialAccountId]);

  useEffect(() => {
    setDesignationId("");
  }, [accountId]);

  useEffect(() => () => {
    if (copiedResetTimer.current != null) clearTimeout(copiedResetTimer.current);
  }, []);

  useEffect(() => {
    setHandoffCopied("");
  }, [activeStatementJob?.id]);

  async function loadStatementJobs() {
    if (!account) { setStatementJobs([]); return; }
    const result = await api<{ jobs: StatementImportJob[] }>(
      `/accounts/${account.id}/statement-import-jobs?limit=25`, {}, token,
    );
    setStatementJobs(result.jobs);
  }

  useEffect(() => {
    void loadStatementJobs().catch((nextError) => setError(message(nextError)));
  }, [account?.id, token]);

  async function designateSuspense() {
    const candidate = sameCurrencyBuckets.find((item) => item.id === Number(designationId));
    if (!candidate) return;
    setBusy("designation"); setError("");
    try {
      await api(`/accounts/${candidate.id}`, { method: "PATCH", body: JSON.stringify({
        name: candidate.name, description: candidate.description, placeholder: false,
        suspense: true, parentAccountId: candidate.parentAccountId,
        type: candidate.type, currencyId: candidate.currencyId,
      }) }, token);
      await onChanged();
      setNotice(`${paths.get(candidate.id)} is now the suspense account for ${candidate.currencyCode}.`);
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function uploadSourceEvidence() {
    if (!account || !sourceFile) return;
    setBusy("upload"); setError(""); setNotice("");
    try {
      const lowerName = sourceFile.name.toLowerCase();
      const isPdf = sourceFile.type === "application/pdf" || lowerName.endsWith(".pdf");
      const isText = ["text/plain", "text/csv", "application/csv"].includes(sourceFile.type)
        || lowerName.endsWith(".txt") || lowerName.endsWith(".csv");
      if (!isPdf && !isText) throw new Error("Choose a PDF, TXT, or CSV file.");
      const result = isPdf
        ? await uploadStatementPdf<{ job: StatementImportJob }>(account.id, sourceFile, token)
        : await api<{ job: StatementImportJob }>(
          `/accounts/${account.id}/transaction-list-import-jobs`, {
            method: "POST", body: JSON.stringify({ fileName: sourceFile.name, text: await sourceFile.text() }),
          }, token,
        );
      setStatementJobs((current) => [result.job, ...current]);
      setSourceFile(null);
      if (sourceFileInput.current) sourceFileInput.current.value = "";
      setNotice(`${isPdf ? "The original PDF" : "The uploaded text"} evidence is saved in Accounting. Nothing has been posted.`);
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function saveTransactionText() {
    if (!account || !transactionText.trim()) return;
    setBusy("text-upload"); setError(""); setNotice("");
    try {
      const result = await api<{ job: StatementImportJob }>(
        `/accounts/${account.id}/transaction-list-import-jobs`, {
          method: "POST", body: JSON.stringify({ fileName: "pasted-transactions.txt", text: transactionText }),
        }, token,
      );
      setStatementJobs((current) => [result.job, ...current]);
      setTransactionText("");
      setNotice("The text evidence is saved in Accounting. Nothing has been posted.");
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function copyAgentHandoff(kind: "statement" | "transactions") {
    if (!activeStatementJob || !suspense) return;
    try {
      await navigator.clipboard.writeText(kind === "statement"
        ? activeStatementJob.copiedPrompt : activeStatementJob.transactionListCopiedPrompt);
      setHandoffCopied(kind);
      if (copiedResetTimer.current != null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(() => {
        setHandoffCopied("");
        copiedResetTimer.current = null;
      }, 3000);
      setNotice(kind === "statement"
        ? "Statement handoff copied. The agent will retrieve the complete PDF from Accounting."
        : "Transaction-list handoff copied. The agent may discard irrelevant copied text and will prepare only the dated movements it can support.");
    } catch {
      setHandoffCopied("");
      setError("Clipboard access was blocked. Copy the import job reference manually.");
    }
  }

  async function restartStatementJob() {
    if (!activeStatementJob || !window.confirm(
      "Restart this uncommitted import? Accounting will keep the original source evidence but permanently remove the current job, derived artifact, and pending preview.",
    )) return;
    setBusy("restart"); setError(""); setNotice("");
    try {
      const result = await api<{ job: StatementImportJob }>(
        `/statement-import-jobs/${activeStatementJob.id}/restart`, { method: "POST", body: "{}" }, token,
      );
      setStatementJobs((current) => [result.job,
        ...current.filter((job) => job.id !== activeStatementJob.id)]);
      setNotice("The processing state was removed and a fresh job was created from the unchanged source evidence.");
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function clearSourceEvidence() {
    if (!activeStatementJob || !window.confirm(
      "Clear this saved source evidence? This permanently removes the uncommitted import job, its pending preview, and its derived artifact. The source file is also deleted unless another import or posted ledger record still references the same evidence.",
    )) return;
    setBusy("delete-evidence"); setError(""); setNotice("");
    try {
      const result = await api<{ evidenceDeleted: boolean }>(
        `/statement-import-jobs/${activeStatementJob.id}`, { method: "DELETE" }, token,
      );
      setStatementJobs((current) => current.filter((job) => job.id !== activeStatementJob.id));
      setNotice(result.evidenceDeleted
        ? "The uncommitted import and its saved source evidence were permanently removed."
        : "The uncommitted import was removed. The source evidence remains because another import or posted ledger record references it.");
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  return <section className="statement-workspace card">
    <div className="section-heading"><div><p className="eyebrow">Agent import workflow</p>
      <h2>Import transactions for one account</h2></div></div>
    <p className="muted">Save a statement PDF or noisy copied transaction text in Accounting. Your agent retrieves that exact evidence, creates a pending review in the selected account, and leaves posting for your explicit approval.</p>
    <div className="statement-layout">
      <section className="statement-import-panel">
        <h3>Destination account</h3>
        <label>Account receiving these movements<select value={accountId} onChange={(event) => {
          const value = event.target.value;
          setAccountId(value);
          if (value) onAccountSelected(Number(value));
        }}>
          <option value="">Choose account</option>
          {postable.map((candidate) => <option key={candidate.id} value={candidate.id}>
            {paths.get(candidate.id)} · {candidate.currencyCode}
          </option>)}
        </select></label>
        {latestAssertion && <p className="statement-file">Latest known balance: {latestAssertion.date} · {unitsToDecimal(latestAssertion.knownBalanceUnits, latestAssertion.scale)} {latestAssertion.currencyCode}</p>}

        <h3>1. Save source evidence</h3>
        {!activeStatementJob && <>
          <label>Evidence file (PDF, TXT, or CSV)<input ref={sourceFileInput} type="file"
            accept="application/pdf,text/plain,text/csv,.pdf,.txt,.csv"
            onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)} /></label>
          <button type="button" className="primary" disabled={!account || !sourceFile || Boolean(busy)}
            onClick={() => void uploadSourceEvidence()}>{busy === "upload" ? "Uploading…" : "Save uploaded file"}</button>
          <p className="muted">Or paste text directly below. Uploaded files and pasted text can each be interpreted as a statement or as a transaction list.</p>
          <label>Copied evidence text<textarea rows={10} value={transactionText}
            placeholder="Paste statement details or a transaction list here. Extra headings, categories, formatting, and unrelated text are okay."
            onChange={(event) => setTransactionText(event.target.value)} /></label>
          <button type="button" className="secondary" disabled={!account || !transactionText.trim() || Boolean(busy)}
            onClick={() => void saveTransactionText()}>{busy === "text-upload" ? "Saving…" : "Save pasted text"}</button>
        </>}
        {activeStatementJob && <div className="statement-file"><strong>{activeStatementJob.evidenceFile.fileName}</strong>
          <span>{activeStatementJob.status.replaceAll("_", " ")} · {activeStatementJob.evidenceFile.sha256}</span>
          {evidenceSignificance.map((value) => <span key={value}>{value}</span>)}
          <div className="statement-evidence-actions"><button type="button" className="link-button"
            disabled={Boolean(busy)} onClick={() => void downloadEvidenceFile(
              activeStatementJob.evidenceFile.downloadPath
                ?? `/api/evidence-files/${activeStatementJob.evidenceFile.id}/content`,
              activeStatementJob.evidenceFile.fileName, token,
            ).catch((nextError) => setError(message(nextError)))}>Download source evidence</button>
          <button type="button" className="danger-link" disabled={Boolean(busy)}
            onClick={() => void clearSourceEvidence()}>
            {busy === "delete-evidence" ? "Clearing…" : "Clear saved source evidence"}</button></div></div>}

        <h3>2. Designate where unknown sides wait</h3>
        {suspense && <p className="statement-file">Suspense account: {paths.get(suspense.id)} · {suspense.currencyCode}</p>}
        {account?.suspense && !suspense && <p className="statement-warning">This statement account is designated as the suspense account. Clear that designation in the chart of accounts before importing its own statement.</p>}
        {account && !account.suspense && !suspense && <>
          <label>Use an existing account<select value={designationId}
            onChange={(event) => setDesignationId(event.target.value)}>
            <option value="">Choose same-currency account</option>
            {sameCurrencyBuckets.map((candidate) => <option key={candidate.id} value={candidate.id}>
              {paths.get(candidate.id)}
            </option>)}
          </select></label>
          <button type="button" className="secondary" disabled={!designationId || Boolean(busy)}
            onClick={() => void designateSuspense()}>Designate suspense account</button>
        </>}
        {account && !account.suspense && !suspense && !sameCurrencyBuckets.length && <p className="statement-warning">Create a postable “Ask Accountant” account in {account.currencyCode}, then designate it here.</p>}

        <h3>3. Choose the agent handoff</h3>
        <p className="muted">The evidence format does not choose the workflow. Use statement import when the source has statement-period or balance meaning; use transaction-list import when it is simply a list of movements.</p>
        {activeStatementJob && <ol className="statement-agent-questions">
          <li>Statement start date, determined independently.</li>
          <li>Opening balance, determined independently.</li>
          <li>Statement end date, determined independently.</li>
          <li>Closing balance, determined independently.</li>
          <li>Every dated line item, signed by its effect on the displayed balance.</li>
          <li>All available text for every line item.</li>
        </ol>}
        <p className="muted">Transaction-list intake needs only each movement’s date, signed amount, and useful identifying text. The agent may discard headings, incidental categories, formatting, navigation, and other copied noise. No category guessing happens during intake; unknown counterlines wait in the designated suspense account.</p>
        {activeStatementJob && <button type="button" className={`primary handoff-copy${handoffCopied === "statement" ? " copied" : ""}`}
          disabled={!activeStatementJob || !suspense || Boolean(busy)}
          onClick={() => void copyAgentHandoff("statement")} aria-live="polite">
          {handoffCopied === "statement" ? "✓ Copied to clipboard" : "Copy statement-import handoff"}</button>}
        {activeStatementJob && <button type="button"
          className={`primary handoff-copy${handoffCopied === "transactions" ? " copied" : ""}`}
          disabled={!suspense || Boolean(busy)} onClick={() => void copyAgentHandoff("transactions")} aria-live="polite">
          {handoffCopied === "transactions" ? "✓ Copied to clipboard" : "Copy transaction-list handoff"}</button>}
        {activeStatementJob && activeStatementJob.status !== "committed" && <button type="button" className="secondary"
          disabled={Boolean(busy)} onClick={() => void restartStatementJob()}>
          {busy === "restart" ? "Restarting…" : "Restart from source evidence"}</button>}
        {activeStatementJob && <button type="button" className="link-button" disabled={Boolean(busy)}
          onClick={() => void loadStatementJobs().catch((nextError) => setError(message(nextError)))}>
          Refresh import status</button>}
      </section>
    </div>
    {notice && <p className="statement-success" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
