/**
 * Talking-notes overlay: the glass card pinned under the webcam that shows the
 * notes typed on the launcher, so the presenter reads instead of memorising.
 * The window is excluded from capture (main process) - the client never sees
 * it. Draggable by its header if it covers something; scrollable when the
 * notes run long.
 */
import './styles/notes.css';

const root = document.getElementById('notes-root')!;
root.innerHTML = `
  <div class="notes-card">
    <div class="notes-head">
      <span class="notes-title">Your notes</span>
      <span class="notes-hint">only you see this</span>
    </div>
    <div class="notes-body" id="notes-body"></div>
  </div>
`;

const body = document.getElementById('notes-body')!;

window.openloomInternal.onNotesText((text) => {
  // textContent, never innerHTML: the notes are the user's free text.
  body.textContent = text;
});
