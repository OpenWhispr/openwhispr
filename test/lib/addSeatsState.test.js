const assert = require("node:assert/strict");
const test = require("node:test");

function loadModel() {
  return require("../../src/lib/addSeatsState.ts");
}

const workspace = { seats: 10, seats_used: 8, seat_limit: 500, invitation_count: 3 };
const annualPreview = {
  current_quantity: 10,
  next_quantity: 15,
  seats_used: 8,
  member_seats: 7,
  pending_seats: 1,
  unit_amount: 15996,
  interval: "annual",
  currency: "usd",
  proration_amount: 5335,
  next_invoice_amount: 239940,
  next_invoice_date: "2026-12-20T00:00:00.000Z",
  amount_due: 99800,
};

test("seat changes add availability without changing member and pending occupancy", () => {
  const { addSeatsState } = loadModel();
  assert.deepEqual(addSeatsState({ workspace, selectedDelta: 5, preview: annualPreview }).rows, [
    { kind: "inUse", now: 7, after: 7 },
    { kind: "pending", now: 1, after: 1 },
    { kind: "available", now: 2, after: 7 },
    { kind: "total", now: 10, after: 15 },
  ]);
  const full = addSeatsState({
    workspace,
    preview: { ...annualPreview, next_quantity: 11, seats_used: 10, member_seats: 9 },
  });
  assert.deepEqual(
    full.rows.find(({ kind }) => kind === "available"),
    {
      kind: "available",
      now: 0,
      after: 1,
    }
  );
});

test("seat delta defaults and clamps against both the change and the workspace limits", () => {
  const { addSeatsState } = loadModel();
  for (const [seats, seatLimit, selectedDelta, maxDelta, delta] of [
    [10, 500, undefined, 20, 1],
    [10, 500, 0, 20, 0],
    [10, 500, 5, 20, 5],
    [10, 500, 21, 20, 20],
    [498, undefined, 20, 2, 2],
    [498, 499, undefined, 1, 1],
    [500, 500, undefined, 0, 0],
  ]) {
    const state = addSeatsState({
      workspace: { ...workspace, seats, seat_limit: seatLimit },
      selectedDelta,
    });
    assert.equal(state.delta, delta);
    assert.equal(state.maxDelta, maxDelta);
    assert.equal(state.nextQuantity, null);
  }
  assert.deepEqual(addSeatsState({ workspace, selectedDelta: 20 }).rows.at(-1), {
    kind: "total",
    now: 10,
    after: 30,
  });
});

test("a revised baseline clamps the selection and requires a matching positive quote", () => {
  const { addSeatsState } = loadModel();
  const workspace = { seats: 492, seats_used: 9, seat_limit: 500 };
  const preview = { ...annualPreview, current_quantity: 497, next_quantity: 502 };
  const state = addSeatsState({ workspace, selectedDelta: 5, preview });
  assert.equal(state.maxDelta, 3);
  assert.equal(state.delta, 3);
  assert.equal(state.nextQuantity, null);
  assert.equal(state.proration, null);
  assert.deepEqual(state.rows.at(-1), { kind: "total", now: 497, after: 500 });
  assert.equal(
    addSeatsState({
      workspace,
      selectedDelta: state.delta,
      preview: { ...preview, next_quantity: 500 },
    }).nextQuantity,
    500
  );
});

test("the annual monthly equivalent, proration, and whole invoice use their distinct amounts", () => {
  const { addSeatsState, monthlyEquivalentSeatAmount } = loadModel();
  assert.equal(monthlyEquivalentSeatAmount(15996, "annual"), 1333);
  const state = addSeatsState({ workspace, selectedDelta: 5, preview: annualPreview });
  assert.equal(state.unitPrice, "$13.33");
  assert.equal(state.proration, "$53.35");
  assert.deepEqual(state.invoice, { amount: "$2,399.40", date: "2026-12-20T00:00:00.000Z" });
  const monthly = addSeatsState({
    workspace,
    selectedDelta: 5,
    preview: {
      ...annualPreview,
      currency: "eur",
      interval: "monthly",
      unit_amount: 1200,
      proration_amount: 0,
      next_invoice_date: null,
    },
  });
  assert.equal(monthly.unitPrice, "€12.00");
  assert.equal(monthly.proration, "€0.00");
  assert.deepEqual(monthly.invoice, { amount: "€2,399.40", date: null });
});

test("a legacy quote retains the whole invoice and omits the unsupported split and prices", () => {
  const { addSeatsState } = loadModel();
  const preview = {
    current_quantity: 10,
    next_quantity: 11,
    seats_used: 10,
    currency: "usd",
    amount_due: 10000,
  };
  const state = addSeatsState({ workspace, preview });
  assert.equal(state.unitPrice, null);
  assert.equal(state.proration, null);
  assert.equal(state.nextQuantity, 11);
  assert.deepEqual(state.invoice, { amount: "$100.00", date: null });
  assert.deepEqual(state.rows, [
    { kind: "available", now: 0, after: 1 },
    { kind: "total", now: 10, after: 11 },
  ]);
});

test("zero seats leave occupancy and the authorized summary invoice unchanged", () => {
  const { addSeatsState } = loadModel();
  const summary = {
    interval: "annual",
    unit_amount: 15996,
    next_invoice: { amount: 126700, currency: "usd", date: null },
  };
  const state = addSeatsState({ workspace, selectedDelta: 0, preview: annualPreview, summary });
  assert.ok(state.rows.every(({ now, after }) => now === after));
  assert.equal(state.nextQuantity, null);
  assert.equal(state.unitPrice, "$13.33");
  assert.equal(state.proration, "$0.00");
  assert.deepEqual(state.invoice, { amount: "$1,267.00", date: null });
  assert.equal(
    addSeatsState({ workspace, selectedDelta: 0, preview: annualPreview }).invoice,
    null
  );
  assert.equal(addSeatsState({ workspace, selectedDelta: 0 }).proration, null);
});

test("large occupancy shortfalls can reach their floor without exceeding the workspace cap", () => {
  const { addSeatsState } = loadModel();
  for (const [selectedDelta, seatLimit, maxDelta, nextQuantity] of [
    [0, 500, 35, null],
    [20, 500, 35, null],
    [35, 500, 35, 45],
    [40, 40, 30, null],
  ]) {
    const state = addSeatsState({
      workspace: { seats: 10, seats_used: 45, seat_limit: seatLimit },
      selectedDelta,
      preview: { ...annualPreview, seats_used: 45, next_quantity: 10 + selectedDelta },
    });
    assert.equal(state.maxDelta, maxDelta);
    assert.equal(state.nextQuantity, nextQuantity);
    assert.equal(state.occupancyMinimum, selectedDelta > 0 && nextQuantity === null ? 45 : null);
  }
});
