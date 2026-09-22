import type { OtpCodeRetriever } from "israeli-bank-scrapers";
import { AccountConfig } from "../types.js";
import { config } from "../config.js";
import { requestOtpCode } from "../bot/notifier.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("otp");

/**
 * Creates an OTP code retriever function that relays the request to Telegram
 */
function createOtpCodeRetriever(account: AccountConfig): OtpCodeRetriever {
  return async (options) => {
    if (!config.options.notifications.telegram?.enableOtp) {
      throw new Error("OTP is not enabled in configuration");
    }

    const phoneNumber =
      "phoneNumber" in account ? account.phoneNumber : undefined;
    logger(
      `Requesting OTP code for ${account.companyId} account (phone: ${phoneNumber}, attempt: ${options?.attempt})`,
    );
    return await requestOtpCode(account.companyId, phoneNumber, options);
  };
}

/**
 * Checks if an account should have an OTP code retriever attached
 */
export function shouldCreateOtpRetriever(account: AccountConfig): boolean {
  if (config.options.notifications.telegram?.enableOtp !== true) {
    return false;
  }

  switch (account.companyId) {
    case "oneZero":
      return (
        "phoneNumber" in account &&
        !!account.phoneNumber &&
        !("otpLongTermToken" in account)
      );
    // Hapoalim only challenges unrecognised devices, and the SMS goes to the
    // number the bank has on file, so there is nothing to configure.
    case "hapoalim":
      return true;
    default:
      return false;
  }
}

/**
 * Prepares the account credentials with OTP support if needed
 */
export function prepareAccountCredentials(
  account: AccountConfig,
): Partial<AccountConfig> {
  if (shouldCreateOtpRetriever(account)) {
    logger(`Setting up OTP code retriever for ${account.companyId} account`);

    return {
      otpCodeRetriever: createOtpCodeRetriever(account),
    };
  }

  return {};
}
