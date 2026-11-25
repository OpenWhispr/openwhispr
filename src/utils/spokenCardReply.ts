// Words as Intl.Segmenter splits a lowercased reply, one string per language.
const words = (byLanguage: Record<string, string>): Set<string> =>
  new Set(Object.values(byLanguage).flatMap((list) => list.split(" ")));

const YES = words({
  en: "yes yeah yep yup sure ok okay send post go ahead confirm confirmed do good approve approved",
  es: "sí si claro vale envía envia envíalo envialo envíala manda mándalo mandalo publica publícalo adelante dale confirma confirmo",
  fr: "oui ouais d'accord envoie l'envoie envoyer envoyez publie poste vas allez confirme",
  de: "ja jawohl klar sende senden schick schicke abschicken posten los bestätige bestätigen",
  pt: "sim envie mande publique pode",
  it: "sì certo invia invialo mandalo pubblica vai conferma procedi",
  ru: "да ага отправь отправляй отправить публикуй давай конечно ок подтверждаю",
  zh: "是 好 好的 对 對 可以 行 发 發 发送 發送 发出 發出 传送 傳送 确认 確認",
  ja: "はい うん ええ いい 送 送信 送る 投稿 お願い",
  ar: "نعم أرسل ارسل أرسله ارسله أرسلها ارسلها موافق حسنا تمام",
});

// Spanish no words, which a bare "no" before them negates ("no cancelar", don't cancel).
const SPANISH_NO = "cancela cancelar para";

// A no on its own.
const NO = words({
  en: "no nope nah cancel stop never mind",
  es: SPANISH_NO,
  fr: "non annule annuler arrête",
  de: "nein abbrechen stopp halt",
  it: "annulla ferma",
  ru: "нет отмена отмени стоп",
  zh: "取消 算了 停",
  ja: "いいえ いや キャンセル やめ やめて 中止",
  ar: "إلغاء الغاء",
});

const NEGATED_BY_NO = words({ es: SPANISH_NO });

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
  ar: "لا",
});

// A no that negates the yes word before it in its clause ("n'envoie pas", 送らない).
const NOT_AFTER = words({ fr: "pas", ja: "ない" });

const FILLER = words({
  en: "it please the message that this and now just then sounds looks",
  es: "por favor lo la el mensaje ya ahora eso",
  fr: "le s'il te plaît plait vous maintenant y ça",
  de: "es bitte die nachricht jetzt ab doch",
  pt: "a o mensagem agora isso",
  it: "per favore il messaggio pure adesso ora",
  ru: "его её это сообщение пожалуйста сейчас",
  zh: "吧 的 了 啊 呀 嗯 请 請 就 去",
  // ICU splits verb endings into pieces: ください → くだ さい, して → し て, 送らない → 送 ら ない.
  ja: "し て って ます ください くだ さい 下さい で ら よ ね を",
  ar: "من فضلك الرسالة",
});

/**
 * Whether a short spoken reply to a waiting card is a clear yes or no: every
 * word is a yes, no, negation or filler word in one of the app's languages
 * (the take's language need not be the UI's), and the reply says only yes
 * ("send it", "yes please") or only no ("no", "don't send it"). A reply that
 * says both ("no, send it"), negates a no ("don't cancel", "no cancelar"), asks a question
 * ("send it?") or says anything else ("send it to Sam") is no answer.
 */
export function spokenCardReply(text: string): "yes" | "no" | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let yes = 0;
  let no = false;
  // A negation waiting for the word after it, and what this clause's last word said.
  let notBefore = false;
  let last: "yes" | "no" | null = null;
  // The clause's last word was a bare "no", which Spanish puts before the verb it negates.
  let afterNo = false;
  const endClause = () => {
    if (notBefore) no = true;
    notBefore = false;
    last = null;
    afterNo = false;
  };
  for (const { segment, isWordLike } of segmenter.segment(
    text.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'")
  )) {
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
    if (FILLER.has(word)) continue;
    const followsNo = afterNo;
    afterNo = word === "no";
    if (YES.has(word)) {
      if (notBefore) no = true;
      else yes += 1;
      last = notBefore ? null : "yes";
      notBefore = false;
    } else if (NOT_BEFORE.has(word)) {
      notBefore = true;
      last = null;
    } else if (NOT_AFTER.has(word)) {
      // A negated no ("annule pas", やめないで) says neither.
      if (last === "no") return null;
      if (last === "yes") yes -= 1;
      no = true;
      last = null;
    } else if (SEND_AFTER_NO.has(word)) {
      if (!followsNo) return null;
      last = null;
    } else if (NO.has(word)) {
      // "Don't cancel" and "no cancelar" say neither.
      if (notBefore || (followsNo && NEGATED_BY_NO.has(word))) return null;
      no = true;
      last = "no";
    } else {
      return null;
    }
  }
  endClause();
  if (yes > 0 && !no) return "yes";
  return no && yes === 0 ? "no" : null;
}
