const fs = require("fs");

const FILE_VERSION = 1;

function sanitizeRecord(record) {
  if (
    typeof record?.environment !== "string" ||
    record.environment.length === 0 ||
    typeof record?.tenant !== "string" ||
    record.tenant.length === 0 ||
    typeof record?.interactionId !== "string" ||
    record.interactionId.length === 0
  ) {
    throw new Error("Complete Corti privacy cleanup identity is required");
  }
  return {
    environment: record.environment,
    tenant: record.tenant,
    interactionId: record.interactionId,
  };
}

function recordKey(record) {
  return `${record.environment}\n${record.tenant}\n${record.interactionId}`;
}

function readEntries(filePath) {
  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (envelope?.version !== FILE_VERSION || !Array.isArray(envelope.entries)) return [];
    return envelope.entries.flatMap((record) => {
      try {
        return [sanitizeRecord(record)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function createCortiPrivacyCleanupQueue({ filePath, cleanup }) {
  let entries = readEntries(filePath);
  let operationTail = Promise.resolve();

  const persist = () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: FILE_VERSION, entries }), { mode: 0o600 });
  };
  const serialize = (operation) => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  const enqueue = (record) =>
    serialize(() => {
      const sanitized = sanitizeRecord(record);
      const key = recordKey(sanitized);
      if (!entries.some((candidate) => recordKey(candidate) === key)) {
        entries = [...entries, sanitized];
        persist();
      }
    });

  const retryPending = () =>
    serialize(async () => {
      const pending = entries;
      const remaining = [];
      for (const record of pending) {
        try {
          await cleanup(record);
        } catch {
          remaining.push(record);
        }
      }
      entries = remaining;
      persist();
      return { attempted: pending.length, remaining: remaining.length };
    });

  return { enqueue, retryPending };
}

module.exports = { createCortiPrivacyCleanupQueue };
