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

describe("isEmailableEntity — literal Ltd suffix is trusted BEFORE the register", () => {
  // Regression: a noisy trading name made the CH search miss and wrongly HOLD an
  // obvious Ltd ("Cartwright & Co Ltd - Accountants & Tax Advisers"). The literal
  // suffix must short-circuit to emailable=true without even calling the register,
  // so a CH miss can never override it. Key is SET here — proving no network is hit.
  const cfg = { COMPANIES_HOUSE_API_KEY: "test-key", REQUIRE_LTD: true } as unknown as AppConfig;

  it("'… Ltd' with a descriptive tail → emailable, no register call needed", async () => {
    expect(await isEmailableEntity(cfg, "Cartwright & Co Ltd - Accountants & Tax Advisers")).toBe(
      true,
    );
    expect(await isEmailableEntity(cfg, "Parker Stag Ltd - Estate and Letting Agents")).toBe(true);
    expect(await isEmailableEntity(cfg, "Royton Insurance (RIS Group LTD)")).toBe(true);
  });
});
