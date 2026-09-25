import { ListWindow } from "./list/ListWindow";

/**
 * Which window this page is. The list is the only one so far; the chat and
 * settings windows join it in later steps (TASKS.md, M15).
 */
export function App() {
  return <ListWindow />;
}
