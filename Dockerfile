version: "3.8"

services:
  b24-deal-dedup:
    build: .
    container_name: b24-deal-dedup
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      # Входящий вебхук Битрикс24 (Настройки -> Разработчикам -> Входящий вебхук)
      # Пример: https://yourportal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
      - B24_WEBHOOK_URL=${B24_WEBHOOK_URL}
      # Опционально: application_token из настроек исходящего вебхука, для проверки подлинности запросов
      - B24_APP_TOKEN=${B24_APP_TOKEN}
