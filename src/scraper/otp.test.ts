import {
  findOtpAccountIndex,
  shouldCreateOtpRetriever,
  prepareAccountCredentials,
} from "./otp.js";
import { AccountConfig } from "../types.js";
import { CompanyTypes, type OtpCodeRetriever } from "israeli-bank-scrapers";
const requestOtpCode = jest.fn().mockResolvedValue("123456");

describe("OTP utilities", () => {
  describe("shouldCreateOtpRetriever", () => {
    it("does not enable OTP without an explicit parent capability", () => {
      expect(
        shouldCreateOtpRetriever({
          companyId: CompanyTypes.oneZero,
          email: "test@example.com",
          password: "password",
          phoneNumber: "+97200000000",
        } as AccountConfig),
      ).toBe(false);
    });
    it("should return true for OneZero account with phone number and OTP enabled", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, true)).toBe(true);
    });

    it("should return false for OneZero account with otpLongTermToken", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
        otpLongTermToken: "token123",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, true)).toBe(false);
    });

    it("should return false for OneZero account without phone number", () => {
      const account = {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, true)).toBe(false);
    });

    it("should return true for Hapoalim account without phone number", () => {
      const account = {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, true)).toBe(true);
    });

    it("should return false for Hapoalim account when OTP is disabled", () => {
      const account = {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, false)).toBe(false);
    });

    it("should return false for accounts without OTP support", () => {
      const account = {
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      } as AccountConfig;

      expect(shouldCreateOtpRetriever(account, true)).toBe(false);
    });
  });

  describe("findOtpAccountIndex", () => {
    const accounts = [
      {
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      },
      {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
        otpLongTermToken: "token123",
      },
      {
        companyId: CompanyTypes.oneZero,
        email: "test@example.com",
        password: "password",
        phoneNumber: "+972501234567",
      },
      {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      },
    ] as AccountConfig[];

    it("matches a OneZero account by phone number, skipping long-term tokens", () => {
      expect(findOtpAccountIndex(accounts, "oneZero", "+972501234567")).toBe(2);
    });

    it("matches a Hapoalim account, which has no phone number", () => {
      expect(findOtpAccountIndex(accounts, "hapoalim", undefined)).toBe(3);
    });

    it("does not match accounts without OTP support", () => {
      expect(findOtpAccountIndex(accounts, "max", undefined)).toBe(-1);
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

      const prepared = prepareAccountCredentials(account, requestOtpCode);

      expect(prepared).toHaveProperty("otpCodeRetriever");
      expect(typeof (prepared as any).otpCodeRetriever).toBe("function");
      return expect((prepared as any).otpCodeRetriever()).resolves.toBe(
        "123456",
      );
    });

    it("should not modify accounts that don't need OTP", () => {
      const account = {
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      } as AccountConfig;

      const prepared = prepareAccountCredentials(account, requestOtpCode);

      expect(prepared).toEqual({});
      expect(account).toEqual({
        companyId: CompanyTypes.max,
        username: "user",
        password: "password",
      });
    });

    it("should forward the scraper's attempt state to the OTP request", async () => {
      const account = {
        companyId: CompanyTypes.hapoalim,
        userCode: "123456",
        password: "password",
      } as AccountConfig;

      const { otpCodeRetriever } = prepareAccountCredentials(
        account,
        requestOtpCode,
      ) as { otpCodeRetriever: OtpCodeRetriever };
      const code = await otpCodeRetriever({ attempt: 2, resent: true });

      expect(code).toBe("123456");
      expect(requestOtpCode).toHaveBeenCalledWith(
        "hapoalim",
        undefined,
        undefined,
        { attempt: 2, resent: true },
      );
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
