import { createHash } from "node:crypto";
import { decimalToUnits } from "./money.js";
import { normalBalanceSign } from "./account-balances.js";
import { listMatchingBalanceCheckpoints } from "./balance-assertions.js";
import { getStatementReconciliationContext } from "./statement-reconciliation.js";

const maximumObservations = 500;

function applicationError(message, status = 400, code = "INVALID_STATEMENT_OBSERVATIONS", details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

function text(value, field, maximum, required = false) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (required && !normalized) throw applicationError(`${field} is required.`, 400,
    "STATEMENT_OBSERVATION_FIELD_REQUIRED", { field });
  if ([...normalized].length > maximum) throw applicationError(`${field} cannot exceed ${maximum} characters.`, 400,
    "STATEMENT_OBSERVATION_FIELD_TOO_LONG", { field });
  return normalized || null;
}

function calendarDate(value) {
  const normalized = text(value, "transaction_date", 10, true);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== normalized) {
    throw applicationError("transaction_date must be a valid YYYY-MM-DD date.", 400,
      "INVALID_STATEMENT_OBSERVATION_DATE");
  }
  return normalized;
}

function optionalTimestamp(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  const parsed = new Date(normalized);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)
      || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== normalized.slice(0, 19)) {
    throw applicationError("occurred_at must be a UTC ISO-8601 timestamp ending in Z.", 400,
      "INVALID_STATEMENT_OBSERVATION_TIMESTAMP");
  }
  return parsed.toISOString();
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokens(value) {
  return new Set(normalize(value).split(" ").filter((item) => item.length > 1));
}

function similarity(left, right) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function daysApart(left, right) {
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
}

function observationId(sourceDocumentId, sourceRecordId) {
  return `sha256:${createHash("sha256").update(`${sourceDocumentId}\u0000${sourceRecordId}`, "utf8").digest("hex")}`;
}

function matchingReference(observation, candidate) {
  const wanted = [observation.reference].map(normalize).filter(Boolean);
  const available = [candidate.line_source_id, candidate.transaction_source_id].map(normalize).filter(Boolean);
  return wanted.some((value) => available.includes(value));
}

function candidateFor(observation, row) {
  const amountMatches = BigInt(observation.amountUnits) === BigInt(row.amount_units);
  const referenceMatches = matchingReference(observation, row);
  const dateDistanceDays = daysApart(observation.transactionDate, row.TransactionDate);
  const descriptionSimilarity = similarity(`${observation.description ?? ""} ${observation.reference ?? ""}`,
    `${row.transaction_description ?? ""} ${row.line_memo ?? ""}`);
  if (!referenceMatches && (!amountMatches || dateDistanceDays > 3)) return null;
  const reasons = ["same_account"];
  let score = 10;
  if (referenceMatches) { score += 60; reasons.push("matching_source_reference"); }
  if (amountMatches) { score += 35; reasons.push("exact_native_amount"); }
  if (dateDistanceDays === 0) { score += 20; reasons.push("same_transaction_date"); }
  else if (dateDistanceDays <= 1) { score += 10; reasons.push("date_within_one_day"); }
  else if (dateDistanceDays <= 3) { score += 4; reasons.push("date_within_three_days"); }
  if (descriptionSimilarity >= 0.75) { score += 15; reasons.push("strong_description_match"); }
  else if (descriptionSimilarity >= 0.35) { score += 7; reasons.push("partial_description_match"); }
  let classification = "possible_duplicate";
  let recommendation = "review_candidate";
  if (referenceMatches && amountMatches && dateDistanceDays <= 1) {
    classification = "exact_source_duplicate";
    recommendation = "exclude_from_new_import";
  } else if (referenceMatches && (!amountMatches || dateDistanceDays > 3)) {
    classification = "source_reference_conflict";
    recommendation = "do_not_import_until_resolved";
  } else if (amountMatches && dateDistanceDays === 0 && descriptionSimilarity >= 0.35) {
    classification = "strong_duplicate_candidate";
    recommendation = "review_candidate";
  } else if (amountMatches && dateDistanceDays <= 2) {
    classification = "probable_duplicate";
    recommendation = "exclude_when_balance_or_text_corroborates";
    reasons.push("exact_amount_within_two_days");
  }
  return {
    transactionId: Number(row.transaction_id),
    lineItemId: Number(row.line_item_id),
    classification,
    recommendation,
    score,
    reasons,
    existing: {
      transactionDate: String(row.TransactionDate),
      amountUnits: String(row.amount_units),
      description: row.transaction_description ?? null,
      lineMemo: row.line_memo ?? null,
      transactionSourceId: row.transaction_source_id ?? null,
      transactionSourceSystem: row.transaction_source_system ?? null,
      transactionState: String(row.TransactionState),
      lineSourceId: row.line_source_id ?? null,
    },
  };
}

