import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { isCorporateEntity, isEmailableEntity } from "./compliance";

describe("isCorporateEntity", () => {
  it("распознаёт инкорпорированные формы (PECR-emailable)", () => {
    for (const n of [
      "Bright Smile Dental Ltd",
      "Acme Limited",
      "Foo Partners LLP",
      "Bar Holdings PLC",
      "Baz Incorporated",
      "Welsh Co Cyf",
    ]) {
      expect(isCorporateEntity(n)).toBe(true);
    }
  });

  it("держит соло-трейдеров / пустое как НЕ корпорацию (консервативно)", () => {
    for (const n of ["Bright Smile Dental", "John the Plumber", "", null, undefined]) {
      expect(isCorporateEntity(n)).toBe(false);
    }
  });
});

describe("isEmailableEntity без Companies House ключа → эвристика по имени", () => {
  const cfg = {
    COMPANIES_HOUSE_API_KEY: undefined,
    REQUIRE_LTD: true,
  } as unknown as AppConfig;

  it("Ltd → emailable (true)", async () => {
    expect(await isEmailableEntity(cfg, "Acme Dental Ltd")).toBe(true);
  });

  it("без юр-суффикса → held (false, вероятный соло-трейдер)", async () => {
    expect(await isEmailableEntity(cfg, "Acme Dental")).toBe(false);
  });

  it("пустое имя → false", async () => {
    expect(await isEmailableEntity(cfg, "")).toBe(false);
  });
});
