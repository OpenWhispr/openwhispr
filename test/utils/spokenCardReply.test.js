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
    "نعم، أرسلها",
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
    "Non, n’envoie pas.",
    "Ne l'envoie pas.",
    "Nein, nicht senden.",
    "Não.",
    "Нет, не отправляй.",
    "不要发",
    "算了",
    "いいえ",
    "送らないで",
    "لا",
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
