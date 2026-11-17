const crypto = require("crypto");
const { createSalesforceExports } = require("./salesforceExports");
const { SALESFORCE_API_BASE } = require("./salesforceApi");
const { connectorResultPage } = require("./oauthResultPage");
const { clarify, MAX_QUERY_LENGTH, MAX_RESULTS } = require("./connectorText");

const OBJECT_PREFIXES = Object.freeze({
  Account: "001",
  Contact: "003",
  Lead: "00Q",
  Opportunity: "006",
});
const OBJECT_ACCESS_ERRORS = new Set([
  "INVALID_TYPE",
  "INVALID_FIELD",
  "NOT_FOUND",
  "INSUFFICIENT_ACCESS",
  "INSUFFICIENT_ACCESS_OR_READONLY",
]);
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const FACT_FIELDS = {
  Account: ["Name", "Industry", "Website", "Phone", "OwnerId"],
  Contact: ["Name", "Email", "Title", "AccountId", "OwnerId"],
  Lead: ["Name", "Email", "Company", "Status", "OwnerId"],
  Opportunity: [
    "Name",
    "StageName",
    "Amount",
    "CurrencyIsoCode",
    "CloseDate",
    "NextStep",
    "AccountId",
    "OwnerId",
  ],
};
const MESSAGES = {
  invalid_input: "Use a supported object, an exact record ID, and a saved source note.",
  invalid_reference:
    "Select an exact Account, Contact, Lead or Opportunity record from Salesforce.",
  connection_changed: "The Salesforce login changed. Prepare a new review under the current login.",
  source_unavailable:
    "The source note is missing or inaccessible. Select an accessible saved note.",
  storage_unavailable: "Local export history is unavailable. No new write was dispatched.",
  stale_record:
    "Salesforce changed since this review. Refresh the record and prepare a new approval.",
  export_required:
    "First save this note's activity to this Opportunity, then review field updates separately.",
  duplicate_operation:
    "This note's export changed or another approval is in progress. Prepare a fresh review.",
  uncertain_operation:
    "An earlier write may have reached Salesforce. Check Salesforce before proceeding; it will not be retried automatically.",
  invalid_field:
    "Select up to three writable custom plain-text Opportunity fields from describe_fields.",
  too_long:
    "The reviewed text exceeds a Salesforce field length limit. Shorten it and review again.",
  task_status_unavailable:
    "No usable closed Task status was found in this Salesforce organization.",
  forbidden: "Salesforce does not allow this operation for the connected user or record.",
};
function failed(errorCode, commit = false) {
  return {
    [commit ? "state" : "status"]: "failed",
    errorCode,
    message:
      MESSAGES[errorCode] ??
      "Salesforce refused this request. Check record access, required fields and validation rules before preparing another review.",
  };
}
function validRecord(args) {
  return (
    Object.hasOwn(OBJECT_PREFIXES, args?.objectType ?? "") &&
    RECORD_ID.test(args?.recordId ?? "") &&
    args.recordId.startsWith(OBJECT_PREFIXES[args.objectType])
  );
}
function validNoteId(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function escapeSearch(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[%_]/g, "\\$&")
    .replace(/[\r\n\t\b\f]/g, " ");
}
function readableFields(metadata) {
  return (metadata?.fields ?? []).filter(
    (field) =>
      FIELD_NAME.test(field.name) &&
      field.accessible !== false &&
      field.deprecatedAndHidden !== true
  );
}
function customTextFields(metadata) {
  if (!metadata?.updateable) return [];
  return readableFields(metadata).filter(
    (field) =>
      field.custom === true &&
      /^[A-Za-z][A-Za-z0-9_]*__c$/.test(field.name) &&
      field.updateable === true &&
      !field.calculated &&
      !field.htmlFormatted &&
      ["string", "textarea"].includes(field.type) &&
      Number.isSafeInteger(field.length) &&
      field.length > 0 &&
      field.length <= 131072
  );
}
function recordUrl(binding, objectType, recordId) {
  return `${binding.instanceUrl}/lightning/r/${objectType}/${recordId}/view`;
}
function sameSnapshot(before, after, names) {
  return names.every((name) => (before[name] ?? null) === (after[name] ?? null));
}
function conditionFor(record) {
  const date = Date.parse(record?.LastModifiedDate);
  return Number.isFinite(date) ? { "If-Unmodified-Since": new Date(date).toUTCString() } : null;
}

