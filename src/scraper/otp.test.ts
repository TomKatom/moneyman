import { shouldCreateOtpRetriever, prepareAccountCredentials } from "./otp.js";
import { AccountConfig } from "../types.js";
import { CompanyTypes, type OtpCodeRetriever } from "israeli-bank-scrapers";
import { config } from "../config.js";
import { requestOtpCode } from "../bot/notifier.js";

// Mock the config module
jest.mock("../config.js", () => ({
  config: {
    options: {
      notifications: {
        telegram: {
          enableOtp: true,
        },
      },
    },
  },
}));

// Mock the notifier module
jest.mock("../bot/notifier.js", () => ({
  requestOtpCode: jest.fn().mockResolvedValue("123456"),
}));

describe("OTP utilities", () => {
  describe("shouldCreateOtpRetriever", () => {
    it("should return true for OneZero account with phone number and OTP enabled", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account)).toBe(true);
    });

    it("should return false for OneZero account with otpLongTermToken", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
        otpLongTermToken: "token123",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account)).toBe(false);
    });

    it("should return false for OneZero account without phone number", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account)).toBe(false);
    });

    it("should return true for Hapoalim account without phone number", () => {
      const account = {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account)).toBe(true);
    });

    it("should return false for Hapoalim account when OTP is disabled", () => {
      const telegram = config.options.notifications.telegram!;
      telegram.enableOtp = false;
      try {
        const account = {
          companyId: CompanyTypes.hapoalim,
          userCode: "123456",
          password: "password",
        } as AccountConfig;

        expect(shouldCreateOtpRetriever(account)).toBe(false);
      } finally {
        telegram.enableOtp = true;
      }
    });

    it("should return false for accounts without OTP support", () => {
      const account = {
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account)).toBe(false);
    });
  });

  describe("prepareAccountCredentials", () => {
    it("should add otpCodeRetriever for eligible OneZero accounts", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
      } as AccountConfig;

      const prepared = prepareAccountCredentials(account);

      expect(prepared).toHaveProperty("otpCodeRetriever");
      expect(typeof (prepared as any).otpCodeRetriever).toBe("function");
    });

    it("should not modify accounts that don't need OTP", () => {
      const account = {
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      } as AccountConfig;

      const prepared = prepareAccountCredentials(account);

      expect(prepared).toEqual({});
      expect(account).toEqual({
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      });
    });

    it("should forward the scraper's attempt state to the Telegram prompt", async () => {
      const account = {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      } as AccountConfig;

      const { otpCodeRetriever } = prepareAccountCredentials(account) as {
        otpCodeRetriever: OtpCodeRetriever;
      };
      const code = await otpCodeRetriever({ attempt: 2, resent: true });

      expect(code).toBe("123456");
      expect(requestOtpCode).toHaveBeenCalledWith("hapoalim", undefined, {
        attempt: 2,
        resent: true,
      });
    });

    it("should not modify OneZero accounts with otpLongTermToken", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
        otpLongTermToken: "token123",
      } as AccountConfig;

      const prepared = prepareAccountCredentials(account);

      expect(prepared).toEqual({});
      expect(account).toEqual({
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
        otpLongTermToken: "token123",
      });
    });
  });
});
