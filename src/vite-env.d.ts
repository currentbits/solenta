/// <reference types="vite/client" />

declare const __BUILD_SHA__: string | null;

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
