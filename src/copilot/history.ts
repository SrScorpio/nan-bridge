/**
 * Keeps a conversation inside the model's context window by dropping whole
 * conversational units from the middle. A unit is an assistant message
 * together with the tool calls it made and the tool results that followed —
 * splitting them would produce a payload the gateway rejects. The first unit
 * (framing/system) and the last units (current turn) always stay.
 */

import type { OutgoingMessage } from "./inbound";

interface Unit {
  readonly messages: readonly OutgoingMessage[];
  readonly tokens: number;
}

/** Cheap estimator: ~4 characters per token plus per-message framing. */
export function roughTokens(messages: readonly OutgoingMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      6 +
      (typeof message.content === "string"
        ? Math.ceil(message.content.length / 4)
        : message.content.reduce((inner, part) => inner + Math.ceil((part.text?.length ?? 512) / 4), 0)) +
      (message.tool_calls?.reduce((inner, call) => inner + Math.ceil(call.function.arguments.length / 4), 0) ?? 0),
    0,
  );
}

function splitUnits(messages: readonly OutgoingMessage[]): Unit[] {
  const units: Unit[] = [];
  let current: OutgoingMessage[] = [];
  const seal = () => {
    if (current.length) {
      units.push({ messages: current, tokens: roughTokens(current) });
      current = [];
    }
  };
  for (const message of messages) {
    current.push(message);
    // A unit closes on the user turn that ends a round: assistant messages
    // and their tool results travel as one atomic unit, so trimming can
    // never orphan a tool result (the gateway rejects those).
    if (message.role === "user") seal();
  }
  seal();
  return units;
}

export function trimToFit(messages: readonly OutgoingMessage[], tokenCap: number): readonly OutgoingMessage[] {
  const units = splitUnits(messages);
  const kept = units.map(() => true);
  const total = () => units.reduce((sum, unit, index) => (kept[index] ? sum + unit.tokens : sum), 0);
  // Drop from the oldest interior unit forward until we fit.
  for (let index = 1; index < units.length - 1 && total() > tokenCap; index += 1) {
    kept[index] = false;
  }
  if (total() > tokenCap && units.length > 2) kept[0] = false;
  return units.flatMap((unit, index) => (kept[index] ? unit.messages : []));
}
