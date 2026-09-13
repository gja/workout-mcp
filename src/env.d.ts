// Vite serves `?raw` imports as strings; the Workers types do not know the suffix.

declare module '*.md?raw' {
  const content: string;
  export default content;
}
