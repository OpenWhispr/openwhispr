const crypto = require("crypto");
const { describeError } = require("./errorSummary");
const { policyRefusal } = require("./connectorPolicy");
const { normalizeQueryResult, queryFailed } = require("./queryResult");

const CANCEL_REASONS = new Set(["cancelled_by_user", "conversation_ended", "expired"]);

// A connector is third-party code (or a stub in tests), so none of its result
// fields are trusted: each state keeps only the fields it defines, with their
// types checked. Anything else could leak to the renderer, or make the receipt
// write throw and leave the row stuck at "committing".
function stringFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === "string")
  );
}

function booleanFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === "boolean")
  );
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

const FAILED_MESSAGE = "That action didn't go through.";

function failedResult(result) {
  return {
    state: "failed",
    errorCode: stringOr(result.errorCode, "action_failed"),
    message: stringOr(result.message, FAILED_MESSAGE),
  };
}

// Anything other than a recognized outcome may still have reached the
// provider, so it is "unknown", never "failed".
//
// destinationLabel is optional: only a connector whose commit can change
// who the receipt names (Gmail's edited To/Cc) returns one, for "sent" and
// "unknown" only. When it's absent the receipt keeps the label prepare
// wrote (Slack: the destination is fixed once prepared).
function normalizeCommitResult(result) {
  switch (result?.state) {
    case "sent":
      return {
        state: "sent",
        // resultLabel names what the send created ("ENG-124"), for the card
        // and the model; only a created item has one.
        ...stringFields({
          url: result.url,
          destinationLabel: result.destinationLabel,
          resultLabel: result.resultLabel,
        }),
      };
    case "failed":
      return failedResult(result);
    case "unknown":
      return {
        state: "unknown",
        ...stringFields({
          checkUrl: result.checkUrl,
          errorCode: result.errorCode,
          destinationLabel: result.destinationLabel,
        }),
      };
    default:
      return { state: "unknown" };
  }
}

// A direct action that threw or answered malformed may already have acted
// (a compose window opened before a later step failed); calling it "failed"
// would invite a duplicate retry.
function uncertainDirectResult(errorCode) {
  return {
    state: "unknown",
    errorCode,
    message: "That action may have gone through. Ask the user to check before trying again.",
  };
}

// "not_sent" is the connector saying it stopped before acting (a cancel that
// landed in time).
function normalizeDirectResult(result) {
  const destination = stringFields({ destinationLabel: result?.destinationLabel });
  switch (result?.state) {
    case "sent":
      return {
        state: "sent",
        destinationLabel: "",
        ...destination,
        ...booleanFields({
          bodyCopied: result.bodyCopied,
          subjectCopied: result.subjectCopied,
          copyFailed: result.copyFailed,
        }),
      };
    case "failed":
      return { ...failedResult(result), ...destination };
    case "not_sent":
      return { state: "not_sent", reason: stringOr(result.reason, "cancelled") };
    default:
      return uncertainDirectResult("invalid_result");
  }
}

const INVALID_PREPARE_RESULT = {
  status: "failed",
  errorCode: "invalid_result",
  message: "Couldn't prepare that action.",
};

const RECEIPT_UNAVAILABLE_PREPARE_RESULT = {
  status: "failed",
  errorCode: "receipt_unavailable",
  message: "Couldn't record this action, so nothing was prepared.",
};

// Connecting writes a login for the account, so it needs one.
function actionRefusal(policyState, accountId) {
  return policyRefusal(policyState) ?? (accountId ? null : "signed_out");
}

function isString(value) {
  return typeof value === "string";
}

function normalizePreviewNote(note) {
  if (!note || typeof note.key !== "string") return null;
  return note.values && typeof note.values === "object"
    ? { key: note.key, values: stringFields(note.values) }
    : { key: note.key };
}

