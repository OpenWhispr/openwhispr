<h1 align="center">Dyktownik</h1>

<p align="center">
  Dyktuj zamiast pisać. Naciśnij skrót, powiedz, co chcesz, a tekst pojawi się tam, gdzie jest kursor.
</p>

## Co potrafi

- **Dyktowanie w każdej aplikacji.** Skrót klawiszowy, mowa, gotowy tekst wklejony w aktywne pole.
- **Lokalnie albo w chmurze.** Modele Whisper i Parakeet działają na Twoim komputerze, bez wysyłania dźwięku w świat. Możesz też użyć własnego klucza API.
- **Polski na pierwszym miejscu.** Interfejs, polecenia czyszczące tekst i słownik są po polsku.
- **Notatki ze spotkań.** Nagrywanie rozmów, transkrypcja, podsumowania i szablony.
- **Asystent głosowy.** Powiedz polecenie, a asystent napisze odpowiedź, e-mail albo przerobi zaznaczony tekst.
- **Własny słownik i fragmenty.** Nazwy własne, żargon i skróty, które mają się zawsze zapisywać tak samo.

## Uruchomienie

Wymagany jest Node.js 24 (patrz `.nvmrc`).

```bash
npm ci
npm run dev
```

Paczkę instalacyjną zbudujesz poleceniami `npm run build:win`, `npm run build:mac` lub `npm run build:linux`.

Testy: `npm test`.

## Pochodzenie i licencja

Dyktownik powstał jako polska wersja projektu OpenWhispr i, tak jak on, jest udostępniany na licencji MIT. Oryginalna informacja o prawach autorskich zostaje w pliku `LICENSE`. Szczegóły techniczne architektury opisuje `CLAUDE.md`.
