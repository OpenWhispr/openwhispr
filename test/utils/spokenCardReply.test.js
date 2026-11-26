const test = require("node:test");
const assert = require("node:assert/strict");

let spokenCardReply;

test.before(async () => {
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const root = process.env.OPENWHISPR_TEST_SOURCE || path.resolve(__dirname, "../..");
  ({ spokenCardReply } = await import(
    pathToFileURL(path.join(root, "src/utils/spokenCardReply.ts"))
  ));
});

const cases = (expected, replies) => {
  for (const reply of replies) assert.equal(spokenCardReply(reply), expected, reply);
};

test("a short spoken yes in any of the app's languages confirms", () => {
  cases("yes", [
    "Send it.",
    "Yes, send it!",
    "Yeah, go ahead and post it.",
    "OK, send the message now.",
    "Sounds good.",
    "Sí, envíalo, por favor.",
    "Oui, envoie-le, s’il te plaît.",
    "Ja, schick es ab.",
    "Sim, envia.",
    "Sì, invialo.",
    "Да, отправь.",
    "好的，发出去吧。",
    "對，發送",
    "はい、送信してください。",
    "送ってください",
    "うん、送って",
    "はい、いいよ",
    "发吧",
    "Да, сейчас.",
    "نعم، أرسلها",
    "أرسلها من فضلك",
    "Send it now.",
  ]);
});

test("a spoken no cancels, a negated yes included", () => {
  cases("no", [
    "No.",
    "Cancel.",
    "Don’t send it.",
    "No, don't post that.",
    "Never mind.",
    "No lo envíes... no.",
    "No envíes.",
    "No, cancela.",
    "No cancel it.",
    "No please cancel it.",
    "No annulla.",
    "Non, n’envoie pas.",
    "Ne l'envoie pas.",
    "Nein, nicht senden.",
    "Não.",
    "Нет, не отправляй.",
    "不要发",
    "算了",
    "いいえ",
    "送らないで",
    "いや、いい",
    "不用了",
    "لا",
    "Don't send it now.",
    "Nicht jetzt senden.",
  ]);
});

test("anything that isn't only a yes or a no answers nothing", () => {
  cases(null, [
    "",
    "Please.",
    "Send it to Sam instead.",
    "Yes but make it shorter.",
    "Change the second line to say Friday.",
    "Wait.",
    // Both a yes and a no, or a negated no: the card keeps waiting rather than being
    // cancelled or sent.
    "No, send it.",
    "No send it",
    "Non envoie-le",
    "Don't cancel it.",
    "No cancelar.",
    "No cancela.",
    "No lo cancela.",
    "Envíes.",
    "不要取消",
    "Nicht abbrechen.",
    "N'annule pas.",
    "Annule pas.",
    "やめないでください",
    "Never mind, send it.",
    "Don't stop, send it.",
    "OK, don't send it.",
    "Is it ready?",
    // A question is no answer, even one made of yes words.
    "Send it?",
    "OK?",
    "¿Sí?",
    "أرسلها؟",
    "Отправить?",
    "好吗",
  ]);
});

test("a reply that turns it down, asks, puts it off or hedges in yes words sends nothing", () => {
  cases(null, [
    // Turned down, or sarcastic: "never mind", "yeah, right".
    "いいって",
    "いいよいいよ",
    "Ага, сейчас!",
    "行了行了",
    // Questions whose mark speech to text left off: "right?", "who sent it?",
    // "you're sending the message", "if he sends the message".
    "对吧",
    "是吧",
    "可以吧",
    "对了",
    "من أرسلها",
    "Vous envoyez le message",
    "S'il envoie le message",
    "Si envía el mensaje.",
    "Si lo manda",
  ]);
  cases(null, [
    // Put off, not cancelled: the card keeps waiting.
    "Not now.",
    "No, not now.",
    "Ahora no.",
    "Pas maintenant.",
    "Nicht jetzt.",
    "Agora não.",
    "Non ora.",
    "Не сейчас.",
    // Hedged, or "don't cancel".
    "Not sure.",
    "Not good.",
    "Nicht klar.",
    "Non annulla.",
    "Non ferma.",
    "Mind.",
    // "No, send it", with the comma left off.
    "لا أرسلها",
  ]);
});
