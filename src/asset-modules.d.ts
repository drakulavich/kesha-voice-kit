// Bun's `with { type: "text" }` imports; tsc has no loader for these extensions.
declare module "*.bash" {
  const content: string;
  export default content;
}

declare module "*.zsh" {
  const content: string;
  export default content;
}

declare module "*.fish" {
  const content: string;
  export default content;
}

declare module "*.1" {
  const content: string;
  export default content;
}