// A card layout's fields (an email's to, cc, subject and body). Every field
// the card can edit must be one the action declares editable, holding a value
// of the declared type: an undeclared one (a typo in the declaration, say)
// would let the user change it only for Send to drop it, and a mistyped one
// would fail only at Send. Null when there are none; false when malformed.
function normalizePreviewFields(fields, editable) {
  if (fields === undefined || fields === null) return null;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const entries = Object.entries(fields);
  const valid = entries.every(
    ([name, value]) => Object.hasOwn(editable, name) && EDIT_TYPES[editable[name]](value)
  );
  if (!valid) return false;
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

// The fields an issue or comment card lays out. Fields without them would
// drop the card to its plain layout, whose edits Send never commits.
const LAYOUT_FIELDS = { issue: ["title", "body"], comment: ["body"] };

function hasLayoutFields(verbKey, fields) {
  const required = Object.hasOwn(LAYOUT_FIELDS, verbKey) ? LAYOUT_FIELDS[verbKey] : [];
  return required.every((name) => isString(fields[name]));
}

// The card renders exactly this, so a preview missing a field it needs is
// malformed rather than shown half empty.
function normalizePreview(preview, editable) {
  if (!preview || typeof preview !== "object") return null;
  const { verbKey, destinationLabel, accountLabel, body } = preview;
  if (![verbKey, destinationLabel, accountLabel, body].every(isString)) return null;
  const fields = normalizePreviewFields(preview.fields, editable);
  if (fields === false || (fields && !hasLayoutFields(verbKey, fields))) return null;
  return {
    verbKey,
    destinationLabel,
    accountLabel,
    body,
    ...stringFields({ workspaceLabel: preview.workspaceLabel, title: preview.title }),
    ...(Array.isArray(preview.notes)
      ? { notes: preview.notes.map(normalizePreviewNote).filter(Boolean) }
      : {}),
    ...(fields ? { fields } : {}),
  };
}

// A connector's prepare result decides whether a card appears and what it
// shows, so anything malformed fails closed, with no card and no receipt. The
// payload stays in main; only the fields each status defines reach the
// renderer, so a connector can't leak anything else (such as message text)
// through an odd result.
function normalizePrepareResult(result, editable) {
  switch (result?.status) {
    case "ready": {
      const preview = normalizePreview(result.preview, editable);
      return preview && result.payload !== undefined
        ? { status: "ready", payload: result.payload, preview }
        : INVALID_PREPARE_RESULT;
    }
    case "needs_clarification":
      return isString(result.message)
        ? {
            status: "needs_clarification",
            message: result.message,
            candidates: Array.isArray(result.candidates) ? result.candidates.filter(isString) : [],
          }
        : INVALID_PREPARE_RESULT;
    case "failed":
      return {
        status: "failed",
        errorCode: stringOr(result.errorCode, "prepare_failed"),
        message: stringOr(result.message, INVALID_PREPARE_RESULT.message),
      };
    default:
      return INVALID_PREPARE_RESULT;
  }
}

function normalizeStatus(status) {
  const value = status && typeof status === "object" ? status : {};
  return {
    connected: value.connected === true,
    // Only a connector that says so is unconfigured (Gmail without a Google
    // OAuth client); its Settings row is hidden.
    configured: value.configured !== false,
    accountLabel: isString(value.accountLabel) ? value.accountLabel : null,
    workspaceLabel: isString(value.workspaceLabel) ? value.workspaceLabel : null,
    needsReconnect: value.needsReconnect === true,
  };
}

// A binding that can't be compared counts as no connection.
function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return null;
  if (!isString(binding.accountId) || !Number.isInteger(binding.generation)) return null;
  return binding;
}

// What each declared editable type accepts. A "line" goes into a header
// (an email's subject), so CR or LF would let it add headers such as Bcc.
const EDIT_TYPES = {
  addresses: (value) => Array.isArray(value) && value.every(isString),
  line: (value) => isString(value) && !/[\r\n]/.test(value),
  text: isString,
};

// Every approval action says which of its card's fields the user may edit.
// A missing declaration, or one naming a type that doesn't exist, would drop
// edits; it is a build fault, caught when the manager is created.
function assertEditableTypes(connectors) {
  for (const connector of connectors) {
    for (const [action, spec] of Object.entries(connector.actions ?? {})) {
      if (spec?.kind !== "approval") continue;
      if (!spec.editable || typeof spec.editable !== "object") {
        throw new Error(`${connector.id}.${action}: an approval action must declare editable`);
      }
      for (const [field, type] of Object.entries(spec.editable)) {
        if (!Object.hasOwn(EDIT_TYPES, type)) {
          throw new Error(`${connector.id}.${action}.${field}: unknown editable type "${type}"`);
        }
      }
    }
  }
}

