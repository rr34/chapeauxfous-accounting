import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { decimalToUnits, unitsToDecimal } from "./money";
import { normalizedStatementAmount, normalizedStatementDate, parseStatementCsv, suggestedColumn } from "./statement-csv";
import type { Account, BalanceAssertion } from "./types";

type StatementRow = { externalId: string; transactionDate: string; description: string | null;
  amountDecimal: string; valueDecimal?: string | null; questionPrompt?: string; reference?: string | null };
type Observation = { id: string; sourceRecordId: string; amountUnits: string };
type StatementAnalysis = {
  observations: Observation[];
  proposedNewObservationIds: string[];
  duplicateAnalysis: { unresolvedCandidateCount: number; exactLedgerDuplicateObservationIds: string[];
    ledgerCandidates: Array<{ observationId: string; candidates: Array<{ classification: string;
      existing: { description: string | null; transactionDate: string; amountUnits: string } }> }> };
  coverage: Array<{ residualAfterProposedUnits: string | null; balanced: boolean }>;
};
type StatementPreview = { readyToCommit: boolean; importPlanId: string | null; wouldCreateTransactionCount: number;
  wouldReuseTransactionCount: number; questionSummary: { openQuestionCount: number };
  reconciliationValidation?: { passed: boolean; issues: Array<{ message: string }> };
  transactions: Array<{ externalId: string; status: string; errors: Array<{ message: string }> }> };
type AccountingQuestion = { lineItemId: number; transactionDate: string; transactionDescription: string | null;
  accountFullName: string; accountId: number; currencyId: number; currencyCode: string; scale: number;
  amountUnits: string; reconciliationState: "unreconciled" | "cleared" | "reconciled";
  audience: string; prompt: string; status: "open" | "resolved" };

function fullPaths(accounts: Account[]) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const resolve = (account: Account): string => {
    const parent = account.parentAccountId == null ? null : byId.get(account.parentAccountId);
    return parent ? `${resolve(parent)}:${account.name}` : account.name;
  };
  return new Map(accounts.map((account) => [account.id, resolve(account)]));
}

function message(error: unknown) { return error instanceof Error ? error.message : "The operation failed."; }

