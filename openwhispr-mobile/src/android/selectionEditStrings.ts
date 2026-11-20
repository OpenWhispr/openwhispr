// Edit selection's failure messages, kept out of src/locales: those files are loaded by the iOS
// app, and an Android change must not touch a file iOS loads (scripts/check-android-ui-isolation.mjs).
// strings.ts adds them to the 'android' namespace.
export const SELECTION_EDIT_STRINGS: Record<
  string,
  { editQuestion: string; editNotApplied: string }
> = {
  en: {
    editQuestion: "That's a question, not an edit. Ask it with Assistant.",
    editNotApplied: 'Nothing changed. Say how to change it, like “make it shorter”.',
  },
  es: {
    editQuestion: 'Es una pregunta, no una edición. Hazla con Asistente.',
    editNotApplied: 'No ha cambiado nada. Di cómo cambiarlo, por ejemplo «hazlo más corto».',
  },
  fr: {
    editQuestion: "C'est une question, pas une modification. Posez-la avec Assistant.",
    editNotApplied: "Rien n'a changé. Dites comment le modifier, par exemple « raccourcis-le ».",
  },
  de: {
    editQuestion: 'Das ist eine Frage, keine Änderung. Stelle sie mit Assistent.',
    editNotApplied: 'Nichts geändert. Sag, wie es sich ändern soll, etwa „mach es kürzer“.',
  },
  pt: {
    editQuestion: 'Isso é uma pergunta, não uma edição. Pergunte com o Assistente.',
    editNotApplied: 'Nada mudou. Diga como alterar, por exemplo “deixe mais curto”.',
  },
  it: {
    editQuestion: 'È una domanda, non una modifica. Falla con Assistente.',
    editNotApplied: "Non è cambiato nulla. Di' come cambiarlo, ad esempio «rendilo più breve».",
  },
  ru: {
    editQuestion: 'Это вопрос, а не правка. Задайте его через Ассистента.',
    editNotApplied: 'Ничего не изменилось. Скажите, как изменить, например «сделай короче».',
  },
  'zh-CN': {
    editQuestion: '这是一个问题，不是修改。请用助手提问。',
    editNotApplied: '没有任何更改。请说明如何修改，例如“改短一点”。',
  },
  'zh-TW': {
    editQuestion: '這是一個問題，不是修改。請用助理提問。',
    editNotApplied: '沒有任何變更。請說明如何修改，例如「改短一點」。',
  },
  ja: {
    editQuestion: 'それは質問で、編集ではありません。アシスタントで質問してください。',
    editNotApplied: '何も変更されませんでした。「短くして」のように変更内容を伝えてください。',
  },
  ar: {
    editQuestion: 'هذا سؤال وليس تعديلًا. اطرحه عبر المساعد.',
    editNotApplied: 'لم يتغيّر شيء. قل كيف تريد تغييره، مثل «اجعله أقصر».',
  },
};
