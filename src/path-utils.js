import path from "node:path";

export const toAbsolutePath = (value) =>
  path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