// The card's edits reach the connector only as the action declares them:
// exactly the declared fields. A declared field of the wrong type returns
// null, so Send refuses instead of sending the prepared value in its place.
function sanitizeEdits(edits, editable) {
  const source = edits && typeof edits === "object" ? edits : {};
  const clean = {};
  for (const [field, type] of Object.entries(editable)) {
    if (!Object.hasOwn(source, field) || source[field] === undefined) continue;
    if (!EDIT_TYPES[type](source[field])) return null;
    clean[field] = source[field];
  }
  return clean;
}

const REVOKE_TIMEOUT_MS = 5000;
const CONNECT_ERROR_CODES = new Set([
  "not_configured",
  "oauth_denied",
  "oauth_timeout",
  "oauth_state_mismatch",
  "ports_busy",
  "token_exchange_failed",
  // Gmail: the user unticked "send email" at Google's consent screen, or
  // Google says the account's address isn't verified.
  "permission_not_granted",
  "email_not_verified",
  // Gmail: a Workspace admin blocked the app, or it's restricted to another org.
  "domain_policy",
]);

// A revoke is best effort: nothing may hang on an unreachable provider. The
// promise's value, or null when the deadline came first.
async function withinDeadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Every action call carries `auth`: the org policy verdict and the signed-in
// account it was resolved for. The account owns the receipt, so an action
// with none (signed out, or mid sign-in or account switch) is refused before
// anything is written or done. Connecting and disconnecting a login use
// getAccountId(), the account whose login slot they write.
function createConnectorManager({
  connectors,
  pendingActions,
  actionLog,
  logger,
  getAccountId,
  credentials = null,
  onStatusChanged = () => {},
  randomId = () => crypto.randomBytes(16).toString("hex"),
}) {
  assertEditableTypes(connectors);
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));

  // Writes before a side effect gate it: without a durable row, a crash
  // mid-send could hide a message that was actually sent.
  function writeRequired(step, write) {
    try {
      return write() !== false;
    } catch (error) {
      logger.error(
        "connector receipt write failed",
        { step, ...describeError(error) },
        "connectors"
      );
      return false;
    }
  }

  // Writes after the outcome is known are best effort: a failure leaves the
  // row in its last durable state, which reconciliation treats conservatively.
  function record(write) {
    try {
      write();
    } catch (error) {
      logger.warn("connector receipt update failed", { ...describeError(error) }, "connectors");
    }
  }

  record(() => {
    const reconciled = actionLog.reconcileInterrupted();
    if (reconciled.unknown || reconciled.cancelled || reconciled.orphaned) {
      logger.info("reconciled interrupted connector actions", reconciled, "connectors");
    }
  });

  function resolveAction(connectorId, action, kind) {
    const connector = byId.get(connectorId);
    if (!connector) return { error: "unknown_connector" };
    if (connector.actions[action]?.kind !== kind) return { error: "unknown_action" };
    return { connector };
  }

  // Cards the renderer never answered are expired here too, so their payload
  // (message text) doesn't linger and Recent never shows them as waiting.
  // Their receipts say so rather than a later "app_quit".
  function sweepExpired() {
    for (const actionId of pendingActions.sweepExpired()) {
      record(() =>
        actionLog.update(actionId, { state: "expired", errorCode: "expired" }, "pending")
      );
    }
  }

  async function statusOf(connector) {
    try {
      return { id: connector.id, ...normalizeStatus(await connector.getStatus()) };
    } catch (error) {
      logger.warn(
        "connector status failed",
        { connectorId: connector.id, ...describeError(error) },
        "connectors"
      );
      return { id: connector.id, ...normalizeStatus(null) };
    }
  }

  async function currentBinding(connector) {
    try {
      return normalizeBinding(await connector.getBinding());
    } catch (error) {
      logger.warn(
        "connector binding failed",
        { connectorId: connector.id, ...describeError(error) },
        "connectors"
      );
      return null;
    }
  }

  async function status() {
    sweepExpired();
    return Promise.all([...byId.values()].map(statusOf));
  }

  // One connector's status, or null for an unknown id.
  async function connectorStatus(connectorId) {
    const connector = byId.get(connectorId);
    return connector ? statusOf(connector) : null;
  }

  // The sign-in in flight per account and connector. A new Connect replaces
  // it: a user who closed the browser tab would otherwise wait out the flow.
  const connecting = new Map();
  let statusSequence = 0;

  async function notifyStatusChanged() {
    const sequence = ++statusSequence;
    try {
      const statuses = await status();
      // A later change is already being announced; this snapshot is older.
      if (sequence === statusSequence) onStatusChanged(statuses);
    } catch (error) {
      logger.warn("connector status broadcast failed", describeError(error), "connectors");
    }
  }

  // The connector's answer (Gmail: { kept: true } for a grant it left in
  // place), or null when the revoke failed or ran out of time.
  async function revokeQuietly(connector, credential, options) {
    try {
      return await withinDeadline(connector.revoke(credential, options), REVOKE_TIMEOUT_MS);
    } catch (error) {
      logger.warn(
        "connector revoke failed",
        { connectorId: connector.id, ...describeError(error) },
        "connectors"
      );
      return null;
    }
  }

  async function connect(connectorId, policyState) {
    const accountId = getAccountId();
    const refusal = actionRefusal(policyState, accountId);
    if (refusal) return { status: "unavailable", reason: refusal };
    const connector = byId.get(connectorId);
    if (!connector?.authorize || !credentials) {
      return { status: "unavailable", reason: "unknown_connector" };
    }
    const flowKey = `${accountId}:${connectorId}`;
    connecting.get(flowKey)?.abort();
    const controller = new AbortController();
    connecting.set(flowKey, controller);
    // The OAuth round trip can take minutes. What it returns belongs to the
    // account and slot generation that started it, or to no one.
    const startGeneration = credentials.generation(accountId, connectorId);
    try {
      let credential;
      let replaced = null;
      try {
        credential = await connector.authorize({ signal: controller.signal });
      } catch (error) {
        // Replaced by a newer Connect before the provider answered: nothing
        // was issued, so nothing is saved or revoked.
        if (controller.signal.aborted) return { status: "failed", errorCode: "oauth_cancelled" };
        const summary = describeError(error);
        logger.warn("connector connect failed", { connectorId, ...summary }, "connectors");
        return {
          status: "failed",
          errorCode: CONNECT_ERROR_CODES.has(summary.errorCode)
            ? summary.errorCode
            : "connect_failed",
        };
      }
      // Replaced after the provider answered: the newer attempt is the one
      // the user wants, and nobody will use this login.
      if (controller.signal.aborted) {
        await revokeQuietly(connector, credential);
        return { status: "failed", errorCode: "oauth_cancelled" };
      }
      try {
        if (getAccountId() !== accountId) {
          throw Object.assign(new Error("account changed"), { code: "connection_changed" });
        }
        // A new login: approvals prepared under the old one must not send.
        replaced = credentials.read(accountId, connectorId)?.credential ?? null;
        credentials.replace(accountId, connectorId, credential, startGeneration);
      } catch (error) {
        // Nobody will use this login, so it is revoked rather than left live.
        await revokeQuietly(connector, credential);
        if (error.code === "connection_changed" || error.code === "signed_out") {
          return { status: "failed", errorCode: "connection_changed" };
        }
        // A real write failure (disk, permission, encryption), not a race.
        logger.warn(
          "connector login save failed",
          { connectorId, ...describeError(error) },
          "connectors"
        );
        return { status: "failed", errorCode: "credential_save_failed" };
      }
      invalidate(connectorId);
      await notifyStatusChanged();
      // A login for another account is left with nothing using it, so it is
      // revoked rather than left live. The same account's is kept: Google's
      // revoke would end the new login's grant too. Not awaited: the new
      // login is already saved, and Settings shouldn't wait on the old one.
      if (replaced && connector.loginKey?.(replaced) !== connector.loginKey?.(credential)) {
        void revokeQuietly(connector, replaced);
      }
      const current = await statusOf(connector);
      return {
        status: "connected",
        accountLabel: current.accountLabel,
        workspaceLabel: current.workspaceLabel,
      };
    } finally {
      if (connecting.get(flowKey) === controller) connecting.delete(flowKey);
    }
  }

  // Removing access is always allowed: no policy or plan check.
  // `erasingDevice` (Delete account with device erase) revokes a grant the
  // connector would otherwise keep because another login shares it.
  async function disconnect(connectorId, { erasingDevice = false } = {}) {
    const connector = byId.get(connectorId);
    if (!connector?.revoke || !credentials) {
      return { status: "unavailable", reason: "unknown_connector" };
    }
    const accountId = getAccountId();
    if (!accountId) return { status: "unavailable", reason: "signed_out" };
    const entry = credentials.read(accountId, connectorId);
    let grantKept = false;
    if (entry) {
      const revoked = await revokeQuietly(connector, entry.credential, { erasingDevice });
      grantKept = revoked?.kept === true;
      try {
        credentials.clear(accountId, connectorId, entry.generation);
      } catch (error) {
        if (error.code === "connection_changed" || error.code === "signed_out") {
          // A reconnect landed while revoking: that newer login stays.
          return { status: "failed", errorCode: "connection_changed" };
        }
        // A real write failure (disk, permission): the revoke above already
        // happened, so the login is dead even though the local slot wasn't
        // cleared. Never claim "disconnected" for a slot that's still there.
        logger.warn(
          "connector login clear failed",
          { connectorId, ...describeError(error) },
          "connectors"
        );
        return { status: "failed", errorCode: "disconnect_failed" };
      }
    }
    invalidate(connectorId);
    await notifyStatusChanged();
    // Google still lists the app for that account until the other login
    // (the calendar) is disconnected too; Settings says so.
    return grantKept ? { status: "disconnected", grantKept: true } : { status: "disconnected" };
  }

  // In parallel, so an offline account deletion waits one revoke deadline.
  async function disconnectAll(options) {
    await Promise.all(
      [...byId.values()]
        .filter((connector) => connector.revoke)
        .map((connector) => disconnect(connector.id, options))
    );
  }

  // Reset app data: every login stored on this device is revoked at its
  // provider, whichever account it belongs to and whether anyone is still
  // signed in (the renderer signs out before the reset runs). The files are
  // deleted right after, so nothing is cleared here. In parallel, so an
  // offline reset waits one revoke deadline, not one per login.
  async function revokeAllStored() {
    if (!credentials) return;
    const revokes = [];
    for (const connector of byId.values()) {
      if (!connector.revoke) continue;
      for (const credential of credentials.readAllAccounts(connector.id)) {
        revokes.push(revokeQuietly(connector, credential, { erasingDevice: true }));
      }
      invalidate(connector.id);
    }
    await Promise.all(revokes);
  }

  async function prepare(connectorId, action, args, { policyState, accountId }) {
    sweepExpired();
    const refusal = policyRefusal(policyState);
    if (refusal) return { status: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "approval");
    if (resolved.error) return { status: "unavailable", reason: resolved.error };
    if (!accountId) return RECEIPT_UNAVAILABLE_PREPARE_RESULT;
    const { connector } = resolved;

    const binding = await currentBinding(connector);
    if (!binding) return { status: "unavailable", reason: "not_connected" };

    let prepared;
    try {
      prepared = normalizePrepareResult(
        await connector.prepare(action, args || {}, { binding }),
        connector.actions?.[action]?.editable
      );
    } catch (error) {
      logger.warn(
        "connector prepare threw",
        { connectorId, action, ...describeError(error) },
        "connectors"
      );
      return { ...INVALID_PREPARE_RESULT, errorCode: "prepare_failed" };
    }
    if (prepared.errorCode === "reconnect_needed") void notifyStatusChanged();
    if (prepared.status !== "ready") return prepared;

    const actionId = pendingActions.create({
      connectorId,
      action,
      binding,
      accountId,
      payload: prepared.payload,
      preview: prepared.preview,
    });
    const recorded = writeRequired("pending", () => {
      actionLog.insert({
        id: actionId,
        accountId,
        connector: connectorId,
        action,
        kind: "approval",
        destinationLabel: prepared.preview.destinationLabel,
        state: "pending",
      });
    });
    if (!recorded) {
      pendingActions.cancel(actionId);
      return RECEIPT_UNAVAILABLE_PREPARE_RESULT;
    }
    return { status: "ready", actionId, preview: prepared.preview };
  }

  // Withdrawn rather than left pending: a refused card is settled in the
  // renderer, so nothing may commit it later.
  function withdrawPending(actionId, reason) {
    pendingActions.cancel(actionId);
    record(() => actionLog.update(actionId, { state: "cancelled", errorCode: reason }, "pending"));
    return { state: "not_sent", reason };
  }

  async function commit(actionId, edits, { policyState, accountId }) {
    sweepExpired();
    const entry = pendingActions.get(actionId);
    if (!entry) return { state: "not_sent", reason: "not_found" };
    // A second click while the first is sending must neither send nor
    // overwrite the in-flight row.
    if (entry.state !== "pending") return { state: "not_sent", reason: "not_pending" };

    const connector = byId.get(entry.connectorId);
    const cleanEdits = sanitizeEdits(edits, connector.actions[entry.action]?.editable);
    if (!cleanEdits) return withdrawPending(actionId, "invalid_edit");

    const refusal = policyRefusal(policyState);
    // A policy lookup that timed out or went offline says nothing about this
    // action: leave it pending so the user can press Send again.
    if (refusal === "policy_unavailable") {
      return { state: "not_sent", reason: refusal, retryable: true };
    }
    if (refusal) return withdrawPending(actionId, refusal);
    // Another account (or none) must not send what this one prepared.
    if (entry.accountId !== accountId) return withdrawPending(actionId, "account_changed");

    const begun = pendingActions.beginCommit(actionId, await currentBinding(connector));
    if (!begun.ok) {
      if (begun.reason === "expired" || begun.reason === "connection_changed") {
        const state = begun.reason === "expired" ? "expired" : "cancelled";
        record(() => actionLog.update(actionId, { state, errorCode: begun.reason }, "pending"));
      }
      return { state: "not_sent", reason: begun.reason };
    }

    const recorded = writeRequired(
      "committing",
      () => actionLog.update(actionId, { state: "committing" }, "pending") === 1
    );
    if (!recorded) {
      pendingActions.finish(actionId);
      record(() =>
        actionLog.update(
          actionId,
          { state: "cancelled", errorCode: "receipt_unavailable" },
          "pending"
        )
      );
      return { state: "not_sent", reason: "receipt_unavailable" };
    }

    let result;
    try {
      result = normalizeCommitResult(
        await connector.commit(entry.action, entry.payload, cleanEdits, { binding: entry.binding })
      );
    } catch (error) {
      logger.warn(
        "connector commit threw",
        { connectorId: entry.connectorId, action: entry.action, ...describeError(error) },
        "connectors"
      );
      result = { state: "unknown" };
    }
    if (result.errorCode === "reconnect_needed") void notifyStatusChanged();

    pendingActions.finish(actionId);
    record(() =>
      actionLog.update(actionId, {
        state: result.state,
        resultUrl: result.url || result.checkUrl || null,
        errorCode: result.errorCode || null,
        // Only when the connector's commit named one (Gmail, edited
        // recipients): the row otherwise keeps the label prepare wrote.
        ...(typeof result.destinationLabel === "string"
          ? { destinationLabel: result.destinationLabel }
          : {}),
      })
    );
    logger.info(
      "connector action finished",
      {
        connectorId: entry.connectorId,
        action: entry.action,
        state: result.state,
        errorCode: result.errorCode || null,
      },
      "connectors"
    );
    return result;
  }

  function cancel(actionId, reason) {
    sweepExpired();
    const safeReason = CANCEL_REASONS.has(reason) ? reason : "cancelled_by_user";
    const cancelled = pendingActions.cancel(actionId);
    if (cancelled) {
      const state = safeReason === "expired" ? "expired" : "cancelled";
      record(() => actionLog.update(actionId, { state, errorCode: safeReason }));
    }
    return { cancelled };
  }

  // runtime may carry a `signal`: a cancel that lands before the side effect
  // must stop it (the connector checks it right before acting).
  async function runDirect(connectorId, action, args, { policyState, accountId }, runtime) {
    const refusal = policyRefusal(policyState);
    if (refusal) return { state: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "direct");
    if (resolved.error) return { state: "unavailable", reason: resolved.error };
    if (!accountId) return { state: "unavailable", reason: "receipt_unavailable" };

    const id = randomId();
    const recorded = writeRequired("direct", () => {
      actionLog.insert({
        id,
        accountId,
        connector: connectorId,
        action,
        kind: "direct",
        state: "committing",
      });
    });
    if (!recorded) return { state: "unavailable", reason: "receipt_unavailable" };

    let result;
    try {
      result = normalizeDirectResult(
        await resolved.connector.runDirect(action, args || {}, runtime || {})
      );
    } catch (error) {
      logger.warn(
        "connector direct action threw",
        { connectorId, action, ...describeError(error) },
        "connectors"
      );
      result = uncertainDirectResult("direct_failed");
    }
    const outcome =
      result.state === "not_sent"
        ? { state: "cancelled", errorCode: result.reason }
        : { state: result.state, errorCode: result.errorCode || null };
    record(() =>
      actionLog.update(id, { ...outcome, destinationLabel: result.destinationLabel || null })
    );
    return result;
  }

  // A read for the model (an issue search). It changes nothing anywhere, so
  // there is no pending action and no receipt; it still needs the policy, an
  // account and the bound login, since what it returns leaves the device
  // with the model's request.
  async function query(connectorId, action, args, { policyState, accountId }) {
    const refusal = policyRefusal(policyState);
    if (refusal) return { status: "unavailable", reason: refusal };
    const resolved = resolveAction(connectorId, action, "query");
    if (resolved.error) return { status: "unavailable", reason: resolved.error };
    if (!accountId) return { status: "unavailable", reason: "signed_out" };
    const { connector } = resolved;

    const binding = await currentBinding(connector);
    if (!binding) return { status: "unavailable", reason: "not_connected" };
    // A login filed under another account must not answer for this one.
    if (isString(binding.ownerAccountId) && binding.ownerAccountId !== accountId) {
      return { status: "unavailable", reason: "account_changed" };
    }

    let result;
    try {
      result = normalizeQueryResult(await connector.query(action, args || {}, { binding }));
    } catch (error) {
      logger.warn(
        "connector query threw",
        { connectorId, action, ...describeError(error) },
        "connectors"
      );
      result = queryFailed();
    }
    if (result.errorCode === "reconnect_needed") void notifyStatusChanged();
    logger.info(
      "connector query finished",
      {
        connectorId,
        action,
        status: result.status,
        itemCount: result.status === "ok" ? result.items.length : 0,
        truncated: result.status === "ok" && result.truncated,
        errorCode: result.errorCode || null,
      },
      "connectors"
    );
    return result;
  }

  function invalidate(connectorId) {
    const removed = pendingActions.invalidateConnector(connectorId);
    for (const actionId of removed) {
      record(() =>
        actionLog.update(actionId, { state: "cancelled", errorCode: "connection_changed" })
      );
    }
    return removed;
  }

  // Receipts name the people a user wrote to: only the account that took the
  // action sees them.
  function recentActions(connectorId, limit, accountId) {
    sweepExpired();
    if (!accountId) return [];
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    return actionLog.listRecent(connectorId, safeLimit, accountId);
  }

  return {
    status,
    connectorStatus,
    prepare,
    commit,
    cancel,
    runDirect,
    query,
    invalidate,
    recentActions,
    sweepExpired,
    connect,
    disconnect,
    disconnectAll,
    revokeAllStored,
    notifyStatusChanged,
  };
}

module.exports = { createConnectorManager };
