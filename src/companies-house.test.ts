import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { isRegisteredCompany } from "./companies-house";

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
