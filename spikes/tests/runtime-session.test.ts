import { expect, it } from "vitest";
import { createRuntimeSessionId } from "../src/runtime-session.js";

it("prefixes and validates one generated Runtime Session ID", () => {
  expect(createRuntimeSessionId(() => "018f0000-0000-7000-8000-000000000001"))
    .toBe("rt_018f0000000070008000000000000001");
});

it("rejects malformed UUID output", () => {
  expect(() => createRuntimeSessionId(() => "not-a-uuid")).toThrow(
    "invalid Runtime Session UUID",
  );
});
