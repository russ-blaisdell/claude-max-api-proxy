/**
 * Unit tests for openai-to-cli adapter
 *
 * Tests sanitizeSessionId, extractModel, and messagesToPrompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openaiToCli, extractModel, messagesToPrompt } from "./openai-to-cli.js";
import type { OpenAIChatMessage, OpenAIContentBlock } from "../types/openai.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: { user?: string; model?: string } = {}) {
  return {
    model: overrides.model ?? "claude-sonnet-4",
    messages: [{ role: "user" as const, content: "hello" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

describe("extractModel", () => {
  it("maps direct claude model names", () => {
    assert.equal(extractModel("claude-opus-4"), "opus");
    assert.equal(extractModel("claude-sonnet-4"), "sonnet");
    assert.equal(extractModel("claude-haiku-4"), "haiku");
  });

  it("maps short aliases", () => {
    assert.equal(extractModel("opus"), "opus");
    assert.equal(extractModel("sonnet"), "sonnet");
    assert.equal(extractModel("haiku"), "haiku");
  });

  it("strips provider prefix", () => {
    assert.equal(extractModel("claude-code-cli/claude-opus-4"), "opus");
    assert.equal(extractModel("claude-code-cli/claude-sonnet-4"), "sonnet");
    assert.equal(extractModel("claude-code-cli/claude-haiku-4"), "haiku");
  });

  it("defaults unknown models to opus", () => {
    assert.equal(extractModel("gpt-4"), "opus");
    assert.equal(extractModel("unknown"), "opus");
    assert.equal(extractModel(""), "opus");
  });
});

// ---------------------------------------------------------------------------
// messagesToPrompt
// ---------------------------------------------------------------------------

describe("messagesToPrompt", () => {
  it("formats a single user message as plain text", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "user", content: "hello" }];
    assert.equal(messagesToPrompt(msgs), "hello");
  });

  it("wraps system messages in <system> tags", () => {
    const msgs: OpenAIChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hi" },
    ];
    const result = messagesToPrompt(msgs);
    assert.match(result, /<system>\nYou are helpful\n<\/system>/);
    assert.match(result, /hi/);
  });

  it("wraps assistant messages in <previous_response> tags", () => {
    const msgs: OpenAIChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ];
    const result = messagesToPrompt(msgs);
    assert.match(result, /<previous_response>\nhello there\n<\/previous_response>/);
  });

  it("trims leading and trailing whitespace", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "user", content: "  trimmed  " }];
    assert.equal(messagesToPrompt(msgs), "trimmed");
  });

  it("extracts text from array content blocks (webchat format)", () => {
    const content: OpenAIContentBlock[] = [{ type: "text", text: "hello from webchat" }];
    const msgs: OpenAIChatMessage[] = [{ role: "user", content }];
    assert.equal(messagesToPrompt(msgs), "hello from webchat");
  });

  it("joins multiple text blocks in an array content message", () => {
    const content: OpenAIContentBlock[] = [
      { type: "text", text: "part one" },
      { type: "text", text: " part two" },
    ];
    const msgs: OpenAIChatMessage[] = [{ role: "user", content }];
    assert.equal(messagesToPrompt(msgs), "part one part two");
  });

  it("ignores non-text blocks in array content (e.g. image blocks)", () => {
    const content: OpenAIContentBlock[] = [
      { type: "image_url", text: undefined },
      { type: "text", text: "caption" },
    ];
    const msgs: OpenAIChatMessage[] = [{ role: "user", content }];
    assert.equal(messagesToPrompt(msgs), "caption");
  });

  it("does not produce [object Object] for array content", () => {
    const content: OpenAIContentBlock[] = [{ type: "text", text: "real message" }];
    const msgs: OpenAIChatMessage[] = [{ role: "user", content }];
    const result = messagesToPrompt(msgs);
    assert.ok(!result.includes("[object Object]"), "must not contain [object Object]");
  });

  it("joins multiple messages in order", () => {
    const msgs: OpenAIChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];
    const result = messagesToPrompt(msgs);
    const firstIdx = result.indexOf("first");
    const secondIdx = result.indexOf("second");
    const thirdIdx = result.indexOf("third");
    assert.ok(firstIdx < secondIdx, "first should appear before second");
    assert.ok(secondIdx < thirdIdx, "second should appear before third");
  });
});

// ---------------------------------------------------------------------------
// sanitizeSessionId (tested via openaiToCli)
// ---------------------------------------------------------------------------

describe("sanitizeSessionId", () => {
  it("passes through a valid UUID", () => {
    const result = openaiToCli(makeRequest({ user: "550e8400-e29b-41d4-a716-446655440000" }));
    assert.equal(result.sessionId, "550e8400-e29b-41d4-a716-446655440000");
  });

  it("passes through plain alphanumeric identifiers", () => {
    const result = openaiToCli(makeRequest({ user: "user123abc" }));
    assert.equal(result.sessionId, "user123abc");
  });

  it("passes through identifiers with hyphens", () => {
    const result = openaiToCli(makeRequest({ user: "my-session-id" }));
    assert.equal(result.sessionId, "my-session-id");
  });

  it("strips identifiers containing path traversal characters", () => {
    const result = openaiToCli(makeRequest({ user: "../etc/passwd" }));
    assert.equal(result.sessionId, undefined);
  });

  it("strips identifiers containing shell metacharacters", () => {
    for (const bad of ["; rm -rf /", "$(whoami)", "`id`", "a|b", "a&b"]) {
      const result = openaiToCli(makeRequest({ user: bad }));
      assert.equal(result.sessionId, undefined, `expected undefined for: ${bad}`);
    }
  });

  it("strips identifiers that exceed 64 characters", () => {
    const result = openaiToCli(makeRequest({ user: "a".repeat(65) }));
    assert.equal(result.sessionId, undefined);
  });

  it("accepts identifiers of exactly 64 characters", () => {
    const id = "a".repeat(64);
    const result = openaiToCli(makeRequest({ user: id }));
    assert.equal(result.sessionId, id);
  });

  it("returns undefined when user field is absent", () => {
    const result = openaiToCli(makeRequest());
    assert.equal(result.sessionId, undefined);
  });
});
