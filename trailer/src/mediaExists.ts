import { getStaticFiles } from "remotion";

export function mediaExists(publicRel: string): boolean {
  return getStaticFiles().some((file) => file.name === publicRel);
}
