const test = require("node:test");
const assert = require("node:assert/strict");

const EXPECTED = {
  en: {
    holdHotkey: "Hold {{hotkey}} while you speak.",
    doublePress: "Double tap",
    handsFreeDetail: "Press once to stop",
    gesture: "Double tap it for hands-free, press once to stop.",
  },
  ar: {
    holdHotkey: "اضغط باستمرار على {{hotkey}} أثناء التحدث.",
    doublePress: "اضغط مرتين",
    handsFreeDetail: "اضغط مرة واحدة للإيقاف",
    gesture: "اضغط عليه مرتين لبدء الوضع بدون استخدام اليدين، واضغط مرة واحدة للإيقاف.",
  },
  de: {
    holdHotkey: "Halten Sie {{hotkey}} gedrückt, während Sie sprechen.",
    doublePress: "Zweimal tippen",
    handsFreeDetail: "Zum Beenden einmal drücken",
    gesture: "Für den Freihandmodus zweimal tippen, zum Beenden einmal drücken.",
  },
  es: {
    holdHotkey: "Mantén pulsado {{hotkey}} mientras hablas.",
    doublePress: "Pulsa dos veces",
    handsFreeDetail: "Pulsa una vez para detener",
    gesture: "Pulsa dos veces para usar el modo manos libres y una vez para detener.",
  },
  fr: {
    holdHotkey: "Maintenez {{hotkey}} pendant que vous parlez.",
    doublePress: "Appuyer deux fois",
    handsFreeDetail: "Appuyer une fois pour arrêter",
    gesture: "Appuyez deux fois pour le mode mains libres, puis une fois pour arrêter.",
  },
  it: {
    holdHotkey: "Tieni premuto {{hotkey}} mentre parli.",
    doublePress: "Premi due volte",
    handsFreeDetail: "Premi una volta per fermare",
    gesture: "Premi due volte per la modalità a mani libere e una volta per fermare.",
  },
  ja: {
    holdHotkey: "話している間は {{hotkey}} を押し続けます。",
    doublePress: "2回押す",
    handsFreeDetail: "1回押すと停止",
    gesture: "2回押すとハンズフリーで開始し、1回押すと停止します。",
  },
  pt: {
    holdHotkey: "Mantenha {{hotkey}} pressionado enquanto fala.",
    doublePress: "Toque duas vezes",
    handsFreeDetail: "Pressione uma vez para parar",
    gesture: "Toque duas vezes para usar o modo mãos-livres e pressione uma vez para parar.",
  },
  ru: {
    holdHotkey: "Удерживайте {{hotkey}}, пока говорите.",
    doublePress: "Нажмите дважды",
    handsFreeDetail: "Нажмите один раз, чтобы остановить",
    gesture: "Нажмите дважды для режима без рук и один раз, чтобы остановить.",
  },
  "zh-CN": {
    holdHotkey: "说话时按住 {{hotkey}}。",
    doublePress: "连按两次",
    handsFreeDetail: "按一次即可停止",
    gesture: "连按两次可免提启动，按一次即可停止。",
  },
  "zh-TW": {
    holdHotkey: "說話時按住 {{hotkey}}。",
    doublePress: "連按兩次",
    handsFreeDetail: "按一次即可停止",
    gesture: "連按兩次可免持啟動，按一次即可停止。",
  },
};

test("all eleven locales teach Hold and the same double-tap hands-free gesture", () => {
  for (const [locale, expected] of Object.entries(EXPECTED)) {
    const translation = require(`../../src/locales/${locale}/translation.json`);
    assert.deepEqual(
      {
        holdHotkey: translation.onboarding.activation.holdHotkey,
        doublePress: translation.settingsPage.general.hotkey.gestures.doublePress,
        handsFreeDetail: translation.settingsPage.general.hotkey.gestures.handsFreeDetail,
        gesture: translation.app.holdMigrationCard.gesture,
      },
      expected,
      locale
    );
  }
});
