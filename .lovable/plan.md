

## Plan: Delete Project + Background Processing

### 1. Delete Project
Add the ability to delete a project, including all its scenes and storage assets.

**API layer (`src/lib/api.ts`)**:
- Add `deleteProject(projectId)` function that:
  1. Deletes all files in `project-assets/{projectId}/` from storage (images, audio, style folders)
  2. Deletes all rows from `scenes` table where `project_id = projectId`
  3. Deletes the project row from `projects` table

**Projects list (`src/pages/Projects.tsx`)**:
- Add a delete button (trash icon) on each project card
- Show a confirmation dialog (AlertDialog) before deleting
- Remove the project from local state after successful deletion

**Project status page (`src/pages/ProjectStatus.tsx`)**:
- Add a delete button in the header area
- Show confirmation dialog, then navigate to `/projects` after deletion

### 2. Background Processing (Stop/Resume)
Currently, `createProjectFrontend` runs a synchronous loop in the browser tab — if you navigate away, it stops. The request is to let projects continue processing unless explicitly stopped.

**Approach**: Add a `cancelled` flag that the pipeline checks between scenes, and persist processing state so the user can leave and come back.

**Database**: No schema change needed — use the existing `status` field. A project with status `"processing"` that still has `"pending"` scenes can be resumed.

**API layer (`src/lib/api.ts`)**:
- Add a `stopProject(projectId)` function that sets `status = "stopped"` on the project
- Add a `resumeProject(projectId, callbacks)` function that:
  1. Sets status back to `"processing"`
  2. Fetches all scenes with `pending` or `failed` image/audio status
  3. Runs the same asset generation loop as `createProjectFrontend` for those scenes
- In the generation loop (`createProjectFrontend` and `resumeProject`), check the project status from DB every N scenes — if `"stopped"`, break out early

**Project status page (`src/pages/ProjectStatus.tsx`)**:
- Add a "Stop" button (visible when status is `processing`) that calls `stopProject`
- Add a "Resume" button (visible when status is `stopped` or `partial` with pending scenes) that calls `resumeProject` and shows progress
- Track active generation state locally so the UI shows progress when running

### Files to modify:
- `src/lib/api.ts` — add `deleteProject`, `stopProject`, `resumeProject`
- `src/pages/Projects.tsx` — add delete button + confirmation dialog
- `src/pages/ProjectStatus.tsx` — add delete button, stop/resume buttons

