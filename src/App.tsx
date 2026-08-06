import { mockData } from "./mockData";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { AgentsPanel } from "./components/AgentsPanel";
import styles from "./App.module.css";

export default function App() {
  return (
    <div className={styles.app}>
      <Sidebar
        appName={mockData.appName}
        searchPlaceholder={mockData.searchPlaceholder}
        projectsHeader={mockData.projectsHeader}
        threads={mockData.threads}
        activeThreadId={mockData.activeThreadId}
      />
      <ThreadView data={mockData.threadView} />
      <AgentsPanel data={mockData.agents} />
    </div>
  );
}
