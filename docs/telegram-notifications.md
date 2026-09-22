# Get notified in Telegram

We use telegram to send you the update status.

Setup instructions:

1. Create your bot following [this](https://core.telegram.org/bots#creating-a-new-bot)
2. Open this url `https://api.telegram.org/bot<TELEGRAM_API_KEY>/getUpdates`
3. Send a message to your bot and find the chat id

```typescript
options: {
  notifications: {
    telegram?: {
      /**
       * The super secret api key you got from BotFather
       */
      apiKey: string;
      /**
       * The chat id
       */
      chatId: string;
      /**
       * Enable OTP (One-Time Password) support for 2FA authentication.
       * When enabled, the bot will ask for OTP codes via Telegram during scraping.
       * @default false
       */
      enableOtp?: boolean;
      /**
       * Maximum time in seconds to wait for OTP response from user.
       * @default 300 (5 minutes)
       */
      otpTimeoutSeconds?: number;
    };
  };
};
```

## Using OTP 2FA with OneZero Accounts

If you have OneZero accounts that require 2FA authentication, you can enable OTP support:

1. **Enable OTP in your configuration**:

   ```json
   {
     "options": {
       "notifications": {
         "telegram": {
           "apiKey": "your-telegram-bot-token",
           "chatId": "your-chat-id",
           "enableOtp": true,
           "otpTimeoutSeconds": 300
         }
       }
     }
   }
   ```

2. **Configure your OneZero account with phone number**:

   ```json
   {
     "accounts": [
       {
         "companyId": "oneZero",
         "email": "your-email@example.com",
         "password": "your-password",
         "phoneNumber": "+972501234567"
       }
     ]
   }
   ```

3. **During scraping**: When a OneZero account requires 2FA, the bot will:
   - Send a message asking for the OTP code
   - Wait for you to reply with the code (4-8 digits)
   - Continue the scraping process automatically

## Using OTP 2FA with Bank Hapoalim

Hapoalim sends an SMS code when it does not recognise the browser. With
`enableOtp: true`, a `hapoalim` account needs no extra configuration — the bank
texts the number it has on file.

Bank codes expire within minutes, often before you see the prompt. Reply
`resend` (or `r`, or `שלח שוב`) and the scraper asks the bank for a new code
without using up one of the three login attempts. The next prompt says whether
the new code was requested, or whether no send-again control was found and you
should use the code you already have.

Any other reply gets a short usage hint and the bot keeps waiting. Halfway
through `otpTimeoutSeconds` the bot sends a reminder.

To make the challenge rare rather than nightly, set
`MONEYMAN_BROWSER_PROFILE_PATH` to a persistent directory: the browser profile —
and with it the bank's device trust — then survives between runs. The profile
holds live bank session cookies, so keep it out of backups, and scrape one
account per run when using it: all accounts in a run share the profile.
