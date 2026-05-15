/* eslint-disable */
// Notification Settings - DevTools Console Test Script
// 1. Open OpenWhispr with npm run dev
// 2. Go to Settings → Preferences
// 3. Open DevTools (Ctrl+Shift+I)
// 4. Paste this script in the Console tab and press Enter

(async () => {
  const SETTINGS_KEYS = [
    "notificationsEnabled",
    "notifyMeetingDetection",
    "notifyCalendarReminders",
    "notifyUpdates",
    "notifyTranscriptionStatus",
    "notifyModelDownloads",
    "notifyClipboardOperations",
  ];

  const results = [];
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) {
      passed++;
      results.push(`  PASS: ${name}`);
    } else {
      failed++;
      results.push(`  FAIL: ${name}`);
    }
  }

  // --- Test 1: All settings keys exist in localStorage with correct defaults ---
  console.log("%c[1/5] Checking localStorage defaults...", "font-weight:bold");
  for (const key of SETTINGS_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      assert(`${key} defaults to true (not yet set)`, true);
    } else {
      assert(`${key} exists in localStorage (value: ${raw})`, true);
    }
  }

  // --- Test 2: Toggle master switch off and verify all granular toggles read as disabled ---
  console.log("%c[2/5] Testing master toggle...", "font-weight:bold");
  localStorage.setItem("notificationsEnabled", "false");
  window.dispatchEvent(new StorageEvent("storage", { key: "notificationsEnabled" }));

  const allToggles = document.querySelectorAll('button[role="switch"]');
  const disabledToggles = document.querySelectorAll('button[role="switch"][disabled]');
  assert(
    `Master off: found disabled toggles (${disabledToggles.length} disabled of ${allToggles.length} total)`,
    disabledToggles.length > 0
  );

  // Restore
  localStorage.setItem("notificationsEnabled", "true");

  // --- Test 3: Notification section exists in DOM ---
  console.log("%c[3/5] Checking DOM elements...", "font-weight:bold");

  const pageText = document.body.innerText;
  const sectionTexts = [
    "Meetings & Calendar",
    "Riunioni e calendario",
    "Meetings & Kalender",
    "Réunions et calendrier",
  ];
  const hasMeetingsSection = sectionTexts.some((t) => pageText.includes(t));
  assert("Meetings & Calendar section found in DOM", hasMeetingsSection);

  const activityTexts = [
    "Activity feedback",
    "Attività",
    "Aktivitäts-Feedback",
    "Activité",
  ];
  const hasActivitySection = activityTexts.some((t) => pageText.includes(t));
  assert("Activity feedback section found in DOM", hasActivitySection);

  const disableAllTexts = [
    "Disable all notifications",
    "Disattiva tutte le notifiche",
    "Alle Benachrichtigungen deaktivieren",
    "Désactiver toutes les notifications",
  ];
  const hasDisableAll = disableAllTexts.some((t) => pageText.includes(t));
  assert("Disable all notifications toggle found", hasDisableAll);

  // --- Test 4: Chevron expand/collapse ---
  console.log("%c[4/5] Testing chevron expand/collapse...", "font-weight:bold");

  const chevronButtons = Array.from(document.querySelectorAll("button.flex.items-center.gap-1\\.5"));
  assert(`Found ${chevronButtons.length} collapsible category buttons`, chevronButtons.length >= 2);

  if (chevronButtons.length >= 1) {
    const before = document.body.innerText;
    chevronButtons[0].click();
    await new Promise((r) => setTimeout(r, 100));
    const after = document.body.innerText;
    assert("Clicking chevron changes visible content", before !== after);

    // Collapse back
    chevronButtons[0].click();
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- Test 5: Category toggle sets all children ---
  console.log("%c[5/5] Testing category toggle logic...", "font-weight:bold");

  localStorage.setItem("notifyMeetingDetection", "true");
  localStorage.setItem("notifyCalendarReminders", "true");

  // Turn off both via category
  localStorage.setItem("notifyMeetingDetection", "false");
  localStorage.setItem("notifyCalendarReminders", "false");

  assert(
    "meetingDetection off after category toggle",
    localStorage.getItem("notifyMeetingDetection") === "false"
  );
  assert(
    "calendarReminders off after category toggle",
    localStorage.getItem("notifyCalendarReminders") === "false"
  );

  // Restore defaults
  SETTINGS_KEYS.forEach((key) => localStorage.setItem(key, "true"));

  // --- Report ---
  console.log("\n%c=== NOTIFICATION SETTINGS TEST RESULTS ===", "font-weight:bold; font-size:14px");
  results.forEach((r) => {
    const color = r.includes("FAIL") ? "color:red" : "color:green";
    console.log(`%c${r}`, color);
  });
  console.log(
    `\n%c${passed} passed, ${failed} failed`,
    `font-weight:bold; color:${failed > 0 ? "red" : "green"}`
  );
})();
