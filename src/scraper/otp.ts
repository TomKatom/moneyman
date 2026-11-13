import type {
  OtpCodeRetriever,
  OtpCodeRetrieverOptions,
} from "israeli-bank-scrapers";
import type { AccountConfig } from "../types.js";
import { createLogger } from "../utils/logger.js";

export type OtpRequest = (
  companyId: string,
  phoneNumber?: string,
  signal?: AbortSignal,
  options?: OtpCodeRetrieverOptions,
) => Promise<string>;

const logger = createLogger("otp");

export function otpPhoneNumber(account: AccountConfig): string | undefined {
  return "phoneNumber" in account && typeof account.phoneNumber === "string"
    ? account.phoneNumber
    : undefined;
}

/**
 * Creates an OTP code retriever function that relays the request to Telegram
 */
function createOtpCodeRetriever(
  account: AccountConfig,
  requestOtpCode: OtpRequest,
): OtpCodeRetriever {
  return async (options) => {
    const phoneNumber = otpPhoneNumber(account);
    logger(
      `Requesting OTP code for ${account.companyId} account (phone: ${phoneNumber}, attempt: ${options?.attempt})`,
    );
    return await requestOtpCode(
      account.companyId,
      phoneNumber,
      undefined,
      options,
    );
  };
}

/**
 * Checks if an account should have an OTP code retriever attached
 */
export function shouldCreateOtpRetriever(
  account: AccountConfig,
  enableOtp = false,
): boolean {
  if (!enableOtp) return false;

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
 * Finds the account a worker-side OTP request belongs to, so the parent can
 * re-check it against its own copy of the config
 */
export function findOtpAccountIndex(
  accounts: AccountConfig[],
  companyId: string,
  phoneNumber?: string,
): number {
  return accounts.findIndex(
    (account) =>
      account.companyId === companyId &&
      shouldCreateOtpRetriever(account, true) &&
      otpPhoneNumber(account) === phoneNumber,
  );
}

/**
 * Prepares the account credentials with OTP support if needed
 */
export function prepareAccountCredentials(
  account: AccountConfig,
  requestOtpCode?: OtpRequest,
): Partial<AccountConfig> {
  if (shouldCreateOtpRetriever(account, !!requestOtpCode)) {
    logger(`Setting up OTP code retriever for ${account.companyId} account`);

    return {
      otpCodeRetriever: createOtpCodeRetriever(account, requestOtpCode!),
    };
  }

  return {};
}
