import type { DictationTone, ToneKind } from './toneStyle';

/**
 * Tone & Style's examples in each app language: the same spoken lines as the English ones in
 * `examples.ts`, said and cleaned up the way that language writes them. `~words~` were dropped,
 * `+words+` added or changed. A language without capitals shows its tones through punctuation
 * and wording instead.
 */
export interface ExampleSet {
  /** The friend's message the personal example answers. */
  question: string;
  /** The email preview's "To" label. */
  to: string;
  /** The heading of the notes the "everything else" example lands in. */
  notes: string;
  intro: Record<'formal' | 'casual' | 'very_casual', string>;
  examples: Record<ToneKind, Partial<Record<DictationTone, string>>>;
}

export const EXAMPLE_TRANSLATIONS: Record<string, ExampleSet> = {
  es: {
    question: '¿Qué haces luego?',
    to: 'Para',
    notes: 'Notas de la llamada',
    intro: {
      formal: '~eh~ +Hola, ¿+estás libre esta noche+?+',
      casual: '~eh~ +Hola,+ ~estás~ +¿+libre esta noche+?+',
      very_casual: '~eh~ hola ~estás~ libre esta noche+?+',
    },
    examples: {
      personal: {
        formal:
          '~eh~ +Hola, ¿+estás libre esta noche+?+ +Estaba+ pensando que podríamos ~tipo~ tomar un café sobre las ~seis~ +18:00.+ +Avísame.+',
        casual:
          '~eh~ +Hola, ¿+estás libre esta noche+?+ ~estaba pensando que podríamos tipo tomar un~ +¿Un+ café sobre las ~seis~ +6?+ avísame',
        very_casual:
          '~eh~ hola ~estás~ libre esta noche+?+ ~estaba pensando que podríamos tipo tomar un~ café ~sobre las seis~ +a las 6+ ~avísame~ +avisa+',
      },
      work: {
        formal:
          '~eh~ +Hola, ¿+me puedes mandar la presentación antes de la llamada+?+ +Los+ números de la diapositiva ~tres~ +3+ parecen desactualizados+.+ +Sin+ prisa+.+',
        casual:
          '~eh~ +Hola, ¿+me ~puedes mandar~ +mandas+ la presentación antes de la llamada+?+ ~los números de la diapositiva tres parecen desactualizados~ +Creo que la diapo 3 está desactualizada,+ sin prisa',
        excited:
          '~eh~ +¡Hola! ¿Me+ puedes mandar la presentación antes de la llamada+?+ +Los+ números de la diapositiva ~tres~ +3+ parecen desactualizados+.+ +¡Sin+ prisa+!+',
      },
      email: {
        formal:
          '+Hola, Sarah:+\n\n+Gracias+ por ~tu~ +su+ tiempo hoy+.+ ~eh te enviaré~ +Le enviaré+ la propuesta actualizada antes del +jueves.+ ~avísame~ +Por favor, avíseme+ si ~necesitas~ +necesita+ algo antes+.+\n\n+Saludos cordiales+',
        casual:
          '+Hola, Sarah:+\n\n+Gracias+ por tu tiempo hoy+.+ ~eh te enviaré~ +Te envío+ la propuesta actualizada antes del +jueves,+ avísame si necesitas algo antes+.+\n\n+Gracias+',
        excited:
          '+Hola, Sarah:+\n\n~gracias~ +¡Muchas gracias+ por tu tiempo hoy+!+ ~eh te enviaré~ +Te envío+ la propuesta actualizada antes del +jueves.+ +¡Avísame+ si necesitas algo antes+!+\n\n+Gracias+',
      },
      other: {
        formal:
          '+Notas+ de la llamada+:+ ~eh~ +Les+ gustó la página de precios y quieren un onboarding más corto+.+ +Hacer+ seguimiento la próxima semana+.+',
        casual:
          '~notas de la llamada~ +Notas:+ ~eh~ +Les+ gustó la página de precios+,+ ~y quieren un onboarding más corto~ +onboarding más corto.+ ~hacer seguimiento~ +Seguimiento+ la próxima semana',
        excited:
          '~notas de la llamada~ +Notas:+ ~eh~ +¡Les+ ~gustó~ +encantó+ la página de precios+!+ ~y quieren un onboarding más corto~ +Quieren un onboarding más corto.+ +¡Hacer+ seguimiento la próxima semana+!+',
      },
    },
  },
  fr: {
    question: 'Tu fais quoi plus tard ?',
    to: 'À',
    notes: 'Notes d’appel',
    intro: {
      formal: '~euh~ +Salut,+ tu es libre ce soir +?+',
      casual: '~euh~ +Salut,+ ~tu es~ +t’es+ libre ce soir +?+',
      very_casual: '~euh~ salut ~tu es libre~ +dispo+ ce soir+ ?+',
    },
    examples: {
      personal: {
        formal:
          '~euh~ +Salut,+ t’es libre ce soir +?+ +Je+ pensais qu’on pourrait ~genre~ prendre un café vers ~six heures~ +18 h.+ +Dis-moi.+',
        casual:
          '~euh~ +Salut,+ t’es libre ce soir +?+ ~je pensais qu’on pourrait genre prendre un~ +Un+ café vers ~six heures~ +18 h,+ dis-moi',
        very_casual:
          '~euh~ salut ~t’es libre~ +dispo+ ce soir+ ?+ ~je pensais qu’on pourrait genre prendre un~ café vers ~six heures~ +18h+ dis-moi',
      },
      work: {
        formal:
          '~euh~ +Bonjour,+ tu pourrais m’envoyer le deck avant l’appel +?+ +Les+ chiffres de la diapo ~trois~ +3+ ont l’air dépassés+.+ +Rien+ ne presse+.+',
        casual:
          '~euh~ +Salut,+ tu ~pourrais~ +peux+ m’envoyer le deck avant l’appel +?+ ~les chiffres de la diapo trois ont l’air dépassés~ +La diapo 3 n’est pas à jour je crois,+ rien ne presse',
        excited:
          '~euh~ +Salut !+ +Tu+ pourrais m’envoyer le deck avant l’appel +?+ +Les+ chiffres de la diapo ~trois~ +3+ ont l’air dépassés+.+ +Rien+ ne presse +!+',
      },
      email: {
        formal:
          '+Bonjour Sarah,+\n\n+Merci+ pour votre temps aujourd’hui+.+ ~euh~ +Je+ vous enverrai la proposition mise à jour d’ici +jeudi.+ ~dites-moi~ +N’hésitez pas à me dire+ si vous avez besoin de quoi que ce soit d’ici là+.+\n\n+Bien cordialement+',
        casual:
          '+Bonjour Sarah,+\n\n+Merci+ pour votre temps aujourd’hui+.+ ~euh je vous enverrai~ +Je vous envoie+ la proposition mise à jour d’ici +jeudi,+ dites-moi si vous avez besoin de quoi que ce soit d’ici là+.+\n\n+Merci+',
        excited:
          '+Bonjour Sarah,+\n\n~merci~ +Merci beaucoup+ pour votre temps aujourd’hui +!+ ~euh je vous enverrai~ +Je vous envoie+ la proposition mise à jour d’ici +jeudi.+ +Dites-moi+ si vous avez besoin de quoi que ce soit d’ici là +!+\n\n+Merci+',
      },
      other: {
        formal:
          '+Notes+ de l’appel +:+ ~euh~ +Ils+ ont aimé la page tarifs et voudraient un onboarding plus court+.+ +Les+ relancer la semaine prochaine+.+',
        casual:
          '~notes de l’appel~ +Notes d’appel :+ ~euh~ ils ont aimé la page tarifs+,+ ~et voudraient un onboarding plus court~ +veulent un onboarding plus court.+ +Relancer+ ~les relancer~ la semaine prochaine',
        excited:
          '~notes de l’appel~ +Notes d’appel :+ ~euh~ +Ils+ ont ~aimé~ +adoré+ la page tarifs +!+ ~et voudraient un onboarding plus court~ +Ils veulent un onboarding plus court.+ +Les+ relancer la semaine prochaine +!+',
      },
    },
  },
  de: {
    question: 'Was machst du später?',
    to: 'An',
    notes: 'Gesprächsnotizen',
    intro: {
      formal: '~äh~ +Hey,+ hast du heute Abend Zeit+?+',
      casual: '~äh~ +Hey,+ ~hast du~ heute Abend Zeit+?+',
      very_casual: '~äh~ hey ~hast du~ heute abend zeit+?+',
    },
    examples: {
      personal: {
        formal:
          '~äh~ +Hey,+ hast du heute Abend Zeit+?+ +Ich+ dachte, wir könnten ~so~ einen Kaffee trinken+,+ gegen ~sechs~ +18 Uhr.+ +Sag+ Bescheid+.+',
        casual:
          '~äh~ +Hey,+ hast du heute Abend Zeit+?+ ~ich dachte wir könnten so~ +Lust auf+ einen Kaffee ~trinken~ gegen ~sechs~ +6?+ +Sag+ Bescheid',
        very_casual:
          '~äh~ hey ~hast du~ heute abend zeit+?+ ~ich dachte wir könnten so einen~ kaffee ~trinken gegen sechs~ +so um 6?+ sag bescheid',
      },
      work: {
        formal:
          '~äh~ +Hallo,+ kannst du mir das Deck vor dem Call schicken+?+ +Die+ Zahlen auf Folie ~drei~ +3+ sehen veraltet aus+.+ +Keine+ Eile+.+',
        casual:
          '~äh~ +Hey,+ kannst du mir das Deck vor dem Call schicken+?+ ~die zahlen auf folie drei sehen veraltet aus~ +Folie 3 ist wohl nicht aktuell,+ keine Eile+.+',
        excited:
          '~äh~ +Hey!+ +Kannst+ du mir das Deck vor dem Call schicken+?+ +Die+ Zahlen auf Folie ~drei~ +3+ sehen veraltet aus+.+ +Keine+ Eile+!+',
      },
      email: {
        formal:
          '+Hallo Sarah,+\n\n~danke~ +vielen Dank+ für Ihre Zeit heute+.+ ~äh~ +Ich+ schicke Ihnen das aktualisierte Angebot bis +Donnerstag.+ ~sagen sie bescheid~ +Bitte geben Sie mir Bescheid,+ wenn Sie vorher etwas brauchen+.+\n\n+Mit freundlichen Grüßen+',
        casual:
          '+Hallo Sarah,+\n\ndanke für Ihre Zeit heute+.+ ~äh~ +Ich+ schicke Ihnen das aktualisierte Angebot bis +Donnerstag,+ sagen Sie Bescheid+,+ wenn Sie vorher etwas brauchen+.+\n\n+Danke+',
        excited:
          '+Hallo Sarah,+\n\n~danke~ +vielen Dank+ für Ihre Zeit heute+!+ ~äh~ +Ich+ schicke Ihnen das aktualisierte Angebot bis +Donnerstag.+ +Sagen+ Sie Bescheid+,+ wenn Sie vorher etwas brauchen+!+\n\n+Danke+',
      },
      other: {
        formal:
          '+Notizen+ vom Call+:+ ~äh~ +Die+ Preisseite kam gut an und sie wollen ein kürzeres Onboarding+.+ +Nächste+ Woche nachfassen+.+',
        casual:
          '~notizen vom call~ +Call-Notizen:+ ~äh die~ Preisseite kam gut an+,+ ~und sie wollen ein kürzeres onboarding~ +Onboarding kürzer.+ +Nächste+ Woche nachfassen',
        excited:
          '~notizen vom call~ +Call-Notizen:+ ~äh~ +Die+ Preisseite kam ~gut~ +super+ an+!+ ~und sie wollen ein kürzeres onboarding~ +Sie wollen ein kürzeres Onboarding.+ +Nächste+ Woche nachfassen+!+',
      },
    },
  },
  pt: {
    question: 'O que vai fazer mais tarde?',
    to: 'Para',
    notes: 'Notas da call',
    intro: {
      formal: '~hum~ +Oi,+ você ~tá~ +está+ livre hoje à noite+?+',
      casual: '~hum~ +Oi,+ ~você~ tá livre hoje à noite+?+',
      very_casual: '~hum~ oi ~você~ tá livre ~hoje~ +hj+ à noite+?+',
    },
    examples: {
      personal: {
        formal:
          '~hum~ +Oi,+ você ~tá~ +está+ livre hoje à noite+?+ +Eu+ ~tava~ +estava+ pensando ~da gente tipo~ +em+ tomar um café lá pelas ~seis~ +18h.+ +Me+ avisa+.+',
        casual:
          '~hum~ +Oi,+ ~você~ tá livre hoje à noite+?+ ~eu tava pensando da gente tipo tomar um~ +Bora um+ café lá pelas ~seis~ +6?+ me avisa',
        very_casual:
          '~hum~ oi ~você tá~ livre ~hoje~ +hj+ à noite+?+ ~eu tava pensando da gente tipo tomar um~ +bora um+ café ~lá pelas seis~ +6h+ me avisa',
      },
      work: {
        formal:
          '~hum~ +Oi,+ você pode me mandar o deck antes da call+?+ +Os+ números do slide ~três~ +3+ parecem desatualizados+.+ +Sem+ pressa+.+',
        casual:
          '~hum~ +Oi,+ ~você~ pode me mandar o deck antes da call+?+ ~os números do slide três parecem desatualizados~ +Acho que o slide 3 tá desatualizado,+ sem pressa',
        excited:
          '~hum~ +Oi!+ +Você+ pode me mandar o deck antes da call+?+ +Os+ números do slide ~três~ +3+ parecem desatualizados+.+ +Sem+ pressa+!+',
      },
      email: {
        formal:
          '+Olá, Sarah,+\n\n+Obrigado+ pelo seu tempo hoje+.+ ~hum~ +Vou+ enviar a proposta atualizada até +quinta-feira.+ ~me~ +Por favor, me+ avise se precisar de algo antes disso+.+\n\n+Atenciosamente+',
        casual:
          '+Oi, Sarah,+\n\n+Obrigado+ pelo seu tempo hoje+.+ ~hum vou enviar~ +Envio+ a proposta atualizada até +quinta,+ me avise se precisar de algo antes disso+.+\n\n+Obrigado+',
        excited:
          '+Oi, Sarah,+\n\n~obrigado~ +Muito obrigado+ pelo seu tempo hoje+!+ ~hum vou enviar~ +Envio+ a proposta atualizada até +quinta.+ +Me+ avise se precisar de algo antes disso+!+\n\n+Obrigado+',
      },
      other: {
        formal:
          '+Notas+ da call+:+ ~hum~ +Eles+ gostaram da página de preços e querem um onboarding mais curto+.+ +Fazer+ follow-up semana que vem+.+',
        casual:
          '+Notas+ da call+:+ ~hum eles~ +Gostaram+ da página de preços+,+ ~e querem um onboarding mais curto~ +querem onboarding mais curto.+ +Fazer+ follow-up semana que vem',
        excited:
          '+Notas+ da call+:+ ~hum~ +Eles+ ~gostaram da~ +amaram a+ página de preços+!+ ~e querem um onboarding mais curto~ +Querem um onboarding mais curto.+ +Fazer+ follow-up semana que vem+!+',
      },
    },
  },
  it: {
    question: 'Che fai dopo?',
    to: 'A',
    notes: 'Note della chiamata',
    intro: {
      formal: '~ehm~ +Ciao,+ sei libero stasera+?+',
      casual: '~ehm~ +Ciao,+ ~sei~ libero stasera+?+',
      very_casual: '~ehm~ ciao ~sei~ libero stasera+?+ +dimmi+',
    },
    examples: {
      personal: {
        formal:
          '~ehm~ +Ciao,+ sei libero stasera+?+ +Pensavo+ che potremmo ~tipo~ prendere un caffè verso le ~sei~ +18.+ +Fammi+ sapere+.+',
        casual:
          '~ehm~ +Ciao,+ sei libero stasera+?+ ~pensavo che potremmo tipo prendere un~ +Un+ caffè verso le ~sei~ +6?+ fammi sapere',
        very_casual:
          '~ehm~ ciao ~sei~ libero stasera+?+ ~pensavo che potremmo tipo prendere un~ caffè ~verso le sei~ +alle 6+ ~fammi sapere~ +dimmi+',
      },
      work: {
        formal:
          '~ehm~ +Ciao,+ mi mandi la presentazione prima della call+?+ +I+ numeri della slide ~tre~ +3+ sembrano vecchi+.+ +Nessuna+ fretta+.+',
        casual:
          '~ehm~ +Ciao,+ mi mandi la presentazione prima della call+?+ ~i numeri della slide tre sembrano vecchi~ +Slide 3 forse non aggiornata,+ nessuna fretta',
        excited:
          '~ehm~ +Ciao!+ +Mi+ mandi la presentazione prima della call+?+ +I+ numeri della slide ~tre~ +3+ sembrano vecchi+.+ +Nessuna+ fretta+!+',
      },
      email: {
        formal:
          '+Gentile Sarah,+\n\n~grazie~ +La ringrazio+ per il tempo dedicato oggi+.+ ~ehm~ +Invierò+ la proposta aggiornata entro +giovedì.+ ~fammi~ +Mi faccia+ sapere se ~ti serve~ +Le serve+ qualcosa prima+.+\n\n+Cordiali saluti+',
        casual:
          '+Ciao Sarah,+\n\n+Grazie+ per il tempo dedicato oggi+.+ ~ehm invierò~ +Ti mando+ la proposta aggiornata entro +giovedì,+ fammi sapere se ti serve qualcosa prima+.+\n\n+Grazie+',
        excited:
          '+Ciao Sarah,+\n\n~grazie~ +Grazie mille+ per il tempo dedicato oggi+!+ ~ehm invierò~ +Ti mando+ la proposta aggiornata entro +giovedì.+ +Fammi+ sapere se ti serve qualcosa prima+!+\n\n+Grazie+',
      },
      other: {
        formal:
          '+Note+ della chiamata+:+ ~ehm~ +Gli+ è piaciuta la pagina prezzi e vorrebbero un onboarding più breve+.+ +Ricontattarli+ la prossima settimana+.+',
        casual:
          '~note della chiamata~ +Note call:+ ~ehm~ +Gli+ è piaciuta la pagina prezzi+,+ ~e vorrebbero un onboarding più breve~ +onboarding più breve.+ +Ricontattarli+ la prossima settimana',
        excited:
          '~note della chiamata~ +Note call:+ ~ehm~ +Gli+ è piaciuta +tantissimo+ la pagina prezzi+!+ ~e vorrebbero un onboarding più breve~ +Vogliono un onboarding più breve.+ +Ricontattarli+ la prossima settimana+!+',
      },
    },
  },
  ru: {
    question: 'Что делаешь вечером?',
    to: 'Кому',
    notes: 'Заметки со звонка',
    intro: {
      formal: '~эм~ +Привет,+ ты свободен сегодня вечером+?+',
      casual: '~эм~ +Привет,+ ~ты~ свободен сегодня вечером+?+',
      very_casual: '~эм привет~ +прив+ ~ты~ свободен ~сегодня~ вечером+?+',
    },
    examples: {
      personal: {
        formal:
          '~эм~ +Привет,+ ты свободен сегодня вечером+?+ +Я+ думал+,+ мы могли бы ~типа~ выпить кофе часов в ~шесть~ +6.+ +Дай+ знать+.+',
        casual:
          '~эм~ +Привет,+ ~ты~ свободен сегодня вечером+?+ ~я думал мы могли бы типа выпить~ +Может,+ кофе часов в ~шесть~ +6?+ дай знать',
        very_casual:
          '~эм привет~ +прив+ ~ты~ свободен ~сегодня~ вечером+?+ ~я думал мы могли бы типа выпить~ кофе ~часов в шесть~ +в 6+ ~дай знать~ +напиши+',
      },
      work: {
        formal:
          '~эм~ +Привет,+ можешь прислать презентацию до созвона+?+ +Цифры+ на ~третьем~ +3-м+ слайде+,+ похоже+,+ устарели+.+ +Не+ срочно+.+',
        casual:
          '~эм~ +Привет,+ можешь прислать презентацию до созвона+?+ ~цифры на третьем слайде похоже устарели~ +На 3-м слайде вроде старые цифры,+ не срочно',
        excited:
          '~эм~ +Привет!+ +Можешь+ прислать презентацию до созвона+?+ +Цифры+ на ~третьем~ +3-м+ слайде+,+ похоже+,+ устарели+.+ +Не+ срочно+!+',
      },
      email: {
        formal:
          '+Здравствуйте, Sarah!+\n\n+Спасибо,+ что уделили время сегодня+.+ ~эм~ +Я+ пришлю обновлённое предложение до +четверга.+ ~дайте~ +Пожалуйста, дайте+ знать+,+ если что-то понадобится раньше+.+\n\n+С уважением+',
        casual:
          '+Здравствуйте, Sarah,+\n\n+Спасибо,+ что уделили время сегодня+.+ ~эм я пришлю~ +Пришлю+ обновлённое предложение до +четверга,+ дайте знать+,+ если что-то понадобится раньше+.+\n\n+Спасибо+',
        excited:
          '+Здравствуйте, Sarah!+\n\n~спасибо~ +Огромное спасибо,+ что уделили время сегодня+!+ ~эм я пришлю~ +Пришлю+ обновлённое предложение до +четверга.+ +Дайте+ знать+,+ если что-то понадобится раньше+!+\n\n+Спасибо+',
      },
      other: {
        formal:
          '+Заметки+ со звонка+:+ ~эм~ +Им+ понравилась страница с ценами+,+ и они хотят онбординг покороче+.+ +Связаться+ с ними на следующей неделе+.+',
        casual:
          '~заметки со звонка~ +По звонку:+ ~эм им~ +Понравилась+ страница с ценами+,+ ~и они хотят онбординг покороче~ +онбординг покороче.+ +Связаться+ ~с ними~ на следующей неделе',
        excited:
          '~заметки со звонка~ +По звонку:+ ~эм~ +Им+ +очень+ понравилась страница с ценами+!+ ~и они хотят онбординг покороче~ +Хотят онбординг покороче.+ +Связаться+ с ними на следующей неделе+!+',
      },
    },
  },
  'zh-CN': {
    question: '晚点干嘛？',
    to: '收件人',
    notes: '通话记录',
    intro: {
      formal: '~嗯~你今晚有空吗+？+',
      casual: '~嗯你~今晚有空吗+？+',
      very_casual: '~嗯你~今晚有空~吗~+不+',
    },
    examples: {
      personal: {
        formal:
          '~嗯~你今晚有空吗+？+我在想+，+我们可以~就是~去喝个咖啡+，+~六点~+6点+左右+。+告诉我一声+。+',
        casual:
          '~嗯你~+嘿，+今晚有空吗+？+~我在想我们可以就是去~喝个咖啡+，+~六点~+6点+左右+？+告诉我一声',
        very_casual:
          '~嗯你~今晚有空~吗~+不+ ~我在想我们可以就是去~喝个咖啡 ~六点左右~+6点+ ~告诉我一声~+回我+',
      },
      work: {
        formal:
          '~嗯~+你好，+你能在开会前把演示文稿发我吗+？+~第三页~+第3页+的数据好像过时了+。+不急+。+',
        casual:
          '~嗯~+嘿，+~你~能在开会前把演示文稿发我吗+？+~第三页的数据好像过时了~+第3页数据可能旧了，+不急',
        excited:
          '~嗯~+嘿！+你能在开会前把演示文稿发我吗+？+~第三页~+第3页+的数据好像过时了+。+不急+！+',
      },
      email: {
        formal:
          '+Sarah，您好：+\n\n感谢~你~+您+今天抽出时间+。+~嗯~我会在周四前发送更新后的方案+。+~之前有什么需要请告诉我~+在此之前如有需要，请随时告诉我。+\n\n+此致+',
        casual:
          '+Sarah，你好：+\n\n~感谢~+谢谢+你今天抽出时间+。+~嗯~我会在周四前~发送~+发+更新后的方案+，+之前有什么需要请告诉我+。+\n\n+谢谢+',
        excited:
          '+Sarah，你好：+\n\n~感谢~+太感谢+你今天抽出时间+了！+~嗯~我会在周四前~发送~+发+更新后的方案+。+之前有什么需要请告诉我+！+\n\n+谢谢+',
      },
      other: {
        formal: '通话记录+：+~嗯~他们喜欢定价页+，+希望引导流程短一点+。+下周跟进+。+',
        casual: '通话记录+：+~嗯他们~喜欢定价页+，+~希望~引导流程~短一点~+要短点。+下周跟进',
        excited: '通话记录+：+~嗯~他们~喜欢~+超喜欢+定价页+！+希望引导流程短一点+。+下周跟进+！+',
      },
    },
  },
  'zh-TW': {
    question: '晚點要幹嘛？',
    to: '收件者',
    notes: '通話紀錄',
    intro: {
      formal: '~嗯~你今晚有空嗎+？+',
      casual: '~嗯你~今晚有空嗎+？+',
      very_casual: '~嗯你~今晚有空~嗎~+不+',
    },
    examples: {
      personal: {
        formal:
          '~嗯~你今晚有空嗎+？+我在想+，+我們可以~就是~去喝杯咖啡+，+~六點~+6點+左右+。+跟我說一聲+。+',
        casual:
          '~嗯你~+嘿，+今晚有空嗎+？+~我在想我們可以就是去~喝杯咖啡+，+~六點~+6點+左右+？+跟我說一聲',
        very_casual:
          '~嗯你~今晚有空~嗎~+不+ ~我在想我們可以就是去~喝杯咖啡 ~六點左右~+6點+ ~跟我說一聲~+回我+',
      },
      work: {
        formal:
          '~嗯~+你好，+你能在開會前把簡報寄給我嗎+？+~第三頁~+第3頁+的數字好像過時了+。+不急+。+',
        casual:
          '~嗯~+嘿，+~你~能在開會前把簡報寄給我嗎+？+~第三頁的數字好像過時了~+第3頁數字可能舊了，+不急',
        excited:
          '~嗯~+嘿！+你能在開會前把簡報寄給我嗎+？+~第三頁~+第3頁+的數字好像過時了+。+不急+！+',
      },
      email: {
        formal:
          '+Sarah，您好：+\n\n感謝~你~+您+今天撥冗+。+~嗯~我會在週四前寄出更新後的提案+。+~之前有什麼需要請告訴我~+在此之前如有需要，請隨時告訴我。+\n\n+敬上+',
        casual:
          '+Sarah，你好：+\n\n~感謝~+謝謝+你今天撥冗+。+~嗯~我會在週四前~寄出~+寄+更新後的提案+，+之前有什麼需要請告訴我+。+\n\n+謝謝+',
        excited:
          '+Sarah，你好：+\n\n~感謝~+太感謝+你今天撥冗+了！+~嗯~我會在週四前~寄出~+寄+更新後的提案+。+之前有什麼需要請告訴我+！+\n\n+謝謝+',
      },
      other: {
        formal: '通話紀錄+：+~嗯~他們喜歡定價頁+，+希望導入流程短一點+。+下週跟進+。+',
        casual: '通話紀錄+：+~嗯他們~喜歡定價頁+，+~希望~導入流程~短一點~+要短點。+下週跟進',
        excited: '通話紀錄+：+~嗯~他們~喜歡~+超喜歡+定價頁+！+希望導入流程短一點+。+下週跟進+！+',
      },
    },
  },
  ja: {
    question: 'このあと何してる？',
    to: '宛先',
    notes: '通話メモ',
    intro: {
      formal: '~えっと~今夜+は+空いて~る~+いますか？+',
      casual: '~えっと~今夜空いてる+？+',
      very_casual: '~えっと~今夜~空いてる~+ひま？+',
    },
    examples: {
      personal: {
        formal:
          '~えっと~今夜+は+空いて~る~+いますか？+~六時~+6時+ごろ~とか~にコーヒーでもどうかなって思って~て~+います。+教えて+ください。+',
        casual:
          '~えっと~今夜空いてる+？+~六時~+6時+ごろ~とか~にコーヒーでもどう+？+~かなって思ってて~教えて',
        very_casual:
          '~えっと~今夜~空いてる~+ひま？+ ~六時ごろとかに~+6時に+コーヒー~でもどうかなって思ってて~+どう+ ~教えて~+連絡して+',
      },
      work: {
        formal:
          '~えっと~会議の前に資料を送って~もらえる~+いただけますか？+~三枚目~+3枚目+の数字が古い~みたい~+ようです。+~急がないよ~+急ぎではありません。+',
        casual:
          '~えっと~会議の前に資料~を~送ってもらえる+？+~三枚目の数字が古いみたい~+3枚目の数字古いかも、+急がないよ',
        excited:
          '~えっと~+お疲れさま！+会議の前に資料を送ってもらえる+？+~三枚目~+3枚目+の数字が古いみたい+！+急がないよ+！+',
      },
      email: {
        formal:
          '+Sarah様+\n\n今日は+貴重な+お時間+を+ありがとうございました+。+~えっと~木曜までに更新した提案書を+お+送り~します~+いたします。+それまでに何かあれば~教えて~+お知らせ+ください+。+\n\n+よろしくお願いいたします。+',
        casual:
          '+Sarahさん+\n\n今日はお時間ありがとうございました+。+~えっと~木曜までに更新した提案書を送ります+。+それまでに何かあれば教えてください+。+\n\n+よろしくお願いします+',
        excited:
          '+Sarahさん+\n\n今日はお時間+本当に+ありがとうございました+！+~えっと~木曜までに更新した提案書を送ります+！+それまでに何かあれば教えてください+！+\n\n+よろしくお願いします+',
      },
      other: {
        formal:
          '通話メモ+：+~えっと~料金ページが好評で+、+導入をもっと短くしてほしいとのこと+。+来週フォローアップ+。+',
        casual:
          '通話メモ+：+~えっと~料金ページ~が~好評+、+導入~をもっと~短く~してほしいとのこと~+希望。+来週フォローアップ',
        excited:
          '通話メモ+：+~えっと~料金ページが~好評で~+大好評！+導入をもっと短くしてほしいとのこと+。+来週フォローアップ+！+',
      },
    },
  },
  ar: {
    question: 'ماذا ستفعل لاحقًا؟',
    to: 'إلى',
    notes: 'ملاحظات المكالمة',
    intro: {
      formal: '~امم~ +مرحبًا،+ هل أنت متفرغ الليلة+؟+',
      casual: '~امم مرحبا~ +أهلًا،+ ~هل أنت~ متفرغ الليلة+؟+',
      very_casual: '~امم مرحبا~ +هاي+ ~هل أنت متفرغ~ +فاضي+ الليلة+؟+',
    },
    examples: {
      personal: {
        formal:
          '~امم~ +مرحبًا،+ هل أنت متفرغ الليلة+؟+ كنت أفكر ~يعني~ +أن+ نشرب قهوة حوالي الساعة ~ستة~ +6.+ أخبرني+.+',
        casual:
          '~امم مرحبا~ +أهلًا،+ ~هل أنت~ متفرغ الليلة+؟+ ~كنت أفكر يعني~ نشرب قهوة حوالي ~الساعة ستة~ +6؟+ أخبرني',
        very_casual:
          '~امم مرحبا~ +هاي+ ~هل أنت متفرغ~ +فاضي+ الليلة+؟+ ~كنت أفكر يعني نشرب~ قهوة ~حوالي الساعة ستة~ +على 6+ ~أخبرني~ +قلّي+',
      },
      work: {
        formal:
          '~امم~ +مرحبًا،+ هل يمكنك إرسال العرض قبل الاجتماع+؟+ أرقام الشريحة ~الثالثة~ +3+ تبدو قديمة+.+ لا داعي للعجلة+.+',
        casual:
          '~امم مرحبا~ +أهلًا،+ ~هل يمكنك~ +ممكن+ إرسال العرض قبل الاجتماع+؟+ ~أرقام الشريحة الثالثة تبدو قديمة~ +أرقام الشريحة 3 قديمة على ما يبدو،+ لا داعي للعجلة',
        excited:
          '~امم~ +مرحبًا!+ هل يمكنك إرسال العرض قبل الاجتماع+؟+ أرقام الشريحة ~الثالثة~ +3+ تبدو قديمة+.+ لا داعي للعجلة+!+',
      },
      email: {
        formal:
          '+عزيزتي Sarah،+\n\n~شكرا~ +شكرًا+ على وقتك اليوم+.+ ~امم~ سأرسل العرض المحدّث بحلول الخميس+.+ ~أخبرني~ +يُرجى إخباري+ إذا احتجت أي شيء قبل ذلك+.+\n\n+مع خالص التحية+',
        casual:
          '+مرحبًا Sarah،+\n\n~شكرا~ +شكرًا+ على وقتك اليوم+.+ ~امم~ سأرسل العرض المحدّث بحلول الخميس+،+ أخبرني إذا احتجت أي شيء قبل ذلك+.+\n\n+شكرًا+',
        excited:
          '+مرحبًا Sarah،+\n\n~شكرا~ +شكرًا جزيلًا+ على وقتك اليوم+!+ ~امم~ سأرسل العرض المحدّث بحلول الخميس+.+ أخبرني إذا احتجت أي شيء قبل ذلك+!+\n\n+شكرًا+',
      },
      other: {
        formal:
          'ملاحظات المكالمة+:+ ~امم~ أعجبتهم صفحة الأسعار ويريدون إعدادًا أقصر+.+ المتابعة معهم الأسبوع القادم+.+',
        casual:
          'ملاحظات المكالمة+:+ ~امم~ أعجبتهم صفحة الأسعار+،+ ~ويريدون إعدادًا أقصر~ +يريدون إعدادًا أقصر.+ المتابعة ~معهم~ الأسبوع القادم',
        excited:
          'ملاحظات المكالمة+:+ ~امم~ ~أعجبتهم~ +أحبّوا+ صفحة الأسعار+!+ ويريدون إعدادًا أقصر+.+ المتابعة معهم الأسبوع القادم+!+',
      },
    },
  },
};
