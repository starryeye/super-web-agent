import { randomUUID } from "node:crypto";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createRuntimeSessionId(
  createUuid: () => string = randomUUID,
): string {
  const value = createUuid();
  if (!uuidPattern.test(value)) throw new Error("invalid Runtime Session UUID");
  return `rt_${value.replaceAll("-", "").toLowerCase()}`;
}
