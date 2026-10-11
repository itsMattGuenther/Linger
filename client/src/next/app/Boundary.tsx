import { Component, type ReactNode } from "react";
import { Button } from "../kit";
import { WindowMessage } from "./WindowMessage";
import "./Boundary.css";

interface BoundaryProps {
  /** What to draw in place of what broke, given a way to draw it again. */
  fallback: (retry: () => void) => ReactNode;
  /** A change here (another conversation showing) draws what's inside again. */
  resetKey?: unknown;
  children: ReactNode;
}

/**
 * Catches an exception thrown while drawing what's inside it, so the part
 * that can't be drawn says so and the rest of the window carries on (#509).
 * Without one, React takes down the whole page, and in the list window
 * that's every server's connection, voice, and the conversations beside it.
 *
 * A class, the one exception to function components: React catches drawing
 * errors only through a class's `getDerivedStateFromError`, and has no hook
 * for it.
 *
 * What broke goes to this computer's console, where React writes every
 * error a boundary catches, and nowhere else: no crash reporting
 * (AGENTS.md, hard rule 4).
 */
class Boundary extends Component<BoundaryProps, { broken: boolean }> {
  override state = { broken: false };

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true };
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.broken && !Object.is(previous.resetKey, this.props.resetKey)) this.setState({ broken: false });
  }

  private readonly retry = (): void => this.setState({ broken: false });

  override render(): ReactNode {
    return this.state.broken ? this.props.fallback(this.retry) : this.props.children;
  }
}

/**
 * One pane that can't be drawn: a conversation, Media, Search or a section
 * of Settings. It says so in its place, calmly, with Try again, and the
 * window around it (the list, the tabs, the title bar) goes on working.
 */
export function PaneBoundary({ what, resetKey, children }: { what: string; resetKey?: unknown; children: ReactNode }) {
  return (
    <Boundary
      resetKey={resetKey}
      fallback={(retry) => (
        <div className="nx-unshown" role="status">
          <span>{what}</span>
          <span className="nx-unshown-hint">Something in it couldn't be drawn. The rest of Linger is fine.</span>
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

/**
 * A whole window that can't be drawn, the last place to catch it: the title
 * bar, so it can still be moved and closed, a line saying so, and Reload,
 * which starts the window over.
 */
export function WindowBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      fallback={() => (
        <WindowMessage>
          <span>This window couldn't be shown.</span>
          <span className="nx-window-hint">Something in it couldn't be drawn. Reloading usually brings it back.</span>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </WindowMessage>
      )}
    >
      {children}
    </Boundary>
  );
}
