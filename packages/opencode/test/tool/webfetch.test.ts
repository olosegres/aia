import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import type { ContextualSummary } from "@/tool/contextual-summary"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

type WebFetchArgs = Omit<Tool.InferParameters<typeof WebFetchTool>, "intent"> & { intent?: string }

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: WebFetchArgs, next: Tool.Context = ctx) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute({ ...args, intent: args.intent ?? "test webfetch intent" }, next)
})

describe("tool.webfetch", () => {
  it.instance("rejects a blank intent", () =>
    withFetch(
      () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: url.toString(), intent: "   ", format: "text" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return
          expect(Cause.pretty(exit.cause)).toContain("intent")
        }),
    ),
  )

  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("summarizes large HTML without page chrome and preserves the full normalized original", () =>
    withFetch(
      () =>
        new Response(
          `<html><body><nav>Navigation noise <a href="/deeper">Deeper docs</a></nav><main>${"Relevant pricing evidence. ".repeat(1_200)}</main><footer>Cookie noise</footer></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      (url) =>
        Effect.gen(function* () {
          const requests: ContextualSummary.Request[] = []
          const result = yield* exec(
            {
              url: new URL("/pricing", url).toString(),
              intent: "Find the relevant pricing evidence",
              format: "html",
            },
            {
              ...ctx,
              extra: {
                summarizeToolOutput(request) {
                  requests.push(request)
                  return Effect.succeed({ text: "Relevant pricing evidence was found.", model: "test/small" })
                },
              },
            },
          )

          expect(requests).toHaveLength(1)
          expect(requests[0]?.content).toContain("Relevant pricing evidence")
          expect(requests[0]?.content).not.toContain("Navigation noise")
          expect(requests[0]?.content).not.toContain("Cookie noise")
          expect(requests[0]?.links).toContain(`- Deeper docs: ${new URL("/deeper", url).toString()}`)
          expect(result.output).toContain("Relevant pricing evidence was found.")
          expect(result.output).toContain("[CONTEXTUAL SUMMARY OF LARGE RESULT]")
          expect(result.output).toContain('"force_original": true')
          expect("summaryModel" in result.metadata ? result.metadata.summaryModel : undefined).toBe("test/small")
          if (!("outputPath" in result.metadata) || typeof result.metadata.outputPath !== "string") {
            throw new Error("expected persisted original path")
          }
          const originalPath = result.metadata.outputPath
          const original = yield* Effect.promise(() => Bun.file(originalPath).text())
          expect(original).toContain("Navigation noise")
          expect(original).toContain("Cookie noise")
          expect(original).not.toContain("<html")
          expect(original).not.toContain("<nav")
        }),
    ),
  )
})
