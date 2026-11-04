import { useEffect, useMemo, useState } from "react";
import { api, downloadEvidenceFile, uploadStatementPdf } from "./api";
import { unitsToDecimal } from "./money";
import type { Account, BalanceAssertion, StatementImportJob } from "./types";

type AccountingQuestion = {
  lineItemId: number;
  transactionDate: string;
  transactionDescription: string | null;
  accountFullName: string;
  accountId: number;
  currencyId: number;
  currencyCode: string;
  scale: number;
  amountUnits: string;
  audience: string;
  prompt: string;
};

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

export default function StatementWorkspace({ accounts, assertions, token, initialAccountId, onChanged }: {
  accounts: Account[];
  assertions: BalanceAssertion[];
  token: string;
  initialAccountId: number | null;
  onChanged: () => Promise<void>;
}) {
  const paths = useMemo(() => fullPaths(accounts), [accounts]);
  const postable = accounts.filter((account) => !account.placeholder && !account.archivedAt);
  const [accountId, setAccountId] = useState(initialAccountId == null ? "" : String(initialAccountId));
  const [designationId, setDesignationId] = useState("");
  const [statementFile, setStatementFile] = useState<File | null>(null);
  const [statementJobs, setStatementJobs] = useState<StatementImportJob[]>([]);
  const [questions, setQuestions] = useState<AccountingQuestion[]>([]);
  const [questionCursor, setQuestionCursor] = useState<string | null>(null);
  const [questionTargets, setQuestionTargets] = useState<Record<number, string>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const account = postable.find((candidate) => candidate.id === Number(accountId));
  const suspense = postable.find((candidate) => candidate.suspense
    && candidate.currencyId === account?.currencyId && candidate.id !== account?.id);
  const sameCurrencyBuckets = postable.filter((candidate) => candidate.currencyId === account?.currencyId
    && candidate.id !== account?.id);
  const latestAssertion = assertions.filter((assertion) => assertion.accountId === account?.id)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const activeStatementJob = statementJobs.find((job) => job.status !== "committed") ?? null;

  useEffect(() => {
    if (initialAccountId != null) setAccountId(String(initialAccountId));
  }, [initialAccountId]);

  useEffect(() => {
    setDesignationId("");
  }, [accountId]);

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

  async function loadQuestions(cursor: string | null = null) {
    const result = await api<{ questions: AccountingQuestion[]; nextCursor: string | null }>(
      `/accounting-questions?status=open&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, token,
    );
    setQuestions((current) => cursor ? [...current, ...result.questions] : result.questions);
    setQuestionCursor(result.nextCursor);
  }

  useEffect(() => {
    void loadQuestions().catch((nextError) => setError(message(nextError)));
  }, [token]);

  async function uploadStatement() {
    if (!account || !statementFile) return;
    setBusy("upload"); setError(""); setNotice("");
    try {
      const result = await uploadStatementPdf<{ job: StatementImportJob }>(account.id, statementFile, token);
      setStatementJobs((current) => [result.job, ...current]);
      setStatementFile(null);
      setNotice("The original PDF is saved in Accounting. Nothing has been posted.");
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function copyAgentHandoff() {
    if (!activeStatementJob || !suspense) return;
    try {
      await navigator.clipboard.writeText(activeStatementJob.copiedPrompt);
      setNotice("Agent handoff copied. Paste it into your agent; the agent will retrieve the complete PDF from Accounting.");
    } catch {
      setError("Clipboard access was blocked. Copy the statement job reference manually.");
    }
  }

  async function restartStatementJob() {
    if (!activeStatementJob || !window.confirm(
      "Restart this uncommitted statement import? Accounting will keep the original PDF but permanently remove the current job, derived artifact, and pending preview.",
    )) return;
    setBusy("restart"); setError(""); setNotice("");
    try {
      const result = await api<{ job: StatementImportJob }>(
        `/statement-import-jobs/${activeStatementJob.id}/restart`, { method: "POST", body: "{}" }, token,
      );
      setStatementJobs((current) => [result.job,
        ...current.filter((job) => job.id !== activeStatementJob.id)]);
      setNotice("The processing state was removed and a fresh job was created from the unchanged original PDF.");
    } catch (nextError) { setError(message(nextError)); }
    finally { setBusy(""); }
  }

  async function assign(question: AccountingQuestion) {
    const targetAccountId = Number(questionTargets[question.lineItemId]);
    if (!targetAccountId) return;
    setBusy(`question-${question.lineItemId}`);
    setError("");
    try {
      await api(`/accounting-questions/${question.lineItemId}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          targetAccountId,
          resolution: questionNotes[question.lineItemId] || null,
        }),
      }, token);
      await loadQuestions();
      await onChanged();
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setBusy("");
    }
  }

  return <section className="statement-workspace card">
    <div className="section-heading"><div><p className="eyebrow">Agent statement workflow</p>
      <h2>One statement, one account</h2></div></div>
    <p className="muted">Upload the original PDF directly to Accounting. Your agent retrieves that exact document, creates a pending review, and leaves posting for your explicit approval.</p>
    <div className="statement-layout">
      <section className="statement-import-panel">
        <h3>Statement account</h3>
        <label>Statement account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">Choose account</option>
          {postable.map((candidate) => <option key={candidate.id} value={candidate.id}>
            {paths.get(candidate.id)} · {candidate.currencyCode}
          </option>)}
        </select></label>
        {latestAssertion && <p className="statement-file">Latest known balance: {latestAssertion.date} · {unitsToDecimal(latestAssertion.knownBalanceUnits, latestAssertion.scale)} {latestAssertion.currencyCode}</p>}

        <h3>1. Upload the original PDF</h3>
        {!activeStatementJob && <>
          <label>Statement PDF<input type="file" accept="application/pdf,.pdf"
            onChange={(event) => setStatementFile(event.target.files?.[0] ?? null)} /></label>
          <button type="button" className="primary" disabled={!account || !statementFile || Boolean(busy)}
            onClick={() => void uploadStatement()}>{busy === "upload" ? "Uploading…" : "Save PDF in Accounting"}</button>
        </>}
        {activeStatementJob && <div className="statement-file"><strong>{activeStatementJob.evidenceFile.fileName}</strong>
          <span>{activeStatementJob.status.replaceAll("_", " ")} · {activeStatementJob.evidenceFile.sha256}</span>
          <button type="button" className="link-button" onClick={() => void downloadEvidenceFile(
            activeStatementJob.evidenceFile.downloadPath
              ?? `/api/evidence-files/${activeStatementJob.evidenceFile.id}/content`,
            activeStatementJob.evidenceFile.fileName, token,
          ).catch((nextError) => setError(message(nextError)))}>Download original PDF</button></div>}

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

        <h3>3. Continue in your agent</h3>
        <ol className="statement-agent-questions">
          <li>Beginning balance and date, distinguishing period start from an explicit end-of-day balance date.</li>
          <li>Ending balance and its date.</li>
          <li>Every dated line item, signed by its effect on the displayed balance.</li>
          <li>All available text for every line item.</li>
        </ol>
        <p className="muted">No category guessing happens during intake. Each unknown counterline remains an open question in the suspense account for later matching or classification.</p>
        <button type="button" className="primary" disabled={!activeStatementJob || !suspense || Boolean(busy)}
          onClick={() => void copyAgentHandoff()}>Copy agent handoff</button>
        {activeStatementJob && activeStatementJob.status !== "committed" && <button type="button" className="secondary"
          disabled={Boolean(busy)} onClick={() => void restartStatementJob()}>
          {busy === "restart" ? "Restarting…" : "Restart from original PDF"}</button>}
        {activeStatementJob && <button type="button" className="link-button" disabled={Boolean(busy)}
          onClick={() => void loadStatementJobs().catch((nextError) => setError(message(nextError)))}>
          Refresh statement status</button>}
      </section>

      <section className="statement-questions-panel">
        <h3>Open suspense questions <span>{questions.length}{questionCursor ? "+" : ""}</span></h3>
        <p className="muted">Review these after other accounts or evidence are imported. Matching entries with fees or different quantities is a later step; use final account assignment only when the evidence supports it.</p>
        {questions.map((question) => <article className="statement-question" key={question.lineItemId}>
          <div><strong>{question.transactionDescription || question.prompt}</strong>
            <small>{question.transactionDate} · {question.accountFullName} · {question.audience}</small></div>
          <b>{unitsToDecimal(question.amountUnits, question.scale)} {question.currencyCode}</b>
          <p>{question.prompt}</p>
          <div className="statement-question-fields">
            <label>Final account<select value={questionTargets[question.lineItemId] ?? ""}
              onChange={(event) => setQuestionTargets((current) => ({ ...current, [question.lineItemId]: event.target.value }))}>
              <option value="">Choose account</option>
              {postable.filter((candidate) => candidate.currencyId === question.currencyId
                && candidate.id !== question.accountId).map((candidate) => <option key={candidate.id} value={candidate.id}>
                  {paths.get(candidate.id)}
                </option>)}
            </select></label>
            <label>Evidence / reason<input value={questionNotes[question.lineItemId] ?? ""}
              placeholder="Receipt, merchant, or decision"
              onChange={(event) => setQuestionNotes((current) => ({ ...current, [question.lineItemId]: event.target.value }))} /></label>
          </div>
          <button type="button" className="secondary" disabled={!questionTargets[question.lineItemId] || Boolean(busy)}
            onClick={() => void assign(question)}>{busy === `question-${question.lineItemId}` ? "Assigning…" : "Assign suspense line"}</button>
        </article>)}
        {questionCursor && <button type="button" className="secondary" disabled={Boolean(busy)}
          onClick={() => void loadQuestions(questionCursor).catch((nextError) => setError(message(nextError)))}>
          Load more questions</button>}
        {!questions.length && <p className="statement-empty">No open accounting questions.</p>}
      </section>
    </div>
    {notice && <p className="statement-success" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
