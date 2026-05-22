# Руководство по развертыванию на Linux

В этом руководстве приведены пошаговые инструкции по развертыванию Telegram Gemini Chat Summarizer Bot на серверах Linux: **Debian/Ubuntu** (на базе APT) и **AlmaLinux/Rocky Linux** (на базе YUM/DNF).

---

## 📋 Предварительные требования

### 1. Установка Node.js (v20.17.0+)

Мы рекомендуем устанавливать Node.js версии v20 LTS.

#### Debian / Ubuntu:
```bash
# Подключение репозитория NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### AlmaLinux / Rocky Linux:
```bash
# Включение потока модуля Node.js (версия 20)
sudo dnf module enable -y nodejs:20
sudo dnf install -y nodejs
```

### 2. Установка SQLite и средств сборки (Build Essentials)
Поскольку бот использует библиотеку SQLite (`sqlite3` npm-пакет, компилирующий бинарные модули C++ при установке), требуются инструменты компиляции и файлы разработки SQLite.

#### Debian / Ubuntu:
```bash
sudo apt-get update
sudo apt-get install -y sqlite3 build-essential
```

#### AlmaLinux / Rocky Linux:
```bash
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y sqlite sqlite-devel
```

---

## 🚀 Установка и сборка

### 1. Клонирование репозитория и установка зависимостей
Клонируйте репозиторий в нужную папку на сервере (например, `/opt/telegram-summarizer-bot`):

```bash
sudo git clone https://github.com/yniyniyni/telegram-summarizer-bot /opt/telegram-summarizer-bot
cd /opt/telegram-summarizer-bot

# Передача прав на директорию вашему текущему пользователю
sudo chown -R $USER:$USER /opt/telegram-summarizer-bot

# Установка пакетов
npm install
```

### 2. Настройка переменных окружения
Создайте рабочий конфигурационный файл `.env` на основе примера:
```bash
cp .env.example .env
nano .env
```
Заполните настройки:
```ini
TELEGRAM_BOT_TOKEN=ваш_токен_телеграм_бота
GEMINI_API_KEY=ваш_ключ_gemini_api
# GOOGLE_API_KEY=ваш_ключ_google_api
DB_PATH=/opt/telegram-summarizer-bot/data/bot_messages.db
# Значения DB_PATH с '..' отклоняются при запуске.
# Временная зона для форматирования дат в промптах. Если указана некорректная зона, бот запишет предупреждение в лог при запуске и переключится на UTC.
DEFAULT_TIMEZONE=Europe/Moscow
BOT_LANGUAGE=ru
# DEBUG-логи по умолчанию выключены. Используйте DEBUG=true/1 или LOG_LEVEL=debug, чтобы их включить.
# DEBUG=true
# LOG_LEVEL=debug
# Настройки безопасности: по умолчанию чаты не авторизованы (fail-closed).
# Установите ALLOW_ALL_CHATS=true для отключения проверок, либо задайте ALLOWED_CHATS.
ALLOW_ALL_CHATS=true
# ALLOWED_CHATS=-100123456789
# Дополнительно, ограничить личные сообщения (DMs) конкретными пользователями, даже если ALLOW_ALL_CHATS=true:
# ALLOWED_USERS=12345678
# Опционально настройте rate limit. Некорректный RATE_LIMIT_MAX_REQUESTS работает в fail-closed режиме; некорректное окно заменяется на 3600.
# RATE_LIMIT_MAX_REQUESTS=5
# RATE_LIMIT_WINDOW_SEC=3600
# Режим минимизации PII: Установите REDACT_USER_IDENTITIES=true для замены реальных имен/юзернеймов псевдонимами
REDACT_USER_IDENTITIES=false
```

### 3. Сборка проекта
Скомпилируйте исходный код TypeScript в JavaScript:
```bash
npm run build
```

Убедитесь, что скомпилированные файлы появились в директории `dist`:
```bash
ls dist/
```

---

## ⚙️ Запуск в качестве системной службы (systemd)

Для стабильной работы в продакшене рекомендуется запускать бота через службу `systemd`. Это обеспечит работу в фоновом режиме, вывод логов в системный журнал и автоматический перезапуск при сбоях или после перезагрузки сервера.

### 1. Создание файла службы systemd

Создайте файл службы `/etc/systemd/system/telegram-bot.service`:
```bash
sudo nano /etc/systemd/system/telegram-bot.service
```

Вставьте следующую конфигурацию (замените `youruser` на имя вашего пользователя Linux, под которым будет запускаться бот, например, ваше имя пользователя или выделенный пользователь `telegram-bot`):

```ini
[Unit]
Description=Telegram Gemini Summarizer Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/telegram-summarizer-bot
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> [!NOTE]
> Если вы не знаете имя вашего пользователя или путь к Node.js, выполните команды `whoami` и `which node` для проверки.

### 2. Запуск службы и автозапуск

```bash
# Перезагрузка конфигурации systemd менеджера
sudo systemctl daemon-reload

# Запуск службы бота
sudo systemctl start telegram-bot

# Включение службы в автозапуск при загрузке системы
sudo systemctl enable telegram-bot
```

### 3. Мониторинг и логирование

Проверить текущий статус службы можно командой:
```bash
sudo systemctl status telegram-bot
```

Для чтения логов бота в режиме реального времени:
```bash
sudo journalctl -u telegram-bot -f -o cat
```

Если вы настроили `DEBUG=true`, `DEBUG=1` или `LOG_LEVEL=debug` в файле `.env`, отладочные сообщения также будут отображаться в журнале.
