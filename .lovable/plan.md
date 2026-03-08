

## Plan: Add Text Splitter Utility Page

Create a new `/text-splitter` page that lets users paste large text (up to 5k+ words), split it into 10-11 equal parts, view each part on a new line, and download the result as a `.txt` file.

### Changes

**1. Create `src/pages/TextSplitter.tsx`**
- Textarea input for pasting text
- Number input for "number of parts" (default 10, range 2-20)
- "Split" button that divides text into N roughly equal parts (splitting at word boundaries to avoid cutting words)
- Display each part in a numbered block with visual separation
- "Download as .txt" button that generates a file with parts separated by blank lines and part headers
- Show word count of input and per-part word counts

**2. Update `src/App.tsx`**
- Add route: `/text-splitter` → `<TextSplitter />`

**3. Update `src/components/AppSidebar.tsx`**
- Add "Text Splitter" nav item with a `Scissors` icon

### Splitting Logic
- Split input into words array
- Calculate `wordsPerPart = Math.ceil(totalWords / numParts)`
- Slice into N chunks at word boundaries
- Join each chunk back into text

