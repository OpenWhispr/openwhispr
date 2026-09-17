const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/notes/treeDirection.ts");

const ROW_WIDTH = 200;
const ACTION_SLOT_WIDTH = 41;
const ACTION_INLINE_END_OFFSET = 6;

test("folder and team-space labels clear the complete logical-end action slot", async () => {
  const { treeRowActionClearanceStyle } = await load();
  const cases = [
    { row: "folder", direction: "ltr", label: "Projects" },
    { row: "folder", direction: "rtl", label: "المشاريع" },
    { row: "folder", direction: "rtl", label: "مشاريع Project 2026" },
    { row: "team-space", direction: "ltr", label: "فريق المنتج" },
    { row: "team-space", direction: "rtl", label: "Engineering" },
    { row: "team-space", direction: "rtl", label: "فريق Product" },
  ];

  for (const { row, direction, label } of cases) {
    const style = treeRowActionClearanceStyle();
    assert.deepEqual(style, { paddingInlineEnd: 48 });

    if (direction === "ltr") {
      const labelInlineEnd = ROW_WIDTH - style.paddingInlineEnd;
      const actionInlineStart = ROW_WIDTH - ACTION_INLINE_END_OFFSET - ACTION_SLOT_WIDTH;
      assert.ok(
        labelInlineEnd <= actionInlineStart,
        `${row} ${direction} label ${JSON.stringify(label)} overlaps its actions`
      );
    } else {
      const labelInlineEnd = style.paddingInlineEnd;
      const actionInlineStart = ACTION_INLINE_END_OFFSET + ACTION_SLOT_WIDTH;
      assert.ok(
        labelInlineEnd >= actionInlineStart,
        `${row} ${direction} label ${JSON.stringify(label)} overlaps its actions`
      );
    }
  }
});