export default function StatementWorkspace({ accounts, assertions, token, initialAccountId, onChanged }: {
  accounts: Account[]; assertions: BalanceAssertion[]; token: string; initialAccountId: number | null;
  onChanged: () => Promise<void>;
}) {
  const paths = useMemo(() => fullPaths(accounts), [accounts]);
  const postable = accounts.filter((account) => !account.placeholder && !account.archivedAt);
  const [accountId, setAccountId] = useState(initialAccountId == null ? "" : String(initialAccountId));
  const [suspenseId, setSuspenseId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState("");
  const [table, setTable] = useState<ReturnType<typeof parseStatementCsv> | null>(null);
  const [columns, setColumns] = useState({ date: -1, amount: -1, description: -1, reference: -1 });
  const [openingDate, setOpeningDate] = useState("");
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingDate, setClosingDate] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [analysis, setAnalysis] = useState<StatementAnalysis | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [includeResidual, setIncludeResidual] = useState(false);
  const [questions, setQuestions] = useState<AccountingQuestion[]>([]);
  const [questionTargets, setQuestionTargets] = useState<Record<number, string>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const account = postable.find((candidate) => candidate.id === Number(accountId));
  const sameCurrencyBuckets = postable.filter((candidate) => candidate.currencyId === account?.currencyId
    && candidate.id !== account?.id);
  const latestAssertions = assertions.filter((assertion) => assertion.accountId === account?.id)
    .sort((left, right) => right.date.localeCompare(left.date));

  useEffect(() => { if (initialAccountId != null) setAccountId(String(initialAccountId)); }, [initialAccountId]);
  useEffect(() => {
    setAnalysis(null); setPreview(null); setSuspenseId(""); setIncludeResidual(false);
    const latest = assertions.filter((assertion) => assertion.accountId === Number(accountId))
      .sort((left, right) => right.date.localeCompare(left.date))[0];
    setOpeningDate(latest?.date ?? "");
    setOpeningBalance(latest ? unitsToDecimal(latest.knownBalanceUnits, latest.scale) : "");
    setClosingDate(""); setClosingBalance("");
  }, [accountId]);

  async function loadQuestions() {
    const result = await api<{ questions: AccountingQuestion[] }>("/accounting-questions?status=open&limit=500", {}, token);
    setQuestions(result.questions);
  }
  useEffect(() => { void loadQuestions().catch((nextError) => setError(message(nextError))); }, [token]);

  async function chooseFile(next: File | null) {
    setFile(next); setTable(null); setFileHash(""); setAnalysis(null); setPreview(null); setError(""); setNotice("");
    if (!next) return;
    if (!/\.(csv|tsv)$/i.test(next.name)) return;
    try {
      const bytes = await next.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const parsed = parseStatementCsv(new TextDecoder().decode(bytes));
      setFileHash(hash); setTable(parsed);
      setColumns({
        date: suggestedColumn(parsed.headers, [/date/i, /posted/i]),
        amount: suggestedColumn(parsed.headers, [/^amount$/i, /transaction amount/i, /net amount/i]),
        description: suggestedColumn(parsed.headers, [/description/i, /merchant/i, /details/i]),
        reference: suggestedColumn(parsed.headers, [/reference/i, /transaction id/i, /hash/i]),
      });
    } catch (nextError) { setError(message(nextError)); }
  }

  function mappedRows(): Array<StatementRow & { sourceRecordId: string }> {
    if (!table || !fileHash || !account) throw new Error("Choose a CSV or TSV statement and its account first.");
    if (columns.date < 0 || columns.amount < 0) throw new Error("Map the date and signed amount columns.");
    const references = table.rows.map((cells) => columns.reference < 0 ? "" : cells[columns.reference]?.trim() ?? "");
    const referenceCounts = new Map<string, number>();
    for (const reference of references.filter(Boolean)) referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
    return table.rows.map((cells, index) => {
      const sourceRecordId = `row-${index + 2}`;
      const reference = references[index];
      const providerIdentity = reference && referenceCounts.get(reference) === 1
        && [...`${account.id}:ref:${reference}`].length <= 128;
      return {
        sourceRecordId,
        externalId: providerIdentity ? `${account.id}:ref:${reference}`
          : `${account.id}:file:${fileHash.slice(0, 24)}:${index + 2}`,
        transactionDate: normalizedStatementDate(cells[columns.date] ?? ""),
        amountDecimal: normalizedStatementAmount(cells[columns.amount] ?? ""),
        description: columns.description < 0 ? null : cells[columns.description]?.trim() || null,
        reference: reference || null,
        questionPrompt: reference ? `What is the final account for statement reference ${reference}?` : undefined,
      };
    }).filter((row) => decimalToUnits(row.amountDecimal, account.scale) !== "0");
  }

  async function review() {
    setBusy("review"); setError(""); setNotice(""); setPreview(null); setAnalysis(null);
    try {
      if (!account || !suspenseId) throw new Error("Choose the statement account and a same-currency suspense bucket.");
      if (!openingDate || !closingDate || !openingBalance || !closingBalance) {
        throw new Error("Enter the opening and closing dates and exact known balances before review.");
      }
      if (closingDate <= openingDate) throw new Error("The closing date must be after the opening date.");
      const rows = mappedRows();
      if (!rows.length || rows.length > 500) throw new Error("Direct CSV review supports 1–500 lines. Use the agent for a larger statement.");
      await api("/balance-assertions", { method: "POST", body: JSON.stringify({
        accountId: account.id, balanceDate: openingDate,
        knownBalanceUnits: decimalToUnits(openingBalance, account.scale),
      }) }, token);
      await api("/balance-assertions", { method: "POST", body: JSON.stringify({
        accountId: account.id, balanceDate: closingDate,
        knownBalanceUnits: decimalToUnits(closingBalance, account.scale),
      }) }, token);
      await onChanged();
      const result = await api<StatementAnalysis>("/statements/analyze", { method: "POST", body: JSON.stringify({
        openingBalanceDate: openingDate, closingBalanceDate: closingDate,
        observations: rows.map((row) => ({ sourceDocumentId: `sha256:${fileHash}`,
          sourceRecordId: row.sourceRecordId, accountId: account.id,
          transactionDate: row.transactionDate, amountDecimal: row.amountDecimal,
          description: row.description, reference: row.externalId })),
      }) }, token);
      setAnalysis(result); setIncludeResidual(false);
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function makePreview() {
    setBusy("preview"); setError(""); setPreview(null);
    try {
      if (!analysis || !account || !fileHash) throw new Error("Review the statement first.");
      if (analysis.duplicateAnalysis.unresolvedCandidateCount) {
        throw new Error("Duplicate candidates need review in the agent before this statement can be added.");
      }
      const sourceRows = mappedRows();
      const proposed = new Set(analysis.proposedNewObservationIds);
      const observationsByRecord = new Map(analysis.observations.map((item) => [item.sourceRecordId, item]));
      const lines: StatementRow[] = sourceRows.filter((row) => proposed.has(observationsByRecord.get(row.sourceRecordId)?.id ?? ""))
        .map(({ sourceRecordId: _sourceRecordId, reference: _reference, ...row }) => row);
      const residual = analysis.coverage[0]?.residualAfterProposedUnits;
      if (residual && residual !== "0" && includeResidual) lines.push({
        externalId: `${account.id}:balance:${fileHash.slice(0, 24)}:${closingDate}`,
        transactionDate: closingDate, description: "Balance-derived unexplained movement",
        amountDecimal: unitsToDecimal(residual, account.scale),
        questionPrompt: `What explains the ${unitsToDecimal(residual, account.scale)} ${account.currencyCode} balance-derived difference?`,
      });
      if (!lines.length) throw new Error("No new statement lines remain after duplicate exclusion.");
      setPreview(await api<StatementPreview>("/statements/preview", { method: "POST", body: JSON.stringify({
        sourceSystem: "statement_csv_ui", accountId: account.id, suspenseAccountId: Number(suspenseId),
        valuationCurrencyCode: account.currencyCode, questionAudience: "human", lines,
        reconciliation: { openingBalanceDate: openingDate, closingBalanceDate: closingDate },
      }) }, token));
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function commit() {
    if (!preview?.readyToCommit || !preview.importPlanId) return;
    setBusy("commit"); setError("");
    try {
      await api(`/statements/plans/${preview.importPlanId}/commit`, { method: "POST", body: "{}" }, token);
      setNotice(`Added ${preview.wouldCreateTransactionCount} statement lines. Their unknown sides are in the suspense bucket.`);
      setPreview(null); setAnalysis(null); await onChanged(); await loadQuestions();
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function reconcile() {
    if (!account || !closingDate) return;
    setBusy("reconcile"); setError("");
    try {
      const result = await api<{ newlyReconciledLineCount: number }>(`/accounts/${account.id}/reconcile`, {
        method: "POST", body: JSON.stringify({ balanceDate: closingDate }),
      }, token);
      setNotice(`${result.newlyReconciledLineCount} account lines marked reconciled through ${closingDate}. Suspense questions remain open.`);
      await onChanged();
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function assign(question: AccountingQuestion) {
    const targetAccountId = Number(questionTargets[question.lineItemId]);
    if (!targetAccountId) return;
    setBusy(`question-${question.lineItemId}`); setError("");
    try {
      await api(`/accounting-questions/${question.lineItemId}/resolve`, { method: "POST", body: JSON.stringify({
        targetAccountId, resolution: questionNotes[question.lineItemId] || null,
      }) }, token);
      await loadQuestions(); await onChanged();
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function copyAgentHandoff() {
    if (!account) { setError("Choose the account the statement belongs to first."); return; }
    const object = { objectType: "accounting.account", id: account.id,
      sourceRef: `accounting://accounts/${account.id}`, displayName: paths.get(account.id),
      currencyCode: account.currencyCode, scale: account.scale };
    const instructions = `I am attaching a statement for this Accounting account object: ${JSON.stringify(object)}.\n`
      + `File: ${file?.name ?? "(attach statement file)"}. Check this account against list_account_objects and confirm the match with me before committing. `
      + `Extract rows and the opening/closing dates and balances from the file; ask me about anything missing. Save the two known balances with save_balance_assertion, `
      + `then analyze duplicates with analyze_statement_observations and check get_statement_reconciliation_context. `
      + `For another account's matching statement, compare transfer candidates and explicit fee evidence; use reference-rate evidence for BTC/USD value and do not invent fees. `
      + `Use import_single_account_statement `
      + `with a same-currency suspense account I select. Show the preview and ask me to approve commit_transaction_import. `
      + `After the known closing balance matches, use reconcile_account_through_date. Leave open suspense questions for later receipts.`;
    try { await navigator.clipboard.writeText(instructions); setNotice("Account-bound agent instructions copied. Attach the same file in your agent."); }
    catch { setError("Clipboard access was blocked. Select and copy the account details manually."); }
  }

  const residual = analysis?.coverage[0]?.residualAfterProposedUnits;
  return <section className="statement-workspace card">
    <div className="section-heading"><div><p className="eyebrow">Statement workflow</p><h2>Import &amp; reconcile</h2></div></div>
    <p className="muted">Ground one account from its statement, collect unknown counterlines in a suspense bucket, then assign them as evidence arrives.</p>
    <div className="statement-layout"><section className="statement-import-panel">
      <h3>1. Link the statement to an account</h3>
      <div className="statement-fields"><label>Statement account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        <option value="">Choose account</option>{postable.map((candidate) => <option key={candidate.id} value={candidate.id}>
          {paths.get(candidate.id)} · {candidate.currencyCode}</option>)}</select></label>
        <label>Unknown side bucket<select value={suspenseId} onChange={(event) => { setSuspenseId(event.target.value); setPreview(null); }}>
          <option value="">Choose same-currency account</option>{sameCurrencyBuckets.map((candidate) =>
            <option key={candidate.id} value={candidate.id}>{paths.get(candidate.id)}</option>)}</select></label></div>
      {account && !sameCurrencyBuckets.length && <p className="statement-warning">Create a postable “Ask Human” or “Ask Accountant” account in {account.currencyCode} before importing.</p>}
      <label>Statement file<input type="file" accept=".csv,.tsv,.pdf,image/*" onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} /></label>
      {file && <p className="statement-file">{file.name} · {file.size.toLocaleString()} bytes {table && `· ${table.rows.length} rows`}</p>}
      {file && !table && <p className="statement-warning">PDFs and screenshots need the agent to extract rows. This UI does not OCR them yet.</p>}
      <button type="button" className="secondary" disabled={!account} onClick={() => void copyAgentHandoff()}>Copy account-bound agent handoff</button>
      {table && <><h3>2. Check columns and balances</h3><div className="statement-fields">
        {(["date", "amount", "description", "reference"] as const).map((key) => <label key={key}>
          {key === "amount" ? "Signed amount" : key[0].toUpperCase() + key.slice(1)} column<select value={columns[key]}
            onChange={(event) => { setColumns((current) => ({ ...current, [key]: Number(event.target.value) })); setAnalysis(null); setPreview(null); }}>
            <option value={-1}>{key === "date" || key === "amount" ? "Choose column" : "Not present"}</option>
            {table.headers.map((header, index) => <option key={index} value={index}>{header || `Column ${index + 1}`}</option>)}</select></label>)}</div>
        <div className="statement-sample"><strong>First rows</strong>{table.rows.slice(0, 3).map((row, index) =>
          <div key={index}>{row.map((value, column) => <span key={column}>{table.headers[column]}: {value}</span>)}</div>)}</div>
        <div className="statement-fields"><label>Opening date<input type="date" value={openingDate} onChange={(event) => { setOpeningDate(event.target.value); setAnalysis(null); setPreview(null); }} /></label>
          <label>Opening known balance ({account?.currencyCode})<input value={openingBalance} onChange={(event) => { setOpeningBalance(event.target.value); setAnalysis(null); setPreview(null); }} /></label>
          <label>Closing date<input type="date" value={closingDate} onChange={(event) => { setClosingDate(event.target.value); setAnalysis(null); setPreview(null); }} /></label>
          <label>Closing known balance ({account?.currencyCode})<input value={closingBalance} onChange={(event) => { setClosingBalance(event.target.value); setAnalysis(null); setPreview(null); }} /></label></div>
        {latestAssertions.length > 0 && <small>Latest saved balance: {latestAssertions[0].date} · {unitsToDecimal(latestAssertions[0].knownBalanceUnits, latestAssertions[0].scale)} {latestAssertions[0].currencyCode}</small>}
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void review()}>
          {busy === "review" ? "Checking…" : "Save known balances & analyze rows"}</button></>}
      {analysis && <section className="statement-review"><h3>3. Review evidence</h3>
        <p>{analysis.observations.length} extracted rows · {analysis.duplicateAnalysis.exactLedgerDuplicateObservationIds.length} exact ledger duplicates excluded · {analysis.duplicateAnalysis.unresolvedCandidateCount} candidates need review.</p>
        {analysis.duplicateAnalysis.unresolvedCandidateCount > 0 && <p className="statement-warning">Possible duplicates are not silently imported. Review them with the agent and reprocess the statement after a decision.</p>}
        {residual != null && <p className={residual === "0" ? "statement-success" : "statement-warning"}>Balance residual after new rows: {account ? unitsToDecimal(residual, account.scale) : residual} {account?.currencyCode}</p>}
        {residual && residual !== "0" && <label className="statement-residual-choice"><input type="checkbox" checked={includeResidual}
          onChange={(event) => setIncludeResidual(event.target.checked)} />Add an explicitly labeled balance-derived adjustment to the suspense bucket. Its cause remains an open question.</label>}
        <button type="button" className="secondary" disabled={Boolean(busy) || analysis.duplicateAnalysis.unresolvedCandidateCount > 0}
          onClick={() => void makePreview()}>{busy === "preview" ? "Preparing…" : "Preview balanced import"}</button></section>}
      {preview && <section className="statement-review"><h3>4. Confirm ledger addition</h3>
        <p>{preview.wouldCreateTransactionCount} new statement transactions · {preview.wouldReuseTransactionCount} existing · {preview.questionSummary.openQuestionCount} open questions.</p>
        {!preview.readyToCommit && <p className="statement-warning">The balance gate did not pass. {preview.reconciliationValidation?.issues.map((issue) => issue.message).join(" ") || preview.transactions.flatMap((entry) => entry.errors.map((issue) => issue.message)).join(" ")}</p>}
        <button type="button" className="primary" disabled={!preview.readyToCommit || Boolean(busy)} onClick={() => void commit()}>
          {busy === "commit" ? "Adding…" : "Confirm and add statement lines"}</button></section>}
      {account && closingDate && <section className="statement-review"><h3>5. Reconcile the known side</h3>
        <p>Only {paths.get(account.id)} is marked reconciled. Unknown counterlines remain assignable.</p>
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void reconcile()}>
          {busy === "reconcile" ? "Checking balance…" : `Reconcile through ${closingDate}`}</button></section>}
    </section><section className="statement-questions-panel"><h3>Open suspense questions <span>{questions.length}</span></h3>
      <p className="muted">When a receipt arrives, find its question here and assign only the suspense line. A reconciled statement line is never changed.</p>
      {questions.map((question) => <article className="statement-question" key={question.lineItemId}>
        <div><strong>{question.transactionDescription || question.prompt}</strong><small>{question.transactionDate} · {question.accountFullName} · {question.audience}</small></div>
        <b>{unitsToDecimal(question.amountUnits, question.scale)} {question.currencyCode}</b>
        <p>{question.prompt}</p><div className="statement-question-fields"><label>Final account<select value={questionTargets[question.lineItemId] ?? ""}
          onChange={(event) => setQuestionTargets((current) => ({ ...current, [question.lineItemId]: event.target.value }))}>
          <option value="">Choose account</option>{postable.filter((candidate) => candidate.currencyId === question.currencyId
            && candidate.id !== question.accountId).map((candidate) => <option key={candidate.id} value={candidate.id}>
              {paths.get(candidate.id)}</option>)}</select></label>
          <label>Evidence / reason<input value={questionNotes[question.lineItemId] ?? ""} placeholder="Receipt, merchant, or decision"
            onChange={(event) => setQuestionNotes((current) => ({ ...current, [question.lineItemId]: event.target.value }))} /></label></div>
        <button type="button" className="secondary" disabled={!questionTargets[question.lineItemId] || Boolean(busy)}
          onClick={() => void assign(question)}>{busy === `question-${question.lineItemId}` ? "Assigning…" : "Assign suspense line"}</button>
      </article>)}
      {!questions.length && <p className="statement-empty">No open accounting questions.</p>}
    </section></div>
    {notice && <p className="statement-success" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
