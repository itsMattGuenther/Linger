/**
 * A file Vite builds on its own and hands over by address (`?worker&url`),
 * as an audio worklet is loaded (`app/chat/micWorklet.ts`, #687).
 */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
