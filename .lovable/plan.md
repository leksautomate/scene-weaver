

## Plan: Add Voice Selection & Script Split Mode to Project Form

Add two new controls to the `ProjectForm.tsx` "New Project" card so users can choose the narration voice and script splitting method before generating.

### Changes

**`src/components/ProjectForm.tsx`**:
1. Import `Select` components and `INWORLD_VOICES` from providers
2. Add state for `voiceId` (default "Dennis") and `splitMode` (default "smart" with options: "smart" = sentence-aware 2-4 sentence beats, "exact" = fixed word count)
3. Add a Voice Selection dropdown after the style reference images, showing all Inworld voices with name + description
4. Add a Script Split Mode dropdown (Smart / Exact word count)
5. Pass `voiceId` into `createProjectFrontend` so it's saved to project settings and used as the default voice
6. Pass `splitMode` so the scene generation prompt can be adjusted accordingly

**`src/lib/api.ts`**:
1. Update `createProjectFrontend` signature to accept `voiceId` and `splitMode`
2. Save `voiceId` into project settings when creating the project row
3. Pass `splitMode` to `generateSceneManifest` so the LLM prompt can vary

**`src/lib/providers.ts`**:
1. Update `generateSceneManifest` to accept an optional `splitMode` parameter
2. Adjust the system prompt: for "smart" mode keep current behavior (2-4 sentences per scene); for "exact" mode, instruct the LLM to split by paragraph boundaries instead

**`src/lib/types.ts`**:
1. Add `splitMode` to `ProjectSettings` interface

No database changes needed — settings are stored in the existing `settings` jsonb column.

