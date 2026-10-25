// The arguments and results of A's two tools. `npm run generate:schema` writes their JSON
// Schema to tool-types.schema.json, which is each tool's inputSchema or outputSchema and
// what every call is checked against.
import type { Note } from './resource-types';

/**
 * Writes a note, creating it or replacing it. With `version`, it writes only if the note is
 * still at that version, as HTTP's If-Match does.
 * @additionalProperties false
 */
export interface WriteNoteArguments {
  /** The note's URI, such as `https://….workers.dev/server/A/notes/inbox/note-42`. */
  uri: string;
  note: Note;
  /** The version the note must be at, such as `e0.17`. */
  version?: string;
}

/**
 * Deletes a note. With `version`, it deletes only if the note is still at that version.
 * @additionalProperties false
 */
export interface DeleteNoteArguments {
  /** The note's URI. */
  uri: string;
  /** The version the note must be at. */
  version?: string;
}

/**
 * The version a write or a deletion made, such as `{ "uri": "https://…/note-42", "version": "e0.18" }`.
 * @additionalProperties false
 */
export interface NoteVersion {
  uri: string;
  version: string;
}
