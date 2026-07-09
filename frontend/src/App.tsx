import TopBar from "./components/TopBar";
import LeftPanel from "./components/LeftPanel";
import CanvasView from "./components/CanvasView";
import { useStore } from "./state/store";

export default function App() {
  const panelCollapsed = useStore((s) => s.panelCollapsed);
  return (
    <div className="app" data-panel={panelCollapsed ? "collapsed" : "open"}>
      <TopBar />
      <div className="main">
        {!panelCollapsed && <LeftPanel />}
        <CanvasView />
      </div>
    </div>
  );
}
