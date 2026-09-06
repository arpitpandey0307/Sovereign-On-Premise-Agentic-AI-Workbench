/// <reference types="vite/client" />

// Side-effect CSS imports need a declaration under this TypeScript config.
declare module "*.css";

// Raw text imports, used by the token test to read the stylesheet itself.
declare module "*.css?raw" {
  const content: string;
  export default content;
}
