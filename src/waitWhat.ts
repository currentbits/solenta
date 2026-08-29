/**
 * wait-what (issue #381): re-explain one agent message in plain English
 * using project vocabulary. One-click send, not a draft fill.
 */

export function waitWhatPrompt(quoted: string): string {
  return (
    "Re-explain the following message in plain English, using this project's vocabulary " +
    "(file names, types, commands, and terms already in the thread). " +
    "Do not start new work.\n\n" +
    `<message>\n${quoted}\n</message>`
  );
}
