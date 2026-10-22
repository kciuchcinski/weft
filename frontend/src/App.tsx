import TopBar from "./components/TopBar";
import LeftPanel from "./components/LeftPanel";
import CanvasView from "./components/CanvasView";
import StatusBar from "./components/StatusBar";
import { useStore } from "./state/store";

export default function App() {
  const panelCollapsed = useStore((s) => s.panelCollapsed);
  return (
    <div className="app" data-panel={panelCollapsed ? "collapsed" : "open"}>
      <TopBar />
      <div className="main">
        {/* Sidebar: the scrolling control panel with the status bar pinned beneath it. */}
        {!panelCollapsed && (
          <div className="sidebar">
            <LeftPanel />
            <StatusBar />
          </div>
        )}
        <CanvasView />
      </div>
    </div>
  );
}