function createSalesforceConnector({ api, auth, credentials, exports: exportStore, getNote }) {
  function bound(binding) {
    return (
      binding?.ownerAccountId &&
      credentials.activeAccountId() === binding.ownerAccountId &&
      auth.boundCredential(binding)
    );
  }
  async function request(binding, path, options = {}) {
    if (!bound(binding)) return { ok: false, errorCode: "connection_changed", outcome: "failed" };
    let access = await auth.getAccessToken(binding);
    if (!access.ok) return access;
    if (!bound(binding)) return { ok: false, errorCode: "connection_changed", outcome: "failed" };
    const { beforeDispatch, ...requestOptions } = options;
    const run = async () => {
      if (beforeDispatch && !(await beforeDispatch()))
        return { ok: false, errorCode: "source_unavailable", outcome: "failed" };
      if (!bound(binding)) return { ok: false, errorCode: "connection_changed", outcome: "failed" };
      return api.request({
        instanceUrl: binding.instanceUrl,
        accessToken: access.token,
        method: "GET",
        path: `${SALESFORCE_API_BASE}${path}`,
        ...requestOptions,
      });
    };
    let result = await run();
    // An explicitly rejected token did not mutate CRM state. No other write
    // failure is replayed, including a timeout or a malformed success reply.
    if (
      !result.ok &&
      result.errorCode === "INVALID_SESSION_ID" &&
      (options.method == null || (result.refused === true && result.outcome === "failed"))
    ) {
      access = await auth.getAccessToken(binding, { forceRefresh: true });
      if (!access.ok) return { ...access, outcome: "failed" };
      if (!bound(binding)) return { ok: false, errorCode: "connection_changed", outcome: "failed" };
      result = await run();
    }
    if (!options.method && !bound(binding))
      return { ok: false, errorCode: "connection_changed", outcome: "failed" };
    return result;
  }
  async function describe(binding, objectType) {
    return request(binding, `/sobjects/${objectType}/describe`);
  }
  async function readRecord(binding, objectType, recordId, names) {
    const result = await request(
      binding,
      `/sobjects/${objectType}/${recordId}?fields=${names.join(",")}`
    );
    if (result.ok && result.data?.Id?.slice(0, 15) !== recordId.slice(0, 15))
      return { ok: false, errorCode: "not_found" };
    return result;
  }
  async function resolveRecord(args, binding, extraFields = []) {
    if (!validRecord(args)) return { ok: false, errorCode: "invalid_reference" };
    const metadata = await describe(binding, args.objectType);
    if (!metadata.ok) return metadata;
    if (!metadata.data?.queryable) return { ok: false, errorCode: "forbidden" };
    const allowed = new Set(readableFields(metadata.data).map((field) => field.name));
    const names = [
      ...new Set(["Id", "LastModifiedDate", ...FACT_FIELDS[args.objectType], ...extraFields]),
    ].filter((name) => allowed.has(name));
    if (!names.includes("Id")) return { ok: false, errorCode: "forbidden" };
    const result = await readRecord(binding, args.objectType, args.recordId, names);
    return result.ok ? { ...result, metadata: metadata.data } : result;
  }
  function keyFor(args, binding) {
    return {
      ownerAccountId: binding.ownerAccountId,
      organizationId: binding.workspaceId,
      instanceUrl: binding.instanceUrl,
      noteId: args.noteId,
      objectType: args.objectType,
      recordId: args.recordId.slice(0, 15),
    };
  }
  async function source(noteId, binding) {
    if (!validNoteId(noteId) || !bound(binding)) return null;
    const note = await getNote?.(noteId, binding.ownerAccountId);
    if (
      !bound(binding) ||
      !note ||
      note.deleted_at ||
      (note.account_id != null && note.account_id !== binding.ownerAccountId)
    )
      return null;
    return note;
  }
  function factItem(args, binding, record) {
    return {
      kind: "record",
      objectType: args.objectType,
      recordId: args.recordId,
      url: recordUrl(binding, args.objectType, args.recordId),
      ...Object.fromEntries(
        FACT_FIELDS[args.objectType]
          .filter((name) => Object.hasOwn(record, name))
          .map((name) => [name, record[name]])
      ),
      retrievedAt: new Date().toISOString(),
    };
  }
  async function query(action, args, binding) {
    if (!bound(binding)) return failed("connection_changed");
    if (action === "search_records") {
      const term = typeof args?.query === "string" ? args.query.trim() : "";
      if (!term)
        return clarify(
          "Ask the user which Salesforce record to search for, then have them choose an exact result."
        );
      if (term.length > MAX_QUERY_LENGTH || /[\u0000-\u001f]/.test(term))
        return failed("invalid_input");
      const types = args.objectType == null ? Object.keys(OBJECT_PREFIXES) : [args.objectType];
      if (types.some((type) => !Object.hasOwn(OBJECT_PREFIXES, type)))
        return failed("invalid_input");
      const items = [];
      const unavailableObjects = [];
      const searchingAll = args.objectType == null;
      let truncated = false;
      for (const objectType of types) {
        const metadata = await describe(binding, objectType);
        if (!metadata.ok) {
          if (!searchingAll || !OBJECT_ACCESS_ERRORS.has(metadata.errorCode))
            return failed(metadata.errorCode);
          unavailableObjects.push(objectType);
          continue;
        }
        if (!metadata.data?.queryable) {
          if (!searchingAll) return failed("forbidden");
          unavailableObjects.push(objectType);
          continue;
        }
        const names = new Set(readableFields(metadata.data).map((field) => field.name));
        if (!names.has("Id") || !names.has("Name")) {
          if (!searchingAll) return failed("forbidden");
          unavailableObjects.push(objectType);
          continue;
        }
        const fields = ["Id", ...FACT_FIELDS[objectType].filter((name) => names.has(name))];
        const searchFields = [
          "Name",
          ...(["Contact", "Lead"].includes(objectType) && names.has("Email") ? ["Email"] : []),
        ];
        const clause = searchFields
          .map((name) => `${name} LIKE '%${escapeSearch(term)}%'`)
          .join(" OR ");
        const soql = `SELECT ${fields.join(",")} FROM ${objectType} WHERE (${clause}) ORDER BY Name LIMIT ${MAX_RESULTS + 1}`;
        const found = await request(binding, `/query?q=${encodeURIComponent(soql)}`);
        if (!found.ok) {
          if (!searchingAll || !OBJECT_ACCESS_ERRORS.has(found.errorCode))
            return failed(found.errorCode);
          unavailableObjects.push(objectType);
          continue;
        }
        const records = found.data?.records ?? [];
        truncated ||= records.length > MAX_RESULTS || found.data?.done === false;
        for (const record of records.slice(0, MAX_RESULTS)) {
          if (validRecord({ objectType, recordId: record.Id }))
            items.push(factItem({ objectType, recordId: record.Id }, binding, record));
        }
      }
      // Completeness belongs inside items: the shared query normalizer drops
      // extra outer properties. Reserve a slot so it survives bounded results.
      const limit = unavailableObjects.length ? 19 : 20;
      const scope = unavailableObjects.length
        ? [
            {
              kind: "search_scope",
              unavailableObjects,
              unavailableObjectCount: unavailableObjects.length,
            },
          ]
        : [];
      return {
        status: "ok",
        items: [...items.slice(0, limit), ...scope],
        truncated: truncated || items.length > limit || unavailableObjects.length > 0,
      };
    }
    if (!["get_record", "describe_fields", "get_briefing"].includes(action))
      return failed("unknown_action");
    if (!validRecord(args)) return failed("invalid_reference");
    if (action === "describe_fields") {
      if (args.objectType !== "Opportunity") return failed("invalid_field");
      if (args.query != null && typeof args.query !== "string") return failed("invalid_input");
      const term = (args.query ?? "").trim().toLowerCase();
      if (term.length > MAX_QUERY_LENGTH) return failed("invalid_input");
      const resolved = await resolveRecord(args, binding);
      if (!resolved.ok) return failed(resolved.errorCode);
      const fields = customTextFields(resolved.metadata).filter(
        (field) =>
          !term ||
          field.name.toLowerCase().includes(term) ||
          (field.label ?? "").toLowerCase().includes(term)
      );
      return {
        status: "ok",
        items: fields.slice(0, 20).map((field) => ({
          name: field.name,
          label: field.label ?? field.name,
          type: field.type,
          maxLength: field.length,
        })),
        truncated: fields.length > 20,
      };
    }
    const resolved = await resolveRecord(args, binding);
    if (!resolved.ok) return failed(resolved.errorCode);
    const facts = factItem(args, binding, resolved.data);
    if (action === "get_record") return { status: "ok", items: [facts], truncated: false };
    if (
      args.noteIds != null &&
      (!Array.isArray(args.noteIds) || args.noteIds.length > 10 || !args.noteIds.every(validNoteId))
    )
      return failed("invalid_input");
    const linked = exportStore.list(keyFor(args, binding));
    const ids = [
      ...new Set([...linked.slice(0, 10).map((row) => row.note_id), ...(args.noteIds ?? [])]),
    ];
    const notes = [];
    let unavailableNotes = 0;
    for (const id of ids.slice(0, 18)) {
      const note = await source(id, binding);
      if (note) {
        const association = linked.find((row) => row.note_id === id);
        notes.push({
          kind: "note",
          noteId: id,
          title: note.title ?? "",
          createdAt: note.created_at ?? null,
          updatedAt: note.updated_at ?? null,
          context: association ? "linked" : "explicit",
          activityUrl: association ? recordUrl(binding, "Task", association.activity_id) : null,
          exportedAt: association?.confirmed_at ?? null,
        });
      } else unavailableNotes += 1;
    }
    return {
      status: "ok",
      items: [
        {
          ...facts,
          unavailableNotes,
          unavailableFields: FACT_FIELDS[args.objectType].filter(
            (name) => !Object.hasOwn(resolved.data, name)
          ),
        },
        ...notes,
      ],
      truncated: linked.length > 10 || ids.length > 18,
    };
  }
  async function taskConfiguration(binding, objectType, update) {
    const result = await describe(binding, "Task");
    if (!result.ok) return result;
    const permission = update ? "updateable" : "createable";
    if (!result.data?.[permission]) return { ok: false, errorCode: "forbidden" };
    const fields = new Map(readableFields(result.data).map((field) => [field.name, field]));
    const relationship = ["Contact", "Lead"].includes(objectType) ? "WhoId" : "WhatId";
    if (
      ["Subject", "Description", "Status", ...(update ? [] : [relationship])].some(
        (name) => !fields.get(name)?.[permission]
      ) ||
      !fields.get(relationship)?.referenceTo?.includes(objectType)
    )
      return { ok: false, errorCode: "forbidden" };
    const statuses = await request(
      binding,
      `/query?q=${encodeURIComponent("SELECT ApiName FROM TaskStatus WHERE IsClosed = true ORDER BY SortOrder LIMIT 10")}`
    );
    if (!statuses.ok) return statuses;
    const active = fields.get("Status").picklistValues ?? [];
    const status = statuses.data?.records?.find(
      (record) =>
        typeof record.ApiName === "string" &&
        active.some((value) => value.active && value.value === record.ApiName)
    )?.ApiName;
    if (!status) return { ok: false, errorCode: "task_status_unavailable" };
    return { ok: true, fields, relationship, status };
  }
  function textProblem(title, body, config) {
    if (
      typeof title !== "string" ||
      !title.trim() ||
      /[\r\n]/.test(title) ||
      typeof body !== "string" ||
      !body.trim()
    )
      return "invalid_input";
    if (
      title.length > Math.min(255, config.fields.get("Subject").length ?? 255) ||
      body.length > Math.min(32000, config.fields.get("Description").length ?? 32000)
    )
      return "too_long";
    return null;
  }
  async function readTask(binding, activityId, args) {
    const result = await readRecord(binding, "Task", activityId, [
      "Id",
      "Subject",
      "Description",
      "Status",
      "WhoId",
      "WhatId",
      "LastModifiedDate",
    ]);
    const relationship = ["Contact", "Lead"].includes(args.objectType) ? "WhoId" : "WhatId";
    if (result.ok && result.data[relationship]?.slice(0, 15) !== args.recordId.slice(0, 15))
      return { ok: false, errorCode: "stale_record" };
    if (result.ok && !conditionFor(result.data)) return { ok: false, errorCode: "stale_record" };
    return result;
  }
  async function prepare(action, args, binding) {
    if (!["export_conversation", "update_fields"].includes(action)) return failed("unknown_action");
    if (!validRecord(args)) return failed("invalid_reference");
    if (!bound(binding)) return failed("connection_changed");
    const note = await source(args.noteId, binding);
    if (!note) return failed("source_unavailable");
    const key = keyFor(args, binding);
    const saved = exportStore.get(key);
    const kind = action === "export_conversation" ? "activity" : "fields";
    if (saved?.[`${kind}_state`] === "unknown") return failed("uncertain_operation");
    if (saved?.activity_state === "committing" || saved?.fields_state === "committing")
      return failed("duplicate_operation");
    const selected = await resolveRecord(args, binding);
    if (!selected.ok) return failed(selected.errorCode);
    const credential = bound(binding);
    if (!credential) return failed("connection_changed");
    const payload = {
      ...key,
      version: saved?.version ?? 0,
      activityId: saved?.activity_id ?? null,
    };
    const preview = {
      destinationLabel: `${args.objectType}: ${selected.data.Name ?? args.recordId} (${args.recordId})`,
      accountLabel: credential.userName ?? "",
      workspaceLabel: credential.organizationName ?? binding.workspaceId,
      body: "",
    };
    if (action === "export_conversation") {
      const config = await taskConfiguration(binding, args.objectType, !!payload.activityId);
      if (!config.ok) return failed(config.errorCode);
      const sourceDate = Date.parse(note.created_at);
      const provenance = `Source: OpenWhispr — ${note.title || "Untitled note"}${Number.isFinite(sourceDate) ? ` (${new Date(sourceDate).toISOString().slice(0, 10)})` : ""}`;
      const activityBody =
        typeof args.body === "string" ? `${args.body}\n\n${provenance}` : args.body;
      const problem = textProblem(args.title, activityBody, config);
      if (problem) return failed(problem);
      let before = null;
      if (payload.activityId) {
        const task = await readTask(binding, payload.activityId, args);
        if (!task.ok) return failed(task.errorCode);
        before = task.data;
      }
      return {
        status: "ready",
        payload: { ...payload, title: args.title, body: activityBody, before },
        preview: {
          ...preview,
          verbKey: "salesforceActivity",
          title: args.title,
          body: activityBody,
          notes: payload.activityId ? [{ key: "connectors.salesforce.notes.updateExisting" }] : [],
        },
      };
    }
    if (
      args.objectType !== "Opportunity" ||
      !saved?.activity_id ||
      saved.activity_state !== "succeeded"
    )
      return failed("export_required");
    if (
      !Array.isArray(args.fields) ||
      args.fields.length < 1 ||
      args.fields.length > 3 ||
      new Set(args.fields.map((field) => field?.name)).size !== args.fields.length
    )
      return failed("invalid_field");
    const allowed = new Map(
      customTextFields(selected.metadata).map((field) => [field.name, field])
    );
    for (const field of args.fields) {
      if (!field || !allowed.has(field.name) || typeof field.value !== "string")
        return failed("invalid_field");
      if (field.value.length > allowed.get(field.name).length) return failed("too_long");
    }
    const current = await readRecord(binding, args.objectType, args.recordId, [
      "Id",
      "LastModifiedDate",
      ...args.fields.map((field) => field.name),
    ]);
    if (!current.ok) return failed(current.errorCode);
    if (!conditionFor(current.data)) return failed("stale_record");
    const fields = args.fields.map((field, index) => ({
      key: `value${index}`,
      name: field.name,
      label: allowed.get(field.name).label ?? field.name,
      before: current.data[field.name] ?? "",
      maxLength: allowed.get(field.name).length,
      value: field.value,
    }));
    return {
      status: "ready",
      payload: { ...payload, fields, before: current.data },
      preview: {
        ...preview,
        verbKey: "salesforceFields",
        salesforceFields: fields.map(({ value: _value, ...field }) => field),
        fields: Object.fromEntries(
          fields.flatMap((field, index) => [
            [field.key, field.value],
            [`include${index}`, "yes"],
          ])
        ),
      },
    };
  }
  async function commit(action, payload, edits, binding) {
    if (!["export_conversation", "update_fields"].includes(action))
      return failed("unknown_action", true);
    if (
      !bound(binding) ||
      payload.ownerAccountId !== binding.ownerAccountId ||
      payload.organizationId !== binding.workspaceId ||
      payload.instanceUrl !== binding.instanceUrl
    )
      return failed("connection_changed", true);
    if (!validRecord(payload)) return failed("invalid_reference", true);
    if (!(await source(payload.noteId, binding))) return failed("source_unavailable", true);
    const saved = exportStore.get(payload);
    const kind = action === "export_conversation" ? "activity" : "fields";
    if (saved?.[`${kind}_state`] === "unknown") return failed("uncertain_operation", true);
    if ((saved?.version ?? 0) !== payload.version) return failed("duplicate_operation", true);
    const selected = await resolveRecord(payload, binding);
    if (!selected.ok) return failed(selected.errorCode, true);
    let body;
    let path;
    let headers;
    if (kind === "activity") {
      const config = await taskConfiguration(binding, payload.objectType, !!payload.activityId);
      if (!config.ok) return failed(config.errorCode, true);
      const title = edits.title ?? payload.title;
      const description = edits.body ?? payload.body;
      const problem = textProblem(title, description, config);
      if (problem) return failed(problem, true);
      body = { Subject: title, Description: description, Status: config.status };
      path = `/sobjects/Task${payload.activityId ? `/${payload.activityId}` : ""}`;
      if (payload.activityId) {
        const task = await readTask(binding, payload.activityId, payload);
        if (!task.ok) return failed(task.errorCode, true);
        if (
          !sameSnapshot(payload.before, task.data, [
            "Subject",
            "Description",
            "Status",
            "WhoId",
            "WhatId",
            "LastModifiedDate",
          ])
        )
          return failed("stale_record", true);
        headers = conditionFor(task.data);
      } else body[config.relationship] = payload.recordId;
    } else {
      if (
        payload.objectType !== "Opportunity" ||
        saved?.activity_state !== "succeeded" ||
        !saved.activity_id
      )
        return failed("export_required", true);
      const allowed = new Map(
        customTextFields(selected.metadata).map((field) => [field.name, field])
      );
      const chosen = payload.fields.filter((_field, index) => edits[`include${index}`] !== "no");
      if (
        payload.fields.some(
          (_field, index) =>
            edits[`include${index}`] != null && !["yes", "no"].includes(edits[`include${index}`])
        )
      )
        return failed("invalid_input", true);
      if (!chosen.length) return failed("no_fields_selected", true);
      body = {};
      for (const field of chosen) {
        if (!allowed.has(field.name)) return failed("invalid_field", true);
        const value = edits[field.key] ?? field.value;
        if (typeof value !== "string") return failed("invalid_input", true);
        if (value.length > allowed.get(field.name).length) return failed("too_long", true);
        body[field.name] = value;
      }
      const current = await readRecord(binding, "Opportunity", payload.recordId, [
        "Id",
        "LastModifiedDate",
        ...chosen.map((field) => field.name),
      ]);
      if (!current.ok) return failed(current.errorCode, true);
      if (
        !sameSnapshot(payload.before, current.data, [
          "LastModifiedDate",
          ...chosen.map((field) => field.name),
        ]) ||
        !conditionFor(current.data)
      )
        return failed("stale_record", true);
      headers = conditionFor(current.data);
      path = `/sobjects/Opportunity/${payload.recordId}`;
    }
    // Access can change while metadata and record reads are in flight.
    if (!(await source(payload.noteId, binding))) return failed("source_unavailable", true);
    if (!bound(binding)) return failed("connection_changed", true);
    const operationId = crypto.randomUUID();
    if (!exportStore.begin(payload, kind, operationId, payload.version))
      return failed("duplicate_operation", true);
    const checkUrl = recordUrl(binding, payload.objectType, payload.recordId);
    let result;
    try {
      result = await request(binding, path, {
        method: kind === "activity" && !payload.activityId ? "POST" : "PATCH",
        body,
        beforeDispatch: () => source(payload.noteId, binding),
        ...(headers ? { headers } : {}),
      });
    } catch {
      result = { ok: false, outcome: "unknown", errorCode: "network" };
    }
    let activityId = payload.activityId;
    if (result.ok && kind === "activity" && !activityId) {
      activityId = result.data?.id;
      if (
        !RECORD_ID.test(activityId ?? "") ||
        !activityId.startsWith("00T") ||
        result.data?.success !== true
      )
        result = { ok: false, outcome: "unknown", errorCode: "bad_response" };
    }
    const state = result.ok ? "succeeded" : result.outcome === "unknown" ? "unknown" : "failed";
    try {
      if (!exportStore.finish(payload, kind, operationId, state, activityId))
        return { state: "unknown", errorCode: "storage_unavailable", checkUrl };
    } catch {
      return { state: "unknown", errorCode: "storage_unavailable", checkUrl };
    }
    if (result.ok)
      return {
        state: "sent",
        url: recordUrl(
          binding,
          kind === "activity" ? "Task" : payload.objectType,
          kind === "activity" ? activityId : payload.recordId
        ),
      };
    if (state === "unknown") return { state: "unknown", errorCode: result.errorCode, checkUrl };
    return failed(
      result.errorCode === "PRECONDITION_FAILED" || result.errorCode === "http_412"
        ? "stale_record"
        : result.errorCode,
      true
    );
  }
  async function guarded(run, committing = false) {
    try {
      return await run();
    } catch (error) {
      return failed(error.code === "storage_unavailable" ? error.code : "query_failed", committing);
    }
  }
  return {
    id: "salesforce",
    actions: {
      search_records: { kind: "query" },
      get_record: { kind: "query" },
      describe_fields: { kind: "query" },
      get_briefing: { kind: "query" },
      export_conversation: { kind: "approval", editable: { title: "line", body: "text" } },
      update_fields: {
        kind: "approval",
        editable: {
          value0: "text",
          include0: "line",
          value1: "text",
          include1: "line",
          value2: "text",
          include2: "line",
        },
      },
    },
    async getStatus() {
      const entry = credentials.read(credentials.activeAccountId(), "salesforce");
      return entry
        ? { ...auth.statusOf(entry.credential), configured: true }
        : {
            connected: false,
            configured: auth.isConfigured(),
            accountLabel: null,
            workspaceLabel: null,
            needsReconnect: false,
          };
    },
    async getBinding() {
      const ownerAccountId = credentials.activeAccountId();
      const entry = credentials.read(ownerAccountId, "salesforce");
      return entry
        ? {
            ownerAccountId,
            accountId: entry.credential.userId,
            workspaceId: entry.credential.organizationId,
            instanceUrl: entry.credential.instanceUrl,
            generation: entry.generation,
          }
        : null;
    },
    query: (action, args, { binding } = {}) =>
      guarded(async () => {
        const result = await query(action, args, binding);
        return bound(binding) ? result : failed("connection_changed");
      }),
    prepare: (action, args, { binding } = {}) =>
      guarded(async () => {
        const result = await prepare(action, args, binding);
        return bound(binding) ? result : failed("connection_changed");
      }),
    commit: (action, payload, edits = {}, { binding } = {}) =>
      guarded(() => commit(action, payload, edits, binding), true),
    authorize: (options) => auth.authorize(options),
    revoke: (credential, options) => auth.revoke(credential, options),
    loginKey: (credential) =>
      `${credential?.instanceUrl}:${credential?.organizationId}:${credential?.userId}`,
  };
}
function buildSalesforceConnector(deps) {
  const { createSalesforceApi } = require("./salesforceApi");
  const { createSalesforceAuth } = require("./salesforceAuth");
  const api = createSalesforceApi({ fetchImpl: deps.fetch });
  const auth = createSalesforceAuth({
    api,
    credentials: deps.credentials,
    getClientId: () => deps.env?.SALESFORCE_CLIENT_ID,
    getLoginUrl: () => deps.env?.SALESFORCE_LOGIN_URL ?? "https://login.salesforce.com",
    runOAuthLoopbackFlow: deps.runOAuthLoopbackFlow,
    OAuthFlowError: deps.OAuthFlowError,
    renderResultPage: connectorResultPage(deps, "salesforce"),
    logger: deps.logger,
  });
  return createSalesforceConnector({
    api,
    auth,
    credentials: deps.credentials,
    exports: createSalesforceExports(deps.database),
    getNote: deps.getSalesforceNote,
  });
}
module.exports = { createSalesforceConnector, buildSalesforceConnector };