function combinationsThatSum(items, target, maximumSize = 3, maximumResults = 200) {
  const amounts = items.map((item) => BigInt(item.amountUnits));
  const singles = items.flatMap((item, index) => amounts[index] === target ? [[item]] : []);
  if (singles.length || maximumSize === 1) return singles.slice(0, maximumResults);

  const pairs = [];
  for (let left = 0; left < items.length - 1 && pairs.length < maximumResults; left += 1) {
    for (let right = left + 1; right < items.length && pairs.length < maximumResults; right += 1) {
      if (amounts[left] + amounts[right] === target) pairs.push([items[left], items[right]]);
    }
  }
  if (pairs.length || maximumSize === 2) return pairs;

  const indicesByAmount = new Map();
  for (let index = 0; index < amounts.length; index += 1) {
    const key = amounts[index].toString();
    if (!indicesByAmount.has(key)) indicesByAmount.set(key, []);
    indicesByAmount.get(key).push(index);
  }
  const triples = [];
  const firstIndexAfter = (indices, minimum) => {
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (indices[middle] <= minimum) low = middle + 1;
      else high = middle;
    }
    return indices[low];
  };
  for (let first = 0; first < items.length - 2 && triples.length < maximumResults; first += 1) {
    for (let second = first + 1; second < items.length - 1 && triples.length < maximumResults; second += 1) {
      const candidates = indicesByAmount.get((target - amounts[first] - amounts[second]).toString()) ?? [];
      const third = firstIndexAfter(candidates, second);
      if (third != null) triples.push([items[first], items[second], items[third]]);
    }
  }
  return triples;
}

function decideStatementRows(observations, ledgerCandidates, exactExcludedIds, reconciliation, balanceCheckpoints) {
  const candidatesByObservation = new Map(ledgerCandidates.map((item) => [item.observationId, item.candidates]));
  const checkpointByAccount = new Map(balanceCheckpoints.map((checkpoint) => [checkpoint.accountId, checkpoint]));
  const decisions = new Map(observations.map((observation) => {
    const checkpoint = checkpointByAccount.get(observation.accountId);
    const coveredByCheckpoint = checkpoint != null && observation.transactionDate <= checkpoint.date;
    const exactDuplicate = exactExcludedIds.has(observation.id);
    return [observation.id, {
      observationId: observation.id,
      decision: coveredByCheckpoint || exactDuplicate ? "exclude" : "include",
      confidence: coveredByCheckpoint ? "verified_checkpoint" : exactDuplicate ? "certain" : "tentative",
      reason: coveredByCheckpoint
        ? `The recorded balance already matches the known balance through ${checkpoint.date}; rows on or before that date are presumed already recorded.`
        : exactDuplicate
          ? "A stable source identity already exists in the ledger or elsewhere in this statement batch."
          : "No conclusive duplicate evidence was found.",
      matchedTransactionIds: [...new Set((candidatesByObservation.get(observation.id) ?? [])
        .map((candidate) => candidate.transactionId))],
      balanceCheckpointDate: coveredByCheckpoint ? checkpoint.date : null,
    }];
  }));

  for (const account of reconciliation.accounts) {
    if (account.remainingLineItemMovementUnits == null) continue;
    const included = observations.filter((item) => item.accountId === account.accountId
      && decisions.get(item.id).decision === "include");
    const proposed = included.reduce((sum, item) => sum + BigInt(item.amountUnits), 0n);
    const targetExclusion = proposed - BigInt(account.remainingLineItemMovementUnits);
    if (targetExclusion === 0n) continue;
    const solutions = combinationsThatSum(included, targetExclusion).map((rows) => {
      const evidenceScore = rows.reduce((sum, row) => {
        const best = (candidatesByObservation.get(row.id) ?? [])[0];
        return sum + (best?.score ?? 0);
      }, 0);
      const matchedCount = rows.filter((row) => (candidatesByObservation.get(row.id) ?? []).length > 0).length;
      return { rows, evidenceScore, matchedCount };
    }).sort((left, right) => left.rows.length - right.rows.length
      || right.matchedCount - left.matchedCount || right.evidenceScore - left.evidenceScore
      || left.rows.map((row) => row.id).join("\u0000").localeCompare(right.rows.map((row) => row.id).join("\u0000")));
    if (!solutions.length) continue;
    const best = solutions[0];
    const next = solutions[1];
    const uniquelySupported = next == null || best.rows.length < next.rows.length
      || best.matchedCount > next.matchedCount || best.evidenceScore > next.evidenceScore;
    if (!uniquelySupported) {
      const implicated = new Set(solutions.filter((solution) => solution.rows.length === best.rows.length
        && solution.matchedCount === best.matchedCount && solution.evidenceScore === best.evidenceScore)
        .flatMap((solution) => solution.rows.map((row) => row.id)));
      for (const id of implicated) {
        const decision = decisions.get(id);
        decision.reason = "This row is one of several equally plausible exclusions that would reach the known balance.";
        decision.confidence = "ambiguous";
      }
      continue;
    }
    for (const row of best.rows) {
      const decision = decisions.get(row.id);
      decision.decision = "exclude";
      decision.confidence = best.matchedCount > 0 ? "probable" : "balance_supported";
      decision.reason = best.matchedCount > 0
        ? "An existing same-account amount near this date and the known balance both support treating this row as already recorded."
        : "Excluding this row is the unique smallest combination that reaches the known balance.";
    }
  }
  return [...decisions.values()];
}

