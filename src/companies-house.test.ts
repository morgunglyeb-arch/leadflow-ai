import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { chQueryVariants, isRegisteredCompany } from "./companies-house";

describe("isRegisteredCompany (fail-safe, без сети в этих кейсах)", () => {
  it("нет COMPANIES_HOUSE_API_KEY → null (не блокирует; вызывающий падает на эвристику)", async () => {
    const cfg = { COMPANIES_HOUSE_API_KEY: undefined } as unknown as AppConfig;
    expect(await isRegisteredCompany(cfg, "Acme Dental Ltd")).toBeNull();
  });

  it("слишком короткое/пустое имя → null до любого запроса", async () => {
    const cfg = { COMPANIES_HOUSE_API_KEY: "test-key" } as unknown as AppConfig;
    expect(await isRegisteredCompany(cfg, "")).toBeNull();
    expect(await isRegisteredCompany(cfg, "ab")).toBeNull();
  });
});

describe("chQueryVariants — cleans noisy trading names into searchable queries", () => {
  it("drops the descriptive tail after a dash so CH can find the company", () => {
    const v = chQueryVariants("Collinson Hall - Estate Agents & Letting Agents in St Albans");
    // the clean distinctive name must be one of the tried queries
    expect(v).toContain("Collinson Hall");
  });

  it("surfaces a real Ltd hiding inside parentheses", () => {
    const v = chQueryVariants("Royton Insurance (RIS Group LTD)");
    expect(v).toContain("RIS Group LTD");
  });

  it("strips sector boilerplate down to the distinctive name", () => {
    const v = chQueryVariants("Bridgfords Sales and Letting Agents Chorley");
    // sector words gone, distinctive tokens kept
    expect(v.some((q) => /bridgfords/i.test(q) && /chorley/i.test(q) && !/letting/i.test(q))).toBe(
      true,
    );
  });

  it("always tries the raw name first (most specific)", () => {
    const v = chQueryVariants("Cartwright & Co Ltd - Accountants & Tax Advisers");
    expect(v[0]).toBe("Cartwright & Co Ltd - Accountants & Tax Advisers");
    expect(v).toContain("Cartwright & Co Ltd"); // dash-trimmed variant retains the Ltd
  });
});
