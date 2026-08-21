# Prompt Cache Stability

## IDEAL

- Legacy Claude tool-loop requests preserve the exact serialized model-message prefix already sent to the provider and append only newly admitted history.
- Structural history changes, including compaction, subtask handling, source-message reorder/removal, and model changes, invalidate the snapshot.
- Anthropic and Bedrock native requests use four layered cache boundaries: tools, stable system, dynamic system, and rolling conversation tail.
- OpenAI-family requests use a stable per-conversation cache root. Forks inherit the source root while unrelated sessions remain isolated.
- Native OpenAI lowering carries the cache root through to the final `prompt_cache_key` payload.
- Tool and skill/system inputs that participate in cached prefixes are deterministic; volatile environment data follows the stable base system block.

## IMPLEMENTATION

1. Add an append-only serialized model-message snapshot to the legacy SessionPrompt loop.
   - Store cloned model messages, ordered source message IDs, and the provider/model key.
   - Reuse only when the prior source IDs remain an exact prefix and the model is unchanged.
   - Explicitly clear after subtask and compaction transitions.
2. Port the merged PR #38725 cache policy from `packages/ai` to the current `packages/llm` package.
   - Mark the last tool, first and distinct last system blocks, and one rolling tail message.
   - Count manual hints against the four-breakpoint cap and preserve idempotence.
3. Add a nullable internal `cache_root_id` session column with old-row fallback to `id`.
   - Default new sessions to their own ID in the shared projector.
   - Make legacy `/fork` inherit the source/root value, including fork-of-fork.
   - Feed the effective root to legacy ProviderTransform and the Core Session runner while retaining actual session IDs in tracing/affinity headers.
4. Preserve system/tool prefix stability.
   - Sort Core tool definitions by name at materialization.
   - Keep the legacy provider/agent base prompt separate from dynamic environment, project, skill, MCP, and per-user system context.
5. Keep the existing native runtime architecture and add coverage proving its provider options reach the OpenAI Responses wire body.
6. Regenerate the Core migration/schema outputs and the client generated API required by the rebased public HttpApi config change.

## VERIFICATION

- Run focused legacy snapshot, session fork, ProviderTransform, native request, Core runner/tool registry, and LLM cache-policy tests from their package directories.
- Run `bun typecheck` in `packages/llm`, `packages/core`, `packages/opencode`, `packages/tui`, and `packages/client` when generated client output changes.
- Run migration consistency checks and `git diff --check`.
- Build the OpenCode CLI, verify the built version, and replace the writable npm-global installation. If installation requires root, provide a standalone script instead.
- Do not commit or push.

## Checklist

- [x] Legacy model-message snapshot implemented and reset safely
- [x] Claude prefix/suffix regression tests pass
- [x] Layered Anthropic/Bedrock cache policy ported and tested
- [x] Stable persisted cache root implemented for sessions and forks
- [x] OpenAI and native payload cache-key regressions pass
- [x] Core tool order and legacy system layers stabilized
- [x] Generated migration/schema/client outputs refreshed
- [x] Relevant tests and package typechecks pass
- [x] CLI build installed and verified
- [x] Independent review completed and final diff reported
