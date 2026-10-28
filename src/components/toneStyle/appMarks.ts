import type { ToneAppCategory } from "../../config/toneStyle";
import appleMail from "../../assets/icons/apps/apple-mail.svg";
import chatgpt from "../../assets/icons/apps/chatgpt.svg";
import claude from "../../assets/icons/apps/claude.svg";
import gmail from "../../assets/icons/apps/gmail.svg";
import googleChat from "../../assets/icons/apps/google-chat.svg";
import instagram from "../../assets/icons/apps/instagram.svg";
import linear from "../../assets/icons/apps/linear.svg";
import linkedin from "../../assets/icons/apps/linkedin.svg";
import messages from "../../assets/icons/apps/messages.svg";
import notion from "../../assets/icons/apps/notion.svg";
import outlook from "../../assets/icons/apps/outlook.svg";
import slack from "../../assets/icons/apps/slack.svg";
import superhuman from "../../assets/icons/apps/superhuman.svg";
import teams from "../../assets/icons/apps/teams.svg";
import telegram from "../../assets/icons/apps/telegram.svg";
import whatsapp from "../../assets/icons/apps/whatsapp.svg";

// The apps that stand for each kind of writing: four in the setup dialog,
// three in Settings, as in the design.
export const CATEGORY_APP_MARKS: Record<ToneAppCategory, { dialog: string[]; settings: string[] }> =
  {
    personal: {
      dialog: [whatsapp, instagram, messages, telegram],
      settings: [whatsapp, instagram, messages],
    },
    work: { dialog: [slack, teams, googleChat, linkedin], settings: [slack, googleChat, linkedin] },
    email: {
      dialog: [superhuman, appleMail, outlook, gmail],
      settings: [superhuman, appleMail, gmail],
    },
    other: { dialog: [linear, chatgpt, claude, notion], settings: [linear, chatgpt, notion] },
  };
