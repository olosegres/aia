import path from "path"
import { Effect } from "effect"

export const LARGE_RESULT_BYTES = 20 * 1024
export const MAX_SUMMARY_INPUT_BYTES = 512 * 1024
export const MAX_SUMMARY_OUTPUT_TOKENS = 2_048
export const ORIGINAL_READ_LINES = 200

const PROSE_EXTENSIONS = new Set([".adoc", ".markdown", ".md", ".mdx", ".rst", ".text", ".txt"])

export interface Request {
  intent: string
  content: string
  source: string
  kind: "read" | "webfetch"
  links?: string[]
}

export interface Result {
  text: string
  model: string
}

export type Handler = (request: Request) => Effect.Effect<Result | undefined>

export function checkIsLargeResult(content: string) {
  return checkIsLargeResultBytes(Buffer.byteLength(content, "utf-8"))
}

export function checkIsLargeResultBytes(bytes: number) {
  return bytes > LARGE_RESULT_BYTES
}

export function checkIsProseFile(filePath: string) {
  return PROSE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function getLineCount(content: string) {
  if (content.length === 0) return 0
  let count = 1
  for (const character of content) if (character === "\n") count++
  return count
}

export function buildSummaryOutput(input: {
  summary: Result
  intent: string
  originalPath: string
  originalContent: string
}) {
  const size = Buffer.byteLength(input.originalContent, "utf-8")
  const lines = getLineCount(input.originalContent)
  const readArgs = JSON.stringify(
    {
      filePath: input.originalPath,
      intent: `Verify exact details from the original for: ${input.intent}`,
      force_original: true,
      offset: 1,
      limit: ORIGINAL_READ_LINES,
    },
    null,
    2,
  )
  return [
    input.summary.text.trim(),
    "---",
    "[CONTEXTUAL SUMMARY OF LARGE RESULT]",
    `This is an AI-generated summary tailored to the request: ${JSON.stringify(input.intent)}.`,
    `The original result was large (${size.toLocaleString("en-US")} bytes, ${lines.toLocaleString("en-US")} lines).`,
    `Summary model: ${input.summary.model}.`,
    `The exact original tool content is preserved at: ${input.originalPath}`,
    "Critical wording, values, and code should be verified against the original.",
    "Use Grep on the saved path to locate exact terms. To read the exact original content, call:",
    `read(${readArgs})`,
  ].join("\n\n")
}

export function buildLargeFileGuidance(input: {
  filePath: string
  intent: string
  bytes: number
  lines?: number
}) {
  const readArgs = JSON.stringify(
    {
      filePath: input.filePath,
      intent: input.intent,
      force_original: true,
      offset: 1,
      limit: ORIGINAL_READ_LINES,
    },
    null,
    2,
  )
  return [
    `[Large file: ${input.bytes.toLocaleString("en-US")} bytes${input.lines === undefined ? "" : `, ${input.lines.toLocaleString("en-US")} lines`}]`,
    "The file was not injected in full because exact source content should not be replaced by an AI summary.",
    `Use Grep on ${input.filePath} for terms related to ${JSON.stringify(input.intent)}.`,
    "Then read the relevant exact range. To start from the beginning, call:",
    `read(${readArgs})`,
  ].join("\n\n")
}

export * as ContextualSummary from "./contextual-summary"
