import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { Truncate } from "./truncate"
import { ContextualSummary } from "./contextual-summary"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_SUMMARY_LINKS = 300
const MAX_SUMMARY_LINK_URL_LENGTH = 2_048

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  intent: Schema.String.annotate({
    description: "A concise explanation of what you are trying to find, learn, or verify from this URL",
  }).pipe(Schema.check(Schema.makeFilter((value) => value.trim().length > 0))),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const truncate = yield* Truncate.Service

    const finish = Effect.fn("WebFetchTool.finish")(function* (input: {
      output: string
      originalContent?: string
      summaryContent: string
      links: string[]
      title: string
      params: Schema.Schema.Type<typeof Parameters>
      ctx: Tool.Context
    }) {
      if (!ContextualSummary.checkIsLargeResult(input.output)) {
        return { output: input.output, title: input.title, metadata: {} }
      }
      const summarize = input.ctx.extra?.summarizeToolOutput
      if (!summarize) return { output: input.output, title: input.title, metadata: {} }
      const summary = yield* summarize({
        intent: input.params.intent,
        content: input.summaryContent,
        source: input.params.url,
        kind: "webfetch",
        links: input.links,
      })
      if (!summary) return { output: input.output, title: input.title, metadata: {} }
      const originalContent = input.originalContent ?? input.output
      const outputPath = yield* truncate.write(originalContent)
      return {
        output: ContextualSummary.buildSummaryOutput({
          summary,
          intent: input.params.intent,
          originalPath: outputPath,
          originalContent,
        }),
        title: input.title,
        metadata: {
          summarized: true,
          summaryModel: summary.model,
          truncated: true,
          outputPath,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
          const response = yield* httpOk.execute(request).pipe(
            Effect.catchIf(
              (err) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpOk.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
                  ),
                ),
            ),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          const isHTML = contentType.includes("text/html")
          const links = isHTML ? extractLinksFromHTML(content, params.url) : []
          const normalizedMarkdown = isHTML ? convertHTMLToMarkdown(content) : content
          const summaryContent = isHTML ? convertHTMLToSummaryMarkdown(content) : content

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (isHTML) {
                return yield* finish({
                  output: normalizedMarkdown,
                  summaryContent,
                  links,
                  title,
                  params,
                  ctx,
                })
              }
              return yield* finish({ output: content, summaryContent: content, links, title, params, ctx })

            case "text":
              if (isHTML) {
                const text = extractTextFromHTML(content)
                return yield* finish({ output: text, summaryContent, links, title, params, ctx })
              }
              return yield* finish({ output: content, summaryContent: content, links, title, params, ctx })

            case "html":
              return yield* finish({
                output: content,
                originalContent: normalizedMarkdown,
                summaryContent,
                links,
                title,
                params,
                ctx,
              })

            default:
              return yield* finish({ output: content, summaryContent: content, links, title, params, ctx })
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

function convertHTMLToSummaryMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove([
    "script",
    "style",
    "meta",
    "link",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
    "button",
  ])
  return turndownService.turndown(html)
}

function extractLinksFromHTML(html: string, baseURL: string) {
  const links: string[] = []
  const seen = new Set<string>()
  let href: string | undefined
  let label = ""
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name !== "a" || href) return
      href = attributes.href
      label = ""
    },
    ontext(text) {
      if (href) label += text
    },
    onclosetag(name) {
      if (name !== "a" || !href) return
      try {
        const url = new URL(href, baseURL)
        if ((url.protocol === "http:" || url.protocol === "https:") && !seen.has(url.href)) {
          seen.add(url.href)
          const text = label.replace(/\s+/g, " ").trim().slice(0, 200)
          const normalizedURL = url.href.slice(0, MAX_SUMMARY_LINK_URL_LENGTH)
          links.push(text ? `- ${text}: ${normalizedURL}` : `- ${normalizedURL}`)
        }
      } catch {
        // Ignore malformed links; the fetched content remains available verbatim.
      }
      href = undefined
      label = ""
    },
  })
  parser.write(html)
  parser.end()
  return links.slice(0, MAX_SUMMARY_LINKS)
}
