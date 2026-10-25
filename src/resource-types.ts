// The two types A holds. `npm run generate:schema` writes their JSON Schema to
// resource-types.schema.json with the spec's own generator and flags, and every write is
// checked against it, so these interfaces are the only definition of each type.

/**
 * A note, such as `{ "title": "Buy milk", "due": "2026-10-24" }`.
 * @additionalProperties false
 */
export interface Note {
  title: string;
  done?: boolean;
  due?: string;
}

/**
 * A list, such as `{ "title": "Groceries", "items": ["oat milk"] }`.
 * @additionalProperties false
 */
export interface List {
  title: string;
  items: string[];
}
