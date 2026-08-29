/** Re-open the agents rail after the #767 closed default (or a pane collapse). */
export async function expandAgents(m: {
  query: (selector: string) => Element | null;
  click: (el: Element) => Promise<void>;
  flush: () => Promise<void>;
}): Promise<void> {
  const expand = m.query("[data-agents-expand]");
  if (expand) {
    await m.click(expand);
    await m.flush();
  }
}
