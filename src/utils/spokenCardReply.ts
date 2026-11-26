// Words as Intl.Segmenter splits a lowercased reply, one string per language.
const words = (byLanguage: Record<string, string>): Set<string> =>
  new Set(Object.values(byLanguage).flatMap((list) => list.split(" ")));

const YES = words({
  en: "yes yeah yep yup sure ok okay send post go ahead confirm confirmed do good approve approved",
  // Not "si": unaccented it is "if" ("si envía el mensaje"), and speech to text writes the yes "sí".
  es: "sí claro vale envía envia envíalo envialo envíala manda mándalo mandalo publica publícalo adelante dale confirma confirmo",
  fr: "oui ouais d'accord envoie l'envoie envoyer envoyez publie poste vas allez confirme",
  de: "ja jawohl klar sende senden schick schicke abschicken posten los bestätige bestätigen",
  pt: "sim envie mande publique pode",
  it: "sì certo invia invialo mandalo pubblica vai conferma procedi",
  // Not "ага": a backchannel, and sarcastic in "ага, сейчас" (no way).
  ru: "да отправь отправляй отправить публикуй давай конечно ок подтверждаю",
  zh: "是 好 好的 对 對 可以 行 发 發 发送 發送 发出 發出 传送 傳送 确认 確認",
  // Not いい: "いいって" and "いいよいいよ" turn something down.
  ja: "はい うん ええ 送 送信 送る 投稿 お願い",
  ar: "نعم أرسل ارسل أرسله ارسله أرسلها ارسلها موافق حسنا تمام",
});

// No words that a bare no right before them negates: Spanish "no cancelar"
// and Italian "non annulla" mean don't cancel.
const SPANISH_NO = "cancela cancelar para";
const ITALIAN_NO = "annulla ferma";

// A no on its own.
const NO = words({
  en: "no nope nah cancel stop never mind",
  es: SPANISH_NO,
  fr: "non annule annuler arrête",
  de: "nein abbrechen stopp halt",
  it: ITALIAN_NO,
  ru: "нет отмена отмени стоп",
  zh: "取消 算了 停",
  ja: "いいえ いや キャンセル やめ やめて 中止",
  // لا is a bare no, as Spanish "no" is: "لا أرسلها" is "no, send it".
  ar: "لا إلغاء الغاء",
});

const NEGATED_BY: Readonly<Record<string, Set<string>>> = {
  no: words({ es: SPANISH_NO }),
  non: words({ it: ITALIAN_NO }),
};

// A send word that says no only right after a no ("no envíes", don't send).
const SEND_AFTER_NO = words({ es: "envíes envies mandes" });

// A no that negates the yes word after it in its clause ("don't send"); on its own, a no.
const NOT_BEFORE = words({
  en: "not don't dont",
  fr: "ne",
  de: "nicht",
  pt: "não nao",
  ru: "не",
  zh: "不 不要 不用 别 別",
});

// A no that negates the yes word before it in its clause ("n'envoie pas", 送らない).
const NOT_AFTER = words({ fr: "pas", ja: "ない" });

// Yes words that only acknowledge: negated ("not sure", "nicht klar"), they say neither.
const ACKNOWLEDGES = words({ en: "sure good", de: "klar" });

// Chinese yes words that 吧 after them turns into a question with no "？" ("对吧", right?).
const ASKED_WITH_BA = words({ zh: "是 对 對 可以" });

// Words for when, skipped like filler; with a bare no they put the card off
// ("not now", "ahora no"), which answers nothing. "Don't send it now" stays a no.
const WHEN = words({
  en: "now",
  es: "ahora",
  fr: "maintenant",
  de: "jetzt",
  pt: "agora",
  it: "adesso ora",
  ru: "сейчас",
});