function inputDuplicateCandidates(observations) {
  const candidates = [];
  for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
      const left = observations[leftIndex];
      const right = observations[rightIndex];
      if (left.sourceDocumentId === right.sourceDocumentId || left.accountId !== right.accountId
          || left.amountUnits !== right.amountUnits || daysApart(left.transactionDate, right.transactionDate) > 1) continue;
      const sameReference = normalize(left.reference) && normalize(left.reference) === normalize(right.reference);
      const descriptionSimilarity = similarity(left.description, right.description);
      const exact = Boolean(sameReference);
      candidates.push({
        observationIds: [left.id, right.id],
        classification: exact ? "exact_cross_document_duplicate" : "overlapping_source_candidate",
        recommendation: exact ? "keep_one_observation" : "review_candidate",
        reasons: ["same_account", "exact_native_amount",
          daysApart(left.transactionDate, right.transactionDate) === 0 ? "same_transaction_date" : "date_within_one_day",
          ...(sameReference ? ["matching_source_reference"] : []),
          ...(descriptionSimilarity >= 0.5 ? ["similar_description"] : [])],
      });
    }
  }
  return candidates;
}

function transferCandidates(observations) {
  const candidates = [];
  for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
      const left = observations[leftIndex];
      const right = observations[rightIndex];
      if (left.sourceDocumentId === right.sourceDocumentId || left.accountId === right.accountId
          || left.currencyId !== right.currencyId || (BigInt(left.amountUnits) < 0n) === (BigInt(right.amountUnits) < 0n)) continue;
      const dateDistanceDays = daysApart(left.transactionDate, right.transactionDate);
      const sameReference = normalize(left.reference) && normalize(left.reference) === normalize(right.reference);
      const timestampDistanceSeconds = left.occurredAt && right.occurredAt
        ? Math.abs(Date.parse(left.occurredAt) - Date.parse(right.occurredAt)) / 1000 : null;
      if (dateDistanceDays > 3 && !sameReference) continue;
      const outgoing = BigInt(left.amountUnits) < 0n ? left : right;
      const incoming = outgoing === left ? right : left;
      const outgoingMagnitude = -BigInt(outgoing.amountUnits);
      const incomingMagnitude = BigInt(incoming.amountUnits);
      const difference = outgoingMagnitude - incomingMagnitude;
      const exactAmount = difference === 0n;
      const feeRatio = outgoingMagnitude === 0n ? 1 : Number(difference < 0n ? -difference : difference)
        / Number(outgoingMagnitude);
      if (!sameReference && !exactAmount && feeRatio > 0.1) continue;
      let score = 15;
      const reasons = ["different_accounts", "same_native_currency", "opposite_directions"];
      if (sameReference) { score += 60; reasons.push("matching_transfer_reference"); }
      if (exactAmount) { score += 30; reasons.push("equal_native_amounts"); }
      else if (difference > 0n) { score += 20; reasons.push("outgoing_exceeds_incoming_by_possible_fee"); }
      if (dateDistanceDays === 0) { score += 20; reasons.push("same_transaction_date"); }
      else if (dateDistanceDays <= 1) { score += 10; reasons.push("date_within_one_day"); }
      else { score += 4; reasons.push("date_within_three_days"); }
      if (timestampDistanceSeconds != null && timestampDistanceSeconds <= 3600) {
        score += 20;
        reasons.push("timestamps_within_one_hour");
      } else if (timestampDistanceSeconds != null && timestampDistanceSeconds <= 86400) {
        score += 8;
        reasons.push("timestamps_within_one_day");
      }
      candidates.push({
        outgoingObservationId: outgoing.id,
        incomingObservationId: incoming.id,
        classification: sameReference || score >= 65 ? "strong_transfer_candidate" : "possible_transfer_candidate",
        score,
        reasons,
        nativeCurrencyCode: outgoing.currencyCode,
        outgoingUnits: outgoingMagnitude.toString(),
        incomingUnits: incomingMagnitude.toString(),
        possibleFeeUnits: difference >= 0n ? difference.toString() : null,
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 1000);
}

export async function analyzeStatementObservations({ pool, personId, observations: inputObservations,
  openingBalanceDate, closingBalanceDate, knownBalanceAssertions = [] }) {
  if (!Array.isArray(inputObservations) || inputObservations.length === 0
      || inputObservations.length > maximumObservations) {
    throw applicationError(`Supply between 1 and ${maximumObservations} extracted statement observations.`);
  }
  const accountIds = [...new Set(inputObservations.map((item) => Number(item?.accountId)))];
  const storedReconciliation = await getStatementReconciliationContext({
    pool, personId, accountIds, openingBalanceDate, closingBalanceDate,
  });
  const prospectiveBalances = new Map(knownBalanceAssertions.map((assertion) => [
    `${Number(assertion.accountId)}:${String(assertion.balanceDate)}`, String(assertion.knownBalanceUnits),
  ]));
  const reconciliationAccounts = storedReconciliation.accounts.map((account) => {
    const openingKnown = account.opening.knownBalanceUnits
      ?? prospectiveBalances.get(`${account.accountId}:${storedReconciliation.interval.openingBalanceDate}`) ?? null;
    const closingKnown = account.closing.knownBalanceUnits
      ?? prospectiveBalances.get(`${account.accountId}:${storedReconciliation.interval.closingBalanceDate}`) ?? null;
    if (openingKnown == null || closingKnown == null) return account;
    const targetLineItemMovement = (BigInt(closingKnown) - BigInt(openingKnown))
      * normalBalanceSign(account.accountType);
    return {
      ...account,
      opening: { ...account.opening, knownBalanceUnits: openingKnown },
      closing: { ...account.closing, knownBalanceUnits: closingKnown },
      requiredNormalMovementUnits: (BigInt(closingKnown) - BigInt(openingKnown)).toString(),
      remainingLineItemMovementUnits:
        (targetLineItemMovement - BigInt(account.postedLineItemMovementUnits)).toString(),
      grounded: true,
    };
  });
  const missingAssertions = reconciliationAccounts.flatMap((account) => [account.opening, account.closing]
    .filter((anchor) => anchor.knownBalanceUnits == null)
    .map((anchor) => ({ accountId: account.accountId, balanceDate: anchor.date })));
  const reconciliation = { ...storedReconciliation, accounts: reconciliationAccounts,
    grounded: missingAssertions.length === 0, missingAssertions };
  const accountById = new Map(reconciliation.accounts.map((account) => [account.accountId, account]));
  const seenKeys = new Set();
  const observations = inputObservations.map((item, index) => {
    const accountId = Number(item?.accountId);
    const account = accountById.get(accountId);
    if (!account) throw applicationError(`Observation ${index + 1} references an unavailable account.`, 404,
      "STATEMENT_OBSERVATION_ACCOUNT_NOT_FOUND", { accountId });
    const sourceDocumentId = text(item?.sourceDocumentId, "source_document_id", 128, true);
    const sourceRecordId = text(item?.sourceRecordId, "source_record_id", 128, true);
    const key = `${sourceDocumentId}\u0000${sourceRecordId}`;
    if (seenKeys.has(key)) throw applicationError("A source document record appears more than once in the observation set.",
      400, "DUPLICATE_STATEMENT_OBSERVATION_ID", { sourceDocumentId, sourceRecordId });
    seenKeys.add(key);
    let amountUnits;
    try {
      amountUnits = decimalToUnits(String(item?.amountDecimal ?? "").trim(), account.scale);
    } catch (error) {
      throw applicationError(`Observation ${index + 1} has an invalid amount: ${error.message}.`, 400,
        "INVALID_STATEMENT_OBSERVATION_AMOUNT", { sourceDocumentId, sourceRecordId });
    }
    if (amountUnits === "0") throw applicationError(`Observation ${index + 1} has no account movement.`, 400,
      "ZERO_STATEMENT_OBSERVATION_AMOUNT", { sourceDocumentId, sourceRecordId });
    const transactionDate = calendarDate(item?.transactionDate);
    if (transactionDate <= reconciliation.interval.openingBalanceDate
        || transactionDate > reconciliation.interval.closingBalanceDate) {
      throw applicationError(`Observation ${index + 1} is outside the balance-assertion interval.`, 400,
        "STATEMENT_OBSERVATION_OUTSIDE_INTERVAL", { sourceDocumentId, sourceRecordId, transactionDate });
    }
    return {
      id: observationId(sourceDocumentId, sourceRecordId),
      sourceDocumentId,
      sourceRecordId,
      accountId,
      accountFullName: account.accountFullName,
      currencyId: account.currencyId,
      currencyCode: account.currencyCode,
      scale: account.scale,
      transactionDate,
      occurredAt: optionalTimestamp(item?.occurredAt),
      amountDecimal: String(item?.amountDecimal).trim(),
      amountUnits,
      description: text(item?.description, "description", 16000),
      reference: text(item?.reference, "reference", 128),
    };
  });
  const minimumDate = observations.map((item) => item.transactionDate).sort()[0];
  const maximumDate = observations.map((item) => item.transactionDate).sort().at(-1);
  const balanceCheckpoints = await listMatchingBalanceCheckpoints(pool, personId, accountIds, maximumDate);
  const placeholders = accountIds.map(() => "?").join(", ");
  const [existingRows] = await pool.query(
    `SELECT t.transaction_id, t.TransactionDate, t.TransactionState,
            t.description AS transaction_description, t.source_system AS transaction_source_system,
            t.source_id AS transaction_source_id, li.line_item_id, li.amount_units,
            li.memo AS line_memo, li.source_id AS line_source_id, li.account_id
       FROM line_items li
       JOIN transactions t ON t.transaction_id = li.transaction_id
      WHERE t.owner_person_id = ? AND t.TransactionState <> 'voided'
        AND li.account_id IN (${placeholders})
        AND t.TransactionDate BETWEEN DATE_SUB(?, INTERVAL 3 DAY) AND DATE_ADD(?, INTERVAL 3 DAY)
      ORDER BY t.TransactionDate, t.transaction_id, li.line_item_id`,
    [personId, ...accountIds, minimumDate, maximumDate],
  );
  const ledgerCandidates = observations.map((observation) => ({
    observationId: observation.id,
    candidates: existingRows.filter((row) => Number(row.account_id) === observation.accountId)
      .map((row) => candidateFor(observation, row)).filter(Boolean)
      .sort((left, right) => right.score - left.score).slice(0, 10),
  })).filter((item) => item.candidates.length);
  const ambiguousExactLedgerObservationIds = ledgerCandidates.filter((item) =>
    item.candidates.filter((candidate) => candidate.classification === "exact_source_duplicate").length > 1)
    .map((item) => item.observationId);
  const ambiguousExactLedgerIdSet = new Set(ambiguousExactLedgerObservationIds);
  const exactLedgerDuplicateIds = new Set(ledgerCandidates.filter((item) =>
    !ambiguousExactLedgerIdSet.has(item.observationId)
      && item.candidates.some((candidate) => candidate.classification === "exact_source_duplicate"))
    .map((item) => item.observationId));
  const inputCandidates = inputDuplicateCandidates(observations);
  const exactInputDuplicateIds = new Set();
  for (const candidate of inputCandidates.filter((item) => item.classification === "exact_cross_document_duplicate")) {
    const sorted = [...candidate.observationIds].sort();
    exactInputDuplicateIds.add(sorted[1]);
  }
  const exactExcludedIds = new Set([...exactLedgerDuplicateIds, ...exactInputDuplicateIds]);
  const importDecisions = decideStatementRows(observations, ledgerCandidates, exactExcludedIds,
    reconciliation, balanceCheckpoints);
  const proposedIds = importDecisions.filter((item) => item.decision === "include").map((item) => item.observationId);
  const proposedIdSet = new Set(proposedIds);
  const coverage = reconciliation.accounts.map((account) => {
    const accountObservations = observations.filter((item) => item.accountId === account.accountId);
    const allUnits = accountObservations.reduce((sum, item) => sum + BigInt(item.amountUnits), 0n);
    const proposedUnits = accountObservations.filter((item) => proposedIdSet.has(item.id))
      .reduce((sum, item) => sum + BigInt(item.amountUnits), 0n);
    const remaining = account.remainingLineItemMovementUnits == null
      ? null : BigInt(account.remainingLineItemMovementUnits);
    return {
      accountId: account.accountId,
      accountFullName: account.accountFullName,
      currencyCode: account.currencyCode,
      scale: account.scale,
      requiredRemainingUnits: remaining?.toString() ?? null,
      allExtractedObservationUnits: allUnits.toString(),
      proposedNewObservationUnits: proposedUnits.toString(),
      residualAfterProposedUnits: remaining == null ? null : (remaining - proposedUnits).toString(),
      balanced: remaining != null && remaining === proposedUnits,
    };
  });
  const unresolvedDuplicateCandidates = ledgerCandidates.reduce((sum, item) => sum
    + item.candidates.filter((candidate) => candidate.classification !== "exact_source_duplicate").length, 0)
    + inputCandidates.filter((item) => item.classification === "overlapping_source_candidate").length
    + ambiguousExactLedgerObservationIds.length;
  const compiledTransferCandidates = transferCandidates(observations);
  const strongTransferCounts = new Map();
  for (const candidate of compiledTransferCandidates.filter((item) => item.classification === "strong_transfer_candidate")) {
    for (const id of [candidate.outgoingObservationId, candidate.incomingObservationId]) {
      strongTransferCounts.set(id, (strongTransferCounts.get(id) ?? 0) + 1);
    }
  }
  const ambiguousTransferObservationIds = [...strongTransferCounts]
    .filter(([, count]) => count > 1).map(([id]) => id);
  return {
    reconciliation,
    observations,
    duplicateAnalysis: {
      ledgerCandidates,
      inputCandidates,
      exactLedgerDuplicateObservationIds: [...exactLedgerDuplicateIds],
      ambiguousExactLedgerObservationIds,
      exactInputDuplicateObservationIds: [...exactInputDuplicateIds],
      unresolvedCandidateCount: unresolvedDuplicateCandidates,
    },
    transferCandidates: compiledTransferCandidates,
    ambiguousTransferObservationIds,
    balanceCheckpoints,
    importDecisions,
    proposedNewObservationIds: proposedIds,
    coverage,
    readyForTransactionAssembly: observations.length > 0,
    rules: [
      "Stable source-reference matches are excluded as ledger duplicates.",
      "A matching recorded and known balance is a verified checkpoint; statement rows on or before its date default to excluded before duplicate matching and balance solving.",
      "An exact same-account amount within two days is ranked as a probable duplicate; known-balance subset solving can select the uniquely supported exclusion.",
      "Known-balance solving tests the smallest combinations of up to three rows and leaves equally supported solutions for user review.",
      "Multiple existing exact-source matches are a ledger ambiguity and are never automatically excluded.",
      "Same date and amount without stable source identity is a candidate for review, not proof of duplication.",
      "When importing one-sided rows, retain non-exact same-account ledger candidates as review questions on suspense lines.",
      "Preserve source-reference conflicts and transfer ambiguity for later matching; do not guess a final counteraccount during intake.",
      "Report known-balance coverage when available, but missing or mismatched balances do not block transaction assembly.",
    ],
  };
}
