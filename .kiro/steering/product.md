---
inclusion: always
---

# Wymagania produktu

- Agent musi mieć panel WWW do obsługi, konfiguracji i monitoringu.
- Panel musi pokazywać stan Camofox i osobny stan każdego autoryzowanego konta Facebook.
- Każde konto Facebook musi korzystać z oddzielnego, trwałego profilu Camofox.
- Dane logowania nie mogą być zapisywane w kodzie ani rejestrze kont; pierwsze logowanie odbywa się ręcznie przez noVNC.
- Panel ma umożliwiać rejestrację konta, rozpoczęcie i zakończenie logowania, otwarcie sesji oraz jej zatrzymanie.


- Warstwa decyzyjna agenta ma korzystać z Claude Opus 4.8 przez konfigurowalne Custom API.
- Integracja LLM musi obsługiwać format Anthropic Messages oraz OpenAI-compatible, a klucz API może znajdować się wyłącznie w zmiennych środowiskowych.
- Panel ma pokazywać konfigurację modelu i umożliwiać jawny test połączenia bez cyklicznego generowania kosztów.
