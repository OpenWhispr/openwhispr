const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/audioDeviceUtils.ts");

const input = (deviceId, label) => ({ kind: "audioinput", deviceId, label });

test("enumerates Realtek as built-in while excluding the default Plantronics headset", async () => {
  const { findBuiltInMicrophone } = await load();
  const realtek = input("realtek-device", "Microphone Array (Realtek(R) Audio)");
  let calls = 0;
  const mediaDevices = {
    async enumerateDevices() {
      calls += 1;
      return [
        input(
          "default",
          "Default - Headset Microphone (Plantronics Blackwire 5220 Series) (047f:c053)"
        ),
        { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
        input("plantronics", "Headset Microphone (Plantronics Blackwire 5220 Series)"),
        realtek,
      ];
    },
  };

  assert.equal(await findBuiltInMicrophone(mediaDevices), realtek);
  assert.equal(calls, 1);
});

test("returns undefined when enumeration contains only external microphones", async () => {
  const { findBuiltInMicrophone } = await load();
  const mediaDevices = {
    enumerateDevices: async () => [
      input("plantronics", "Headset Microphone (Plantronics Blackwire 5220 Series)"),
      input("usb", "USB Microphone"),
    ],
  };

  assert.equal(await findBuiltInMicrophone(mediaDevices), undefined);
});

test("surfaces enumerateDevices failures to the caller", async () => {
  const { findBuiltInMicrophone } = await load();
  const enumerationError = new Error("enumeration failed");
  const mediaDevices = {
    enumerateDevices: async () => {
      throw enumerationError;
    },
  };

  await assert.rejects(findBuiltInMicrophone(mediaDevices), (error) => error === enumerationError);
});
