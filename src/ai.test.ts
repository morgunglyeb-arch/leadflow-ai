import { describe, expect, it } from "vitest";
import { extractJsonObject, parseModelJson, repairJsonControlChars } from "./ai";

// These reproduce the EXACT shapes free models (OpenRouter gpt-oss-120b:free)
// returned in a real batch, which a raw JSON.parse rejected → every lead fell
// back. The tolerant parser must recover them.
describe("parseModelJson — free-model reply tolerance", () => {
  it("plain JSON parses unchanged", () => {
    expect(parseModelJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("strips a ```json fence", () => {
    expect(parseModelJson('```json\n{"hook":"hi","subject":"quick q"}\n```')).toEqual({
      hook: "hi",
      subject: "quick q",
    });
  });

  it("strips a ```json5 fence (no newline)", () => {
    expect(parseModelJson('```json5 {"a":"b"}')).toEqual({ a: "b" });
  });

  it("strips a ```json{ fence with no space", () => {
    expect(parseModelJson('```json{ "a": "b" }```')).toEqual({ a: "b" });
  });

  it("ignores prose before/after the object", () => {
    expect(parseModelJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("repairs a raw newline inside a string value (Bad control character)", () => {
    // a literal newline inside the "opener" value — invalid JSON until escaped
    const raw = '{"opener":"line one\nline two","subject":"hi"}';
    expect(parseModelJson(raw)).toEqual({ opener: "line one\nline two", subject: "hi" });
  });

  it("repairs raw tab/return inside strings too", () => {
    const raw = '{"a":"x\ty","b":"p\rq"}';
    expect(parseModelJson(raw)).toEqual({ a: "x\ty", b: "p\rq" });
  });

  it("does NOT corrupt structural whitespace (newlines between fields)", () => {
    const raw = '{\n  "a": 1,\n  "b": 2\n}';
    expect(parseModelJson(raw)).toEqual({ a: 1, b: 2 });
  });

  it("leaves already-escaped sequences alone", () => {
    expect(parseModelJson('{"a":"line\\nbreak"}')).toEqual({ a: "line\nbreak" });
  });

  it("truncated JSON still throws (genuinely unrecoverable)", () => {
    expect(() => parseModelJson('{"a":"unterminated')).toThrow();
  });
});

describe("extractJsonObject", () => {
  it("slices the outermost object", () => {
    expect(extractJsonObject('noise {"a":{"b":1}} tail')).toBe('{"a":{"b":1}}');
  });
  it("returns trimmed text when no braces", () => {
    expect(extractJsonObject("  hello  ")).toBe("hello");
  });
});

describe("repairJsonControlChars", () => {
  it("escapes control chars only inside strings", () => {
    expect(repairJsonControlChars('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
  });
  it("does not touch a control char that is structural", () => {
    // newline between tokens stays a real newline (valid JSON whitespace)
    expect(repairJsonControlChars('{\n"a":1}')).toBe('{\n"a":1}');
  });
});
