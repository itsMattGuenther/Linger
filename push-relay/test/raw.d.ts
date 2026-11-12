// What Vite, under vitest, gives a test that reads files as text.
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}
declare module "*?raw" {
  const text: string;
  export default text;
}
