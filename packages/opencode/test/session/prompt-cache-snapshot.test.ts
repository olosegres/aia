import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { appendOnlyModelMessages } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTransform } from "@/provider/transform"
import { it } from "../lib/effect"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "claude-test-model",
    url: "https://example.com",
    npm: "@ai-sdk/anthropic",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): SessionV1.User {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID, modelID: model.id },
  }
}

function textMessage(messageID: string, text: string): SessionV1.WithParts {
  return {
    info: userInfo(messageID),
    parts: [
      {
        id: PartID.make(`prt_${messageID}`),
        sessionID,
        messageID: MessageID.make(messageID),
        type: "text",
        text,
      },
    ],
  }
}

function completedToolMessage(messageID: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(messageID),
      sessionID,
      parentID: MessageID.make("msg_first"),
      role: "assistant",
      time: { created: 1, completed: 2 },
      agent: "build",
      mode: "build",
      modelID: model.id,
      providerID,
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    },
    parts: [
      {
        id: PartID.make(`prt_${messageID}`),
        sessionID,
        messageID: MessageID.make(messageID),
        type: "tool",
        tool: "lookup",
        callID: "call_lookup",
        state: {
          status: "completed",
          input: { query: "cache" },
          output: "stable result",
          title: "Lookup",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

function compactionMessage(): SessionV1.WithParts {
  const messageID = MessageID.make("msg_compaction")
  return {
    info: userInfo(messageID),
    parts: [
      {
        id: PartID.make("prt_compaction"),
        sessionID,
        messageID,
        type: "compaction",
        auto: true,
      },
    ],
  }
}

describe("session.prompt.appendOnlyModelMessages", () => {
  it.effect("keeps the serialized prefix exact when a completed tool call and result are appended", () =>
    Effect.gen(function* () {
      const firstMessage = textMessage("msg_first", "stable prefix")
      const first = yield* appendOnlyModelMessages({ snapshot: undefined, messages: [firstMessage], model })
      const prefix = JSON.stringify(first.modelMessages)

      const transformed = ProviderTransform.message(first.modelMessages, model, {})
      expect(JSON.stringify(transformed)).not.toBe(prefix)

      const text = firstMessage.parts[0]
      if (text?.type !== "text") throw new Error("Expected text part")
      text.text = "mutated source prefix"
      const second = yield* appendOnlyModelMessages({
        snapshot: first.snapshot,
        messages: [firstMessage, completedToolMessage("msg_tool")],
        model,
      })

      expect(JSON.stringify(second.modelMessages.slice(0, first.modelMessages.length))).toBe(prefix)
      expect(JSON.stringify(second.modelMessages.slice(first.modelMessages.length))).toBe(
        JSON.stringify([
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_lookup",
                toolName: "lookup",
                input: { query: "cache" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_lookup",
                toolName: "lookup",
                output: { type: "text", value: "stable result" },
              },
            ],
          },
        ]),
      )
    }),
  )

  it.effect("rebuilds after a model switch", () =>
    Effect.gen(function* () {
      const message = textMessage("msg_first", "before switch")
      const first = yield* appendOnlyModelMessages({ snapshot: undefined, messages: [message], model })
      const text = message.parts[0]
      if (text?.type !== "text") throw new Error("Expected text part")
      text.text = "after switch"

      const switched = yield* appendOnlyModelMessages({
        snapshot: first.snapshot,
        messages: [message],
        model: { ...model, id: ModelV2.ID.make("replacement-model") },
      })

      expect(JSON.stringify(switched.modelMessages)).toContain("after switch")
      expect(JSON.stringify(switched.modelMessages)).not.toContain("before switch")
    }),
  )

  it.effect("rebuilds when compaction-shaped history replaces the source prefix", () =>
    Effect.gen(function* () {
      const first = yield* appendOnlyModelMessages({
        snapshot: undefined,
        messages: [textMessage("msg_first", "removed prefix"), textMessage("msg_second", "removed suffix")],
        model,
      })
      const rewritten = yield* appendOnlyModelMessages({
        snapshot: first.snapshot,
        messages: [compactionMessage()],
        model,
      })

      expect(JSON.stringify(rewritten.modelMessages)).toBe(
        JSON.stringify([{ role: "user", content: [{ type: "text", text: "What did we do so far?" }] }]),
      )
      expect(rewritten.snapshot.sourceMessageIDs).toEqual([MessageID.make("msg_compaction")])
    }),
  )

  it.effect("rebuilds after ordered source IDs are reordered or removed", () =>
    Effect.gen(function* () {
      const firstMessage = textMessage("msg_first", "first original")
      const secondMessage = textMessage("msg_second", "second original")
      const first = yield* appendOnlyModelMessages({
        snapshot: undefined,
        messages: [firstMessage, secondMessage],
        model,
      })

      const firstText = firstMessage.parts[0]
      const secondText = secondMessage.parts[0]
      if (firstText?.type !== "text" || secondText?.type !== "text") throw new Error("Expected text parts")
      firstText.text = "first rebuilt"
      secondText.text = "second rebuilt"

      const reordered = yield* appendOnlyModelMessages({
        snapshot: first.snapshot,
        messages: [secondMessage, firstMessage],
        model,
      })
      expect(JSON.stringify(reordered.modelMessages)).toBe(
        JSON.stringify([
          { role: "user", content: [{ type: "text", text: "second rebuilt" }] },
          { role: "user", content: [{ type: "text", text: "first rebuilt" }] },
        ]),
      )

      const removed = yield* appendOnlyModelMessages({
        snapshot: first.snapshot,
        messages: [firstMessage],
        model,
      })
      expect(JSON.stringify(removed.modelMessages)).toBe(
        JSON.stringify([{ role: "user", content: [{ type: "text", text: "first rebuilt" }] }]),
      )
    }),
  )
})
