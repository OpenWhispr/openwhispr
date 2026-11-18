// Associations contain identifiers and outcomes only. CRM content and tokens
// stay out of this table; a receipt never grants access to its source note.
// activity_hash is a one-way hash of the text last written, so a re-export
// can tell the Task was edited in Salesforce without keeping that text.
function createSalesforceExports(databaseManager) {
  let initializedDatabase = null;
  function database() {
    const db = databaseManager?.db;
    if (!db)
      throw Object.assign(new Error("Salesforce export storage unavailable"), {
        code: "storage_unavailable",
      });
    if (db !== initializedDatabase) {
      db.exec(`CREATE TABLE IF NOT EXISTS salesforce_exports (
        account_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        note_id INTEGER NOT NULL,
        object_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        activity_id TEXT,
        activity_hash TEXT,
        activity_state TEXT NOT NULL DEFAULT 'idle',
        fields_state TEXT NOT NULL DEFAULT 'idle',
        operation_id TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        confirmed_at TEXT,
        PRIMARY KEY (account_id, organization_id, instance_url, note_id, object_type, record_id)
      )`);
      // Tables made by preview builds of this feature predate the column.
      const columns = db.prepare("PRAGMA table_info(salesforce_exports)").all();
      if (!columns.some((column) => column.name === "activity_hash"))
        db.exec("ALTER TABLE salesforce_exports ADD COLUMN activity_hash TEXT");
      // A process can stop after dispatch and before saving its receipt.
      // Only a new store's initialization reconciles, never an active read.
      db.exec(`UPDATE salesforce_exports SET
        activity_state = CASE WHEN activity_state = 'committing' THEN 'unknown' ELSE activity_state END,
        fields_state = CASE WHEN fields_state = 'committing' THEN 'unknown' ELSE fields_state END
        WHERE activity_state = 'committing' OR fields_state = 'committing'`);
      initializedDatabase = db;
    }
    return db;
  }
  const where =
    "account_id = ? AND organization_id = ? AND instance_url = ? AND note_id = ? AND object_type = ? AND record_id = ?";
  function values(key) {
    return [
      key.ownerAccountId,
      key.organizationId,
      key.instanceUrl,
      key.noteId,
      key.objectType,
      key.recordId,
    ];
  }
  function column(kind) {
    if (kind !== "activity" && kind !== "fields")
      throw new Error("Invalid Salesforce operation kind");
    return `${kind}_state`;
  }
  // A renamed My Domain moves the organization to a new instance URL and keeps
  // its Task ids. A write still in flight finishes under the URL it began on.
  function followInstance(key) {
    database()
      .prepare(
        `UPDATE OR IGNORE salesforce_exports SET instance_url = ?
        WHERE account_id = ? AND organization_id = ? AND instance_url != ?
          AND activity_state != 'committing' AND fields_state != 'committing'`
      )
      .run(key.instanceUrl, key.ownerAccountId, key.organizationId, key.instanceUrl);
  }
  return {
    get(key) {
      followInstance(key);
      return (
        database()
          .prepare(`SELECT * FROM salesforce_exports WHERE ${where}`)
          .get(...values(key)) ?? null
      );
    },
    list(key) {
      followInstance(key);
      return database()
        .prepare(
          `SELECT note_id, activity_id, confirmed_at FROM salesforce_exports
        WHERE account_id = ? AND organization_id = ? AND instance_url = ? AND object_type = ? AND record_id = ?
          AND activity_id IS NOT NULL AND confirmed_at IS NOT NULL
        ORDER BY confirmed_at DESC LIMIT 11`
        )
        .all(key.ownerAccountId, key.organizationId, key.instanceUrl, key.objectType, key.recordId);
    },
    // An unknown outcome doesn't block a new write: the card approving it was
    // prepared after that outcome (the version proves it) and said so.
    begin(key, kind, operationId, expectedVersion) {
      const db = database();
      const stateColumn = column(kind);
      db.prepare(
        `INSERT OR IGNORE INTO salesforce_exports
        (account_id, organization_id, instance_url, note_id, object_type, record_id) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(...values(key));
      return (
        db
          .prepare(
            `UPDATE salesforce_exports SET ${stateColumn} = 'committing', operation_id = ?, version = version + 1
        WHERE ${where} AND version = ?
          AND activity_state != 'committing' AND fields_state != 'committing'`
          )
          .run(operationId, ...values(key), expectedVersion).changes === 1
      );
    },
    finish(key, kind, operationId, state, activityId = null, activityHash = null) {
      const stateColumn = column(kind);
      const activityPatch =
        kind === "activity" && state === "succeeded"
          ? ", activity_id = ?, activity_hash = ?, confirmed_at = CURRENT_TIMESTAMP"
          : "";
      return (
        database()
          .prepare(
            `UPDATE salesforce_exports SET ${stateColumn} = ?${activityPatch}
        WHERE ${where} AND operation_id = ? AND ${stateColumn} = 'committing'`
          )
          .run(
            state,
            ...(activityPatch ? [activityId, activityHash] : []),
            ...values(key),
            operationId
          ).changes === 1
      );
    },
    // Only while no later write has begun (each begin bumps the version).
    recordActivityHash(key, activityId, version, activityHash) {
      return (
        database()
          .prepare(
            `UPDATE salesforce_exports SET activity_hash = ?
        WHERE ${where} AND activity_id = ? AND version = ? AND activity_state = 'succeeded'`
          )
          .run(activityHash, ...values(key), activityId, version).changes === 1
      );
    },
  };
}
module.exports = { createSalesforceExports };