const FILLER = words({
  en: "it please the message that this and just then sounds looks",
  es: "por favor lo la el mensaje ya eso",
  fr: "le y ça",
  de: "es bitte die nachricht ab doch",
  pt: "a o mensagem isso",
  it: "per favore il messaggio pure",
  ru: "его её это сообщение пожалуйста",
  zh: "吧 的 了 啊 呀 嗯 请 請 就 去",
  // ICU splits verb endings into pieces: ください → くだ さい, して → し て, 送らない → 送 ら ない.
  ja: "し て って ます ください くだ さい 下さい で ら よ ね を いい",
  ar: "الرسالة",
});

// Please, taken out whole before the words are read: on their own, "vous"
// and "s'il" start a statement ("vous envoyez le message") and "من" asks who.
const PLEASE = /s'il (?:te|vous) pla[iî]t|من فضلك/g;

/**
 * Whether a short spoken reply to a waiting card is a clear yes or no: every
 * word is a yes, no, negation or filler word in one of the app's languages
 * (the take's language need not be the UI's), and the reply says only yes
 * ("send it", "yes please") or only no ("no", "don't send it"). A reply that
 * says both ("no, send it"), negates a no ("don't cancel", "no cancelar"), asks
 * a question ("send it?", "对吧"), puts it off ("not now"), hedges ("not sure")
 * or says anything else ("send it to Sam") is no answer.
 */
export function spokenCardReply(text: string): "yes" | "no" | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let yes = 0;
  let no = false;
  // A no that negates a send word, which a word for when never softens.
  let refusesSend = false;
  let when = false;
  // A negation waiting for the word after it, and what this clause's last word said.
  let notBefore = false;
  let last: "yes" | "no" | null = null;
  // The clause's last word that isn't filler.
  let previous: string | null = null;
  const endClause = () => {
    if (notBefore) no = true;
    notBefore = false;
    last = null;
    previous = null;
  };
  const reply = text.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(PLEASE, " ");
  for (const { segment, isWordLike } of segmenter.segment(reply)) {
    if (!isWordLike) {
      // NFKC already folds a full-width "？" to "?".
      if (/[?¿؟]/.test(segment)) return null;
      if (/\p{P}/u.test(segment)) endClause();
      continue;
    }
    // French elides "ne" ("n'envoie", "n'annule"): a negation before the rest of the word.
    const elided = segment.startsWith("n'") && segment.length > 2;
    const word = elided ? segment.slice(2) : segment;
    if (elided) notBefore = true;
    if (WHEN.has(word)) {
      when = true;
      continue;
    }
    if (FILLER.has(word)) {
      // 了 after a yes word is "enough" or "by the way" ("行了", "对了"), and
      // 吧 after 是 or 对 asks ("对吧"): neither confirms.
      if (word === "了" && last === "yes") return null;
      if (word === "吧" && previous !== null && ASKED_WITH_BA.has(previous)) return null;
      continue;
    }
    const before = previous;
    previous = word;
    if (YES.has(word)) {
      if (notBefore && ACKNOWLEDGES.has(word)) return null;
      if (notBefore) no = refusesSend = true;
      else yes += 1;
      last = notBefore ? null : "yes";
      notBefore = false;
    } else if (NOT_BEFORE.has(word)) {
      notBefore = true;
      last = null;
    } else if (NOT_AFTER.has(word)) {
      // A negated no ("annule pas", やめないで) says neither.
      if (last === "no") return null;
      if (last === "yes") {
        yes -= 1;
        refusesSend = true;
      }
      no = true;
      last = null;
    } else if (SEND_AFTER_NO.has(word)) {
      if (before !== "no") return null;
      refusesSend = true;
      last = null;
    } else if (NO.has(word)) {
      // "Don't cancel", "no cancelar" and "non annulla" say neither, and
      // "mind" is a no only in "never mind".
      if (notBefore || (before !== null && NEGATED_BY[before]?.has(word))) return null;
      if (word === "mind" && before !== "never") return null;
      no = true;
      last = "no";
    } else {
      return null;
    }
  }
  endClause();
  if (when && no && !refusesSend) return null;
  if (yes > 0 && !no) return "yes";
  return no && yes === 0 ? "no" : null;
}
