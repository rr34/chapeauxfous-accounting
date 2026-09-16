import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { unitsToDecimal } from "./money";
import type { Account, BalanceAssertion } from "./types";

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
  const [suspenseId, setSuspenseId] = useState("");
  const [questions, setQuestions] = useState<AccountingQuestion[]>([]);
  const [questionTargets, setQuestionTargets] = useState<Record<number, string>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const account = postable.find((candidate) => candidate.id === Number(accountId));
  const suspense = postable.find((candidate) => candidate.id === Number(suspenseId));
  const sameCurrencyBuckets = postable.filter((candidate) => candidate.currencyId === account?.currencyId
    && candidate.id !== account?.id);
  const latestAssertion = assertions.filter((assertion) => assertion.accountId === account?.id)
    .sort((left, right) => right.date.localeCompare(left.date))[0];

  useEffect(() => {
    if (initialAccountId != null) setAccountId(String(initialAccountId));
  }, [initialAccountId]);

  useEffect(() => {
    setSuspenseId("");
  }, [accountId]);

  async function loadQuestions() {
    const result = await api<{ questions: AccountingQuestion[] }>(
      "/accounting-questions?status=open&limit=500", {}, token,
    );
    setQuestions(result.questions);
  }

  useEffect(() => {
    void loadQuestions().catch((nextError) => setError(message(nextError)));
  }, [token]);

  async function copyAgentHandoff() {
    if (!account || !suspense) return;
    const accountObject = {
      objectType: "accounting.account",
      id: account.id,
      sourceRef: `accounting://accounts/${account.id}`,
      displayName: paths.get(account.id),
      currencyCode: account.currencyCode,
      scale: account.scale,
    };
    const suspenseObject = {
      objectType: "accounting.account",
      id: suspense.id,
      sourceRef: `accounting://accounts/${suspense.id}`,
      displayName: paths.get(suspense.id),
      currencyCode: suspense.currencyCode,
      scale: suspense.scale,
    };
    const instructions = [
      "I am attaching one account statement.",
      `Statement account object: ${JSON.stringify(accountObject)}`,
      `Unknown-side suspense account object: ${JSON.stringify(suspenseObject)}`,
      "Use the Accounting MCP single-account statement workflow. First call start_single_account_statement_import for the statement account.",
      "Answer its four questions from the attached document, in this order:",
      "1. Does it contain a beginning balance and date? Extract both, and say whether that date is the first included statement date or an explicit end-of-day balance date. If it is the first included date, the balance belongs to the previous calendar day.",
      "2. Does it contain an ending balance with a date? Extract both exactly.",
      "3. What are every line item's date and signed change to the displayed statement balance (positive increases it; negative decreases it)?",
      "4. What payee, description, memo, reference, or other text is available for each line?",
      "Ask me only if the statement does not answer one of those questions. Do not guess any counteraccount, category, transfer, fee, or price.",
      "Submit the complete answers to import_single_account_statement using the selected suspense account. Show me its preview and ask once before commit_transaction_import. Reconcile only the statement account after the closing balance matches.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(instructions);
      setNotice("Agent handoff copied. Attach the statement in your agent and paste the instructions.");
    } catch {
      setError("Clipboard access was blocked. Select the account objects and copy them manually.");
    }
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
    <p className="muted">Choose the two accounting objects here, then attach the CSV, PDF, or screenshot in your agent. The agent extracts four facts; Accounting validates and balances the result.</p>
    <div className="statement-layout">
      <section className="statement-import-panel">
        <h3>1. Select the statement account</h3>
        <label>Statement account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">Choose account</option>
          {postable.map((candidate) => <option key={candidate.id} value={candidate.id}>
            {paths.get(candidate.id)} · {candidate.currencyCode}
          </option>)}
        </select></label>
        {latestAssertion && <p className="statement-file">Latest known balance: {latestAssertion.date} · {unitsToDecimal(latestAssertion.knownBalanceUnits, latestAssertion.scale)} {latestAssertion.currencyCode}</p>}

        <h3>2. Select where unknown sides wait</h3>
        <label>Suspense account<select value={suspenseId} onChange={(event) => setSuspenseId(event.target.value)} disabled={!account}>
          <option value="">Choose same-currency account</option>
          {sameCurrencyBuckets.map((candidate) => <option key={candidate.id} value={candidate.id}>
            {paths.get(candidate.id)}
          </option>)}
        </select></label>
        {account && !sameCurrencyBuckets.length && <p className="statement-warning">Create a postable “Ask Human” or “Ask Accountant” account in {account.currencyCode}. Accounting will not create or choose one silently.</p>}

        <h3>3. Continue in your agent</h3>
        <ol className="statement-agent-questions">
          <li>Beginning balance and date, distinguishing period start from an explicit end-of-day balance date.</li>
          <li>Ending balance and its date.</li>
          <li>Every dated line item, signed by its effect on the displayed balance.</li>
          <li>All available text for every line item.</li>
        </ol>
        <p className="muted">No category guessing happens during intake. Each unknown counterline remains an open question in the suspense account.</p>
        <button type="button" className="primary" disabled={!account || !suspense}
          onClick={() => void copyAgentHandoff()}>Copy agent handoff</button>
      </section>

      <section className="statement-questions-panel">
        <h3>Open suspense questions <span>{questions.length}</span></h3>
        <p className="muted">Classify these later when a receipt or other evidence arrives. The reconciled statement side is not changed.</p>
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
        {!questions.length && <p className="statement-empty">No open accounting questions.</p>}
      </section>
    </div>
    {notice && <p className="statement-success" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
